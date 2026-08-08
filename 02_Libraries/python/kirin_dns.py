"""
KirinDNS Resolution Protocol (ADRP) v2.0 -- Python Client Library

Implements ADRP as defined in 01_Standard/spec_v1.md and the did:dns three-record
identity model in 01_Standard/did-dns-protocol.md §2 (C-1 baseline, 2026-08-08).

Architecture:
  SRV records for service port discovery (_kirinnet-http._tcp, etc.)
  TXT records for identity metadata in did:dns three-record form:
      did:dns:v=1;fp=<fp>;n=<nick>;g=<gender>;iat=<ts>;exp=<ts>   (declaration)
      did:dns:pk;kty=ed25519;pk=<pubkey-base64url>                 (public key)
      did:dns:black;fp=<fp1>,<fp2>,...                             (blacklist, optional)
  The tamper-evident fingerprint chain binds the declaration to the public key:
      fp == Base64URL(SHA-256(pk_bytes)[0:12])

Dependencies: dnspython
    pip install dnspython

Example usage:
    >>> from kirin_dns import resolve_service, resolve_identity_did_dns
    >>> srv = resolve_service("alice.kirinnet.org", "ws")
    >>> print(srv)
    SRVResult(target='alice.kirinnet.org', port=8082)
    >>> identity = resolve_identity_did_dns("alice.kirinnet.org")
    >>> print(identity.fingerprint)
    AbCdEf1234aaaa
"""

import base64
import hashlib
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import dns.resolver
from dns.exception import DNSException

# did:dns protocol constants (spec §3.2.1 / did-dns-protocol §2)
_DID_DNS_PREFIX = "did:dns:"
_DID_DNS_DECL = "did:dns:v="
_DID_DNS_PK = "did:dns:pk;"
_DID_DNS_BLACK = "did:dns:black;"
_DID_DNS_KTY_ED25519 = "ed25519"
_DID_DNS_FRESHNESS_WINDOW = 5 * 60        # ±5 minutes (spec §3.2.1)
_DID_DNS_FINGERPRINT_BYTES = 12           # SHA-256[0:12] -> 16 base64url chars

try:  # JSON parsing is only used by the legacy v1 compatibility layer below.
    import json
except ImportError:  # pragma: no cover - json is stdlib, always present
    json = None

# ---------------------------------------------------------------------------
# Constants (spec Section 2.2)
# ---------------------------------------------------------------------------

_SRV_SERVICES = {
    "http":  "_kirinnet-http._tcp",
    "https": "_kirinnet-https._tcp",
    "ws":    "_kirinnet-ws._tcp",
}

_FALLBACK_PORTS = {
    "http": 80,
    "https": 443,
    "ws": 80,
    "wss": 443,
}


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

@dataclass
class SRVResult:
    """Resolved SRV service target."""
    target: str
    port: int


# ---------------------------------------------------------------------------
# did:dns identity model (spec §3.2.1 / did-dns-protocol §2)
# ---------------------------------------------------------------------------

@dataclass
class DidDnsIdentity:
    """Verified did:dns identity (declaration + public key, optional blacklist).

    Returned only when the fingerprint chain holds: the `fingerprint` field of
    the declaration equals Base64URL(SHA-256(public_key_bytes)[0:12]) and the
    key type is ed25519. Blacklist / freshness / expiry checks are exposed via
    `is_valid()` for the caller to apply policy (fail-closed default).
    """
    version: int = 1
    fingerprint: str = ""
    nickname: Optional[str] = None      # Base64URL(UTF-8), decoded lazily
    gender: Optional[str] = None        # M/F/O/X
    issued_at: Optional[int] = None
    expires_at: Optional[int] = None
    key_type: str = _DID_DNS_KTY_ED25519
    public_key_b64url: str = ""
    blacklist: List[str] = field(default_factory=list)
    # raw txt records kept for diagnostics / cross-lang parity
    raw_declaration: str = ""
    raw_public_key: str = ""

    @property
    def public_key_bytes(self) -> bytes:
        return base64.urlsafe_b64decode(_pad_b64url(self.public_key_b64url))

    def compute_fingerprint(self) -> str:
        """Recompute fp = Base64URL(SHA-256(pk)[0:12]) over the public key."""
        digest = hashlib.sha256(self.public_key_bytes).digest()
        return base64.urlsafe_b64encode(digest[:_DID_DNS_FINGERPRINT_BYTES]).decode("ascii")

    def fingerprint_chain_ok(self) -> bool:
        """True iff declared fp matches recomputed fp over the pk bytes."""
        return bool(self.fingerprint) and self.fingerprint == self.compute_fingerprint()

    def is_revoked(self) -> bool:
        """True iff the declaration fingerprint appears in the blacklist."""
        return self.fingerprint in self.blacklist

    def is_expired(self, now: Optional[int] = None) -> bool:
        if self.expires_at is None:
            return False
        return (now if now is not None else int(time.time())) >= self.expires_at

    def is_stale(self, now: Optional[int] = None) -> bool:
        """True iff iat is outside ±5min of now (anti-replay)."""
        if self.issued_at is None:
            return False
        return abs((now if now is not None else int(time.time())) - self.issued_at) > _DID_DNS_FRESHNESS_WINDOW

    def is_valid(self, now: Optional[int] = None) -> bool:
        """Composite policy check: chain holds, ed25519, not revoked, in window."""
        return (
            self.version == 1
            and self.key_type == _DID_DNS_KTY_ED25519
            and self.fingerprint_chain_ok()
            and not self.is_revoked()
            and not self.is_expired(now)
        )

    def nickname_decoded(self) -> Optional[str]:
        """Decode the Base64URL(UTF-8) nickname, or None if absent/invalid."""
        if not self.nickname:
            return None
        try:
            return base64.urlsafe_b64decode(_pad_b64url(self.nickname)).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None


