"""
KirinDNS — did:dns three-record identity model tests (C-1 baseline).

Covers spec_v1.md §3.2.1 + did-dns-protocol.md §2:
  - declaration / public-key / blacklist classification by prefix
  - fingerprint chain: fp == Base64URL(SHA-256(pk)[0:12])
  - ed25519 kty enforcement (other types rejected by is_valid)
  - iat freshness window (±5min) and exp expiry
  - blacklist revocation
  - fail-closed: missing pk / missing decl / non-did:dns TXT -> None

These vectors are the canonical cross-language conformance cases (mirrored in
JS/C#/Java/Kotlin/Go/Rust/C/C++). Run: pytest tests/test_did_dns.py -v
"""

import base64
import hashlib
import time

import pytest

from kirin_dns import (
    DidDnsIdentity,
    parse_did_dns_identity,
    _pad_b64url,
)


# ---------------------------------------------------------------------------
# Fixtures: real Ed25519-sized public key + matching fingerprint
# ---------------------------------------------------------------------------

@pytest.fixture
def ed25519_pk():
    """32-byte public key (here just bytes 0..31 for determinism)."""
    return bytes(range(32))


@pytest.fixture
def pk_b64(ed25519_pk):
    return base64.urlsafe_b64encode(ed25519_pk).decode("ascii").rstrip("=")


@pytest.fixture
def fp(ed25519_pk):
    return base64.urlsafe_b64encode(
        hashlib.sha256(ed25519_pk).digest()[:12]
    ).decode("ascii")


@pytest.fixture
def now():
    return 1_700_000_000


def _records(fp, pk_b64, now, **overrides):
    """Build the canonical 3-record set; kwargs override individual fields."""
    decl_extra = ""
    if "n" in overrides:
        decl_extra += f";n={overrides['n']}"
    if "g" in overrides:
        decl_extra += f";g={overrides['g']}"
    if "iat" in overrides:
        iat = overrides["iat"]
    else:
        iat = now
    if "exp" in overrides:
        exp = overrides["exp"]
    else:
        exp = now + 3600
    recs = [
        "v=spf1 include:_spf.kirinnet.org -all",  # noise, ignored
        f"did:dns:v=1;fp={fp}{decl_extra};iat={iat};exp={exp}",
        f"did:dns:pk;kty=ed25519;pk={pk_b64}",
    ]
    if overrides.get("black"):
        recs.append(f"did:dns:black;fp={overrides['black']}")
    if overrides.get("extra_noise"):
        recs.append(overrides["extra_noise"])
    return recs


# ---------------------------------------------------------------------------
# Classification + parsing
# ---------------------------------------------------------------------------

class TestDidDnsParsing:
    def test_full_three_record_set(self, fp, pk_b64, now):
        idn = parse_did_dns_identity(_records(fp, pk_b64, now))
        assert idn is not None
        assert idn.version == 1
        assert idn.fingerprint == fp
        assert idn.key_type == "ed25519"
        assert idn.public_key_b64url == pk_b64
        assert idn.issued_at == now
        assert idn.expires_at == now + 3600

    def test_records_in_any_order(self, fp, pk_b64, now):
        recs = list(reversed(_records(fp, pk_b64, now)))
        idn = parse_did_dns_identity(recs)
        assert idn is not None and idn.fingerprint == fp

    def test_spf_dkim_ignored(self, fp, pk_b64, now):
        recs = _records(fp, pk_b64, now,
                        extra_noise="v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3")
        idn = parse_did_dns_identity(recs)
        assert idn is not None and idn.fingerprint_chain_ok()

    def test_missing_declaration_returns_none(self, pk_b64, now):
        assert parse_did_dns_identity([f"did:dns:pk;kty=ed25519;pk={pk_b64}"]) is None

    def test_missing_pk_returns_none(self, fp, now):
        assert parse_did_dns_identity([f"did:dns:v=1;fp={fp};iat={now};exp={now+1}"]) is None

    def test_no_did_dns_returns_none(self):
        # Legacy id=;key= TXT must NOT be misclassified as did:dns
        assert parse_did_dns_identity(["id=foo;key=bar;nick=Alice"]) is None
        assert parse_did_dns_identity(["v=spf1 -all", "random txt"]) is None

    def test_accepts_single_string(self, fp, pk_b64, now):
        # Single record (declaration only) — must still return None (no pk)
        assert parse_did_dns_identity(f"did:dns:v=1;fp={fp};iat={now};exp={now+1}") is None

    def test_accepts_bytes(self, fp, pk_b64, now):
        recs = [r.encode() for r in _records(fp, pk_b64, now)]
        idn = parse_did_dns_identity(recs)
        assert idn is not None

    def test_none_input(self):
        assert parse_did_dns_identity(None) is None

    def test_blacklist_parsed(self, fp, pk_b64, now):
        idn = parse_did_dns_identity(_records(fp, pk_b64, now, black="OldAaaa,OldBbbb"))
        assert idn.blacklist == ["OldAaaa", "OldBbbb"]


