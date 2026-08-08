"""
KirinDNS Resolution Protocol (ADRP) v2.0 -- Python Client Library

Implements ADRP as defined in 01_Standard/spec_v1.md.

Architecture:
  SRV records for service port discovery (_kirinnet-http._tcp, etc.)
  TXT records for identity metadata (id=;key=;nick=;ipfs=)

Dependencies: dnspython
    pip install dnspython

Example usage:
    >>> from kirin_dns import resolve_service, resolve_identity
    >>> srv = resolve_service("alice.kirinnet.org", "ws")
    >>> print(srv)
    SRVResult(target='alice.kirinnet.org', port=8082)
    >>> identity = resolve_identity("alice.kirinnet.org")
    >>> print(identity)
    {'id': '550e8400-...', 'key': '04abc...', 'nick': 'Alice'}
"""

from dataclasses import dataclass
from typing import Dict, Optional

import dns.resolver
from dns.exception import DNSException

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

    # Identity parser tests
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

    print("KirinDNS Python self-test: PASSED")