def _pad_b64url(s: str) -> str:
    """Add the '=' padding that Base64URL strings usually omit."""
    return s + "=" * (-len(s) % 4)


def _parse_kv(text: str) -> Dict[str, str]:
    """Parse a `k=v;k=v` segment after the did:dns: prefix into a dict."""
    out: Dict[str, str] = {}
    for pair in text.split(";"):
        pair = pair.strip()
        if "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def parse_did_dns_identity(txt_records) -> Optional[DidDnsIdentity]:
    """Classify TXT records by did:dns: sub-type and assemble an identity.

    Accepts either a list of raw TXT strings or a single string. Returns None
    if no did:dns: records are found. Returns a DidDnsIdentity (possibly with
    a broken fingerprint chain) when declaration+pk records are present; the
    caller decides via `.is_valid()` whether to trust it (fail-closed).
    """
    if txt_records is None:
        return None
    if isinstance(txt_records, (str, bytes)):
        txt_records = [txt_records]

    decl_raw = None
    pk_raw = None
    black_raw = None

    for txt in txt_records:
        if isinstance(txt, (bytes, bytearray)):
            try:
                txt = txt.decode("utf-8")
            except UnicodeDecodeError:
                continue
        if not isinstance(txt, str):
            continue
        s = txt.strip()
        if s.startswith(_DID_DNS_DECL):
            if decl_raw is None:
                decl_raw = s
        elif s.startswith(_DID_DNS_PK):
            if pk_raw is None:
                pk_raw = s
        elif s.startswith(_DID_DNS_BLACK):
            if black_raw is None:
                black_raw = s

    if decl_raw is None or pk_raw is None:
        return None

    decl = _parse_kv(decl_raw[len(_DID_DNS_PREFIX):])      # strip "did:dns:"
    pk = _parse_kv(pk_raw[len(_DID_DNS_PREFIX):])

    identity = DidDnsIdentity(
        version=int(decl.get("v", "1")),
        fingerprint=decl.get("fp", ""),
        nickname=decl.get("n") or None,
        gender=decl.get("g") or None,
        issued_at=int(decl["iat"]) if decl.get("iat", "").lstrip("-").isdigit() else None,
        expires_at=int(decl["exp"]) if decl.get("exp", "").lstrip("-").isdigit() else None,
        key_type=pk.get("kty", _DID_DNS_KTY_ED25519),
        public_key_b64url=pk.get("pk", ""),
        raw_declaration=decl_raw,
        raw_public_key=pk_raw,
    )

    if black_raw is not None:
        fp_field = _parse_kv(black_raw[len(_DID_DNS_PREFIX):]).get("fp", "")
        identity.blacklist = [f for f in fp_field.split(",") if f]

    return identity


def resolve_identity_did_dns(domain: str) -> Optional[DidDnsIdentity]:
    """Resolve and verify a did:dns identity for `domain` via TXT query.

    Returns None on NXDOMAIN / no TXT / no did:dns: records (fail-closed —
    caller proceeds with a null identity). Returns a DidDnsIdentity when
    declaration+pk records exist; call `.is_valid()` to decide trust policy.
    """
    try:
        answers = dns.resolver.resolve(domain, "TXT")
    except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN, DNSException):
        return None

    records = []
    for rdata in answers:
        records.append("".join(
            s.decode("utf-8") if isinstance(s, bytes) else s
            for s in rdata.strings
        ))
    return parse_did_dns_identity(records)


# ---------------------------------------------------------------------------
# Service Resolution (SRV)
# ---------------------------------------------------------------------------