# ---------------------------------------------------------------------------
# Fingerprint chain (tamper-evident binding)
# ---------------------------------------------------------------------------

class TestFingerprintChain:
    def test_chain_holds_for_real_pk(self, fp, pk_b64, now):
        idn = parse_did_dns_identity(_records(fp, pk_b64, now))
        assert idn.fingerprint_chain_ok()

    def test_chain_breaks_on_tampered_pk(self, fp, pk_b64, now):
        # Different pk bytes -> different SHA-256 -> mismatch
        wrong_pk = base64.urlsafe_b64encode(bytes([255] * 32)).decode().rstrip("=")
        recs = _records(fp, pk_b64, now)
        recs[2] = f"did:dns:pk;kty=ed25519;pk={wrong_pk}"
        idn = parse_did_dns_identity(recs)
        assert idn is not None
        assert not idn.fingerprint_chain_ok()

    def test_compute_fingerprint_matches_spec(self, ed25519_pk):
        # Spec: fp = Base64URL(SHA-256(pk)[0:12]) -> 16 chars
        idn = DidDnsIdentity(public_key_b64url=base64.urlsafe_b64encode(ed25519_pk).decode().rstrip("="))
        computed = idn.compute_fingerprint()
        assert len(computed) == 16
        expected = base64.urlsafe_b64encode(hashlib.sha256(ed25519_pk).digest()[:12]).decode()
        assert computed == expected

    def test_pad_b64url_helper(self):
        assert _pad_b64url("YWJj") == "YWJj"        # 4 chars -> 0 pad
        assert _pad_b64url("YWJ") == "YWJ="         # 3 mod 4 -> 1 pad
        assert _pad_b64url("YW") == "YW=="          # 2 mod 4 -> 2 pad
        assert _pad_b64url("QWxpY2U") == "QWxpY2U="  # "Alice" 7 chars -> 1 pad


# ---------------------------------------------------------------------------
# is_valid policy: kty / revocation / expiry / freshness
# ---------------------------------------------------------------------------

class TestIsValidPolicy:
    def test_fresh_ed25519_is_valid(self, fp, pk_b64, now):
        idn = parse_did_dns_identity(_records(fp, pk_b64, now))
        assert idn.is_valid(now=now)

    def test_rsa_kty_rejected(self, fp, pk_b64, now):
        recs = _records(fp, pk_b64, now)
        recs[2] = f"did:dns:pk;kty=rsa;pk={pk_b64}"
        idn = parse_did_dns_identity(recs)
        assert idn.key_type == "rsa"
        assert not idn.is_valid(now=now)

    def test_revoked_fingerprint_rejected(self, fp, pk_b64, now):
        idn = parse_did_dns_identity(_records(fp, pk_b64, now, black=fp))
        assert idn.is_revoked()
        assert not idn.is_valid(now=now)

    def test_expired_rejected(self, fp, pk_b64, now):
        idn = parse_did_dns_identity(_records(fp, pk_b64, now, exp=now - 1))
        assert idn.is_expired(now=now)
        assert not idn.is_valid(now=now)

    def test_stale_iat_flagged(self, fp, pk_b64, now):
        idn = parse_did_dns_identity(_records(fp, pk_b64, now, iat=now - 600))
        assert idn.is_stale(now=now)

    def test_broken_chain_rejected(self, fp, pk_b64, now):
        wrong_pk = base64.urlsafe_b64encode(bytes([255] * 32)).decode().rstrip("=")
        recs = _records(fp, pk_b64, now)
        recs[2] = f"did:dns:pk;kty=ed25519;pk={wrong_pk}"
        idn = parse_did_dns_identity(recs)
        assert not idn.is_valid(now=now)


# ---------------------------------------------------------------------------
# Nickname decoding (Base64URL UTF-8)
# ---------------------------------------------------------------------------

class TestNicknameDecode:
    def test_decoded_alice(self, fp, pk_b64, now):
        # Base64URL("Alice") = QWxpY2U
        idn = parse_did_dns_identity(_records(fp, pk_b64, now, n="QWxpY2U"))
        assert idn.nickname_decoded() == "Alice"

    def test_no_nickname(self, fp, pk_b64, now):
        idn = parse_did_dns_identity(_records(fp, pk_b64, now))
        assert idn.nickname_decoded() is None

    def test_unicode_nickname(self, fp, pk_b64, now):
        # Base64URL("麒麟") 
        import base64 as b64
        enc = b64.urlsafe_b64encode("麒麟".encode("utf-8")).decode().rstrip("=")
        idn = parse_did_dns_identity(_records(fp, pk_b64, now, n=enc))
        assert idn.nickname_decoded() == "麒麟"
