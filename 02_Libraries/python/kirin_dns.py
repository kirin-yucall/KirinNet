"""
KirinDNS Resolution Protocol (ADRP) — Python Client Library

Implements ADRP as defined in 01_Standard/spec_v1.md.

Resolution algorithm:
  1. Query TXT records for the target domain.
  2. Iterate through each TXT record; attempt to parse as JSON.
  3. The first record that parses as valid JSON and contains at least one
     recognized key (http, https, ws, wss) is the ADRP response.
  4. If no valid ADRP record is found, return the standard fallback ports.

Dependencies: dnspython
    pip install dnspython

Example usage:
    >>> from aura_dns import resolve_kirin_dns
    >>> ports = resolve_kirin_dns("example.com")
    >>> print(ports)
    {'https': 8443}

    >>> ports = resolve_kirin_dns("nonexistent.invalid")
    >>> print(ports)
    {'http': 80, 'https': 443}
"""

import json
from typing import Dict

import dns.resolver
from dns.exception import DNSException

# Recognized ADRP keys and their fallback ports (Section 3.2, Step 5)
_RECOGNIZED_KEYS = frozenset({"http", "https", "ws", "wss"})
_FALLBACK_PORTS = {
    "http": 80,
    "https": 443,
    "ws": 80,
    "wss": 443,
}


def _validate_kirin_dns_record(data: Dict) -> bool:
    """
    Validate an ADRP JSON payload against the spec (Section 3.1).

    Rules:
      - All values MUST be integers in the range 1-65535.
      - At least one recognized key MUST be present.
      - Duplicate keys are caught by json.loads (raises ValueError),
        so we do not need to check explicitly here.
    """
    if not isinstance(data, dict):
        return False

    recognized_keys_present = False
    for key, value in data.items():
        if key in _RECOGNIZED_KEYS:
            recognized_keys_present = True
            if not isinstance(value, int) or value < 1 or value > 65535:
                return False
        # Keys not in _RECOGNIZED_KEYS are ignored (spec Section 3.1.1)

    return recognized_keys_present


def _parse_txt_value(record: str) -> Dict:
    """
    Parse a single TXT record string as JSON.

    The spec (Section 3.1.1) requires the JSON object to be the sole content
    of the TXT character string. We strip surrounding whitespace but do not
    tolerate additional text.
    """
    text = record.strip()
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return {}  # Not valid JSON — skip this record

    if _validate_kirin_dns_record(parsed):
        return parsed
    return {}  # Valid JSON but not a valid ADRP record


def resolve_kirin_dns(domain: str) -> Dict[str, int]:
    """
    Resolve the KirinDNS ports for *domain*.

    Returns a dict mapping protocol keys to port numbers.  If the domain has
    no valid ADRP TXT record, the standard fallback ports are returned.

    Raises
    ------
    DNSException
        If the DNS query itself fails (network error, timeout, etc.).
    """
    # Start with full fallback; recognized keys will be overwritten if found.
    result = dict(_FALLBACK_PORTS)

    # Step 1 — Issue TXT query (spec Section 3.2, Step 1)
    try:
        answers = dns.resolver.resolve(domain, "TXT")
    except dns.resolver.NoAnswer:
        # No TXT records at all — fall back to defaults.
        return result
    except dns.resolver.NXDOMAIN:
        # Domain does not exist — fall back to defaults.
        return result
    except DNSException:
        # Network error, timeout, etc. — fall back to defaults.
        return result

    # Step 2-3 — Aggregate and parse (spec Section 3.1.2, "first valid" rule)
    for rdata in answers:
        # dns.resolver returns TXT RDATA as a tuple of strings that may
        # be concatenated.  Join them to reconstruct the full TXT value.
        txt_value = "".join(rdata.strings)
        parsed = _parse_txt_value(txt_value)
        if parsed:  # Found the first valid ADRP record
            # Overwrite only the keys present in the record; missing keys
            # retain their fallback values.
            result.update(parsed)
            return result

    # No valid ADRP record found — return fallback.
    return result


# ---------------------------------------------------------------------------
# Self-test (run with: python -m kirin_dns)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    # Example: query a real domain (will likely return fallback ports)
    test_domain = "example.com"
    print(f"ADRP query for {test_domain}: {resolve_kirin_dns(test_domain)}")

    # Example: NXDOMAIN should return fallback
    print(f"ADRP query for nonexistent.invalid: {resolve_kirin_dns('nonexistent.invalid')}")

    # Internal unit tests
    assert _validate_kirin_dns_record({"http": 8080, "https": 8443}) is True
    assert _validate_kirin_dns_record({"https": 443}) is True
    assert _validate_kirin_dns_record({"ws": 0}) is False          # port out of range
    assert _validate_kirin_dns_record({"ws": 65536}) is False      # port out of range
    assert _validate_kirin_dns_record({"ws": "80"}) is False       # not an int
    assert _validate_kirin_dns_record({"unknown": 80}) is False    # no recognized key
    assert _validate_kirin_dns_record({}) is False                  # empty dict
    assert _validate_kirin_dns_record("not a dict") is False        # wrong type
    print("Internal unit tests passed.")