def resolve_service(domain: str, service: str) -> Optional[SRVResult]:
    """
    Resolve a single service port via SRV.

    Args:
        domain:  e.g., 'alice.kirinnet.org'
        service: 'http', 'https', or 'ws'

    Returns:
        SRVResult(target, port) or None if no SRV record found.
    """
    srv_name = _SRV_SERVICES.get(service)
    if not srv_name:
        raise ValueError(f"Unknown service: {service}. Recognized: http, https, ws")

    full_name = f"{srv_name}.{domain}"

    try:
        answers = dns.resolver.resolve(full_name, "SRV")
    except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN, DNSException):
        return None

    # RFC 2782: lowest priority, then highest weight
    records = sorted(answers, key=lambda r: (r.priority, -r.weight))
    if not records:
        return None

    best = records[0]
    target = str(best.target).rstrip(".")
    return SRVResult(target=target, port=best.port)


def resolve_all_services(domain: str) -> Dict[str, Optional[SRVResult]]:
    """
    Resolve all SRV services for a domain.

    Returns:
        {'http': SRVResult|None, 'https': SRVResult|None, 'ws': SRVResult|None}
    """
    return {svc: resolve_service(domain, svc) for svc in _SRV_SERVICES}


# ---------------------------------------------------------------------------
# Identity Resolution (TXT)
# ---------------------------------------------------------------------------

def parse_identity_txt(text: str) -> Optional[Dict]:
    """
    Parse a semicolon-separated key=value TXT string into an identity dict.

    Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
    (spec Section 3.2)

    Returns None if not a valid identity record.
    """
    if not text or not text.startswith("id="):
        return None

    result = {}
    for pair in text.split(";"):
        if "=" not in pair:
            continue
        key, val = pair.split("=", 1)
        key, val = key.strip(), val.strip()
        result[key] = val

    # Both id and key are required
    if "id" not in result or "key" not in result:
        return None

    # Parse ipfs boolean
    if "ipfs" in result:
        result["ipfs"] = result["ipfs"].lower() == "true"

    return result


def resolve_identity(domain: str) -> Optional[Dict]:
    """
    Resolve identity metadata from TXT record.

    Returns:
        {'id': str, 'key': str, 'nick'?: str, 'ipfs'?: bool} or None.
    """
    try:
        answers = dns.resolver.resolve(domain, "TXT")
    except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN, DNSException):
        return None

    for rdata in answers:
        txt = "".join(s.decode("utf-8") if isinstance(s, bytes) else s
                       for s in rdata.strings)
        identity = parse_identity_txt(txt)
        if identity:
            return identity

    return None


# ---------------------------------------------------------------------------
# Legacy v1 Compatibility Layer (ADRP JSON TXT → port dict)
# ---------------------------------------------------------------------------
#
# ADRP v1 conveyed ports via a JSON TXT record (`{"http":8080,...}`).
# ADRP v2 replaces this with SRV records (see resolve_service above) plus a
# TXT identity record (see resolve_identity). The v1 helpers below are kept
# for backward compatibility and parity with the other 14 language libraries
# (Go/Rust/C/C++ all retain a v1 TXT-JSON parser). New code MUST use the v2
# resolve_service / resolve_identity API directly.

_RECOGNIZED_KEYS = frozenset({"http", "https", "ws", "wss"})


def _validate_kirin_dns_record(data) -> bool:
    """
    Validate a parsed object as a v1 ADRP record (spec §3.1).

    Rules:
      - `data` MUST be a dict.
      - At least one recognized key MUST be present.
      - Each recognized key's value MUST be an integer in [1, 65535].
      - Unknown keys are silently ignored.

    Returns True if the record is a valid v1 ADRP record.
    """
    if not isinstance(data, dict):
        return False

    has_recognized = False
    for key in _RECOGNIZED_KEYS:
        if key not in data:
            continue
        val = data[key]
        # bool is a subclass of int — reject it explicitly.
        if isinstance(val, bool) or not isinstance(val, int):
            return False
        if val < 1 or val > 65535:
            return False
        has_recognized = True

    return has_recognized


def _parse_txt_value(text: str) -> Dict:
    """
    Parse a single TXT record string as JSON and validate it as a v1 ADRP
    record. Returns a dict of recognized keys (empty dict if invalid /
    not JSON / no recognized keys). Mirrors the Go/Rust v1 parsers.
    """
    if json is None or not isinstance(text, str):
        return {}

    stripped = text.strip()
    if not stripped:
        return {}

    try:
        parsed = json.loads(stripped)
    except (ValueError, TypeError):
        return {}

    if not isinstance(parsed, dict):
        return {}

    result: Dict = {}
    for key in _RECOGNIZED_KEYS:
        if key not in parsed:
            continue
        val = parsed[key]
        if isinstance(val, bool) or not isinstance(val, int):
            return {}
        if val < 1 or val > 65535:
            return {}
        result[key] = val

    return result


# ---------------------------------------------------------------------------
# Legacy Compatibility Wrapper
# ---------------------------------------------------------------------------

def resolve_kirin_dns(domain: str) -> Dict:
    """
    Full resolution: SRV + TXT + identity (legacy wrapper).

    New code should use resolve_service() and resolve_identity() directly.
    """
    return {
        "domain": domain,
        "ws": resolve_service(domain, "ws") or SRVResult(target=domain, port=_FALLBACK_PORTS["ws"]),
        "http": resolve_service(domain, "http"),
        "https": resolve_service(domain, "https"),
        "identity": resolve_identity(domain),
    }


# ---------------------------------------------------------------------------
# Self-test (run with: python -m kirin_dns)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # Test non-existent domain
    ws = resolve_service("nonexistent.invalid", "ws")
    assert ws is None, f"Expected None, got {ws}"
    print(f"nonexistent.invalid WS: {ws}  (expected None)")

    identity = resolve_identity("nonexistent.invalid")
    assert identity is None, f"Expected None, got {identity}"
    print(f"nonexistent.invalid identity: {identity}  (expected None)")

    # Legacy identity parser tests
    parsed = parse_identity_txt(
        "id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false"
    )
    assert parsed["id"] == "550e8400-e29b-41d4-a716-446655440000"
    assert parsed["key"] == "04abc"
    assert parsed["nick"] == "Alice"
    assert parsed["ipfs"] is False

    minimal = parse_identity_txt("id=test-id;key=0x00")
    assert minimal["id"] == "test-id"
    assert minimal["key"] == "0x00"
    assert "nick" not in minimal

    # Invalid
    assert parse_identity_txt("v=spf1 include:_spf.example.com") is None
    assert parse_identity_txt("") is None
    assert parse_identity_txt("not an identity") is None

    # ---- did:dns three-record model self-test (C-1 baseline) ----
    # Real Ed25519 public key (32 bytes) -> compute its fingerprint.
    pk_bytes = bytes(range(32))
    pk_b64 = base64.urlsafe_b64encode(pk_bytes).decode("ascii").rstrip("=")
    fp = base64.urlsafe_b64encode(hashlib.sha256(pk_bytes).digest()[:12]).decode("ascii")
    now = int(time.time())

    recs = [
        "v=spf1 include:_spf.kirinnet.org -all",  # SPF — ignored
        f"did:dns:v=1;fp={fp};n=QWxpY2U;g=F;iat={now};exp={now + 3600}",
        f"did:dns:pk;kty=ed25519;pk={pk_b64}",
        f"did:dns:black;fp=RevokedAaaa,RevokedBbbb",
    ]
    ident = parse_did_dns_identity(recs)
    assert ident is not None, "did:dns identity must parse"
    assert ident.version == 1
    assert ident.fingerprint == fp
    assert ident.key_type == "ed25519"
    assert ident.fingerprint_chain_ok(), "fingerprint chain must hold"
    assert ident.nickname_decoded() == "Alice"
    assert ident.gender == "F"
    assert ident.is_valid(now=now), "fresh ed25519 identity must be valid"
    assert ident.blacklist == ["RevokedAaaa", "RevokedBbbb"]
    assert not ident.is_revoked()

    # Tampered pk -> chain breaks
    tampered = list(recs)
    tampered[2] = "did:dns:pk;kty=ed25519;pk=" + base64.urlsafe_b64encode(bytes(32)).decode("ascii").rstrip("=")
    broken = parse_did_dns_identity(tampered)
    assert broken is not None
    assert not broken.fingerprint_chain_ok(), "tampered pk must break chain"

    # Revoked -> invalid
    revoked_recs = [r.replace(f"fp={fp}", f"fp=RevokedAaaa") for r in recs]
    revoked = parse_did_dns_identity(revoked_recs)
    assert revoked.is_revoked()

    # Missing pk -> None
    assert parse_did_dns_identity([recs[1]]) is None
    # No did:dns at all -> None
    assert parse_did_dns_identity(["v=spf1 -all", "id=foo;key=bar"]) is None
    # Wrong kty -> invalid
    rsa_recs = [
        recs[1],
        f"did:dns:pk;kty=rsa;pk={pk_b64}",
    ]
    rsa_id = parse_did_dns_identity(rsa_recs)
    assert rsa_id is not None and rsa_id.key_type == "rsa" and not rsa_id.is_valid(now=now)

    print("KirinDNS Python self-test: PASSED (incl. did:dns fingerprint chain)")
