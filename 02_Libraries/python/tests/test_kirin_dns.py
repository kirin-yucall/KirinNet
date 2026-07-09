"""
KirinDNS — Python Library Tests

Run with: pytest

Dependencies: pytest, dnspython
    pip install pytest dnspython
"""

import json
from unittest.mock import patch, MagicMock

import pytest

from aura_dns import (
    resolve_kirin_dns,
    _validate_kirin_dns_record,
    _parse_txt_value,
    _RECOGNIZED_KEYS,
    _FALLBACK_PORTS,
)

import dns.resolver
from dns.exception import DNSException


# ---------------------------------------------------------------------------
# Validation tests
# ---------------------------------------------------------------------------

class TestValidateKirinDnsRecord:
    def test_valid_http_https(self):
        assert _validate_kirin_dns_record({"http": 8080, "https": 8443}) is True

    def test_valid_single_key(self):
        assert _validate_kirin_dns_record({"https": 443}) is True

    def test_valid_all_keys(self):
        assert _validate_kirin_dns_record({"http": 8080, "https": 8443, "ws": 8080, "wss": 8443}) is True

    def test_invalid_port_zero(self):
        assert _validate_kirin_dns_record({"ws": 0}) is False

    def test_invalid_port_too_high(self):
        assert _validate_kirin_dns_record({"ws": 65536}) is False

    def test_invalid_port_string(self):
        assert _validate_kirin_dns_record({"ws": "80"}) is False

    def test_invalid_no_recognized_key(self):
        assert _validate_kirin_dns_record({"unknown": 80}) is False

    def test_invalid_empty_dict(self):
        assert _validate_kirin_dns_record({}) is False

    def test_invalid_not_dict(self):
        assert _validate_kirin_dns_record("not a dict") is False

    def test_invalid_none(self):
        assert _validate_kirin_dns_record(None) is False

    def test_invalid_list(self):
        assert _validate_kirin_dns_record([1, 2]) is False

    def test_unknown_key_ignored_with_valid_key(self):
        # Unknown keys are ignored; as long as one recognized key is valid
        assert _validate_kirin_dns_record({"https": 443, "custom": "anything"}) is True

    def test_port_boundary_low(self):
        assert _validate_kirin_dns_record({"http": 1}) is True

    def test_port_boundary_high(self):
        assert _validate_kirin_dns_record({"http": 65535}) is True


# ---------------------------------------------------------------------------
# Parse TXT value tests
# ---------------------------------------------------------------------------

class TestParseTxtValue:
    def test_valid_json(self):
        result = _parse_txt_value('{"http": 8080, "https": 8443}')
        assert result == {"http": 8080, "https": 8443}

    def test_invalid_json(self):
        result = _parse_txt_value('not json')
        assert result == {}

    def test_valid_json_but_invalid_adrp(self):
        # Valid JSON but no recognized keys
        result = _parse_txt_value('{"spf": "v=spf1"}')
        assert result == {}

    def test_whitespace_stripped(self):
        result = _parse_txt_value('  {"https": 8443}  ')
        assert result == {"https": 8443}


# ---------------------------------------------------------------------------
# DNS resolution tests (mocked)
# ---------------------------------------------------------------------------

class MockRData:
    """Mock DNS TXT RDATA."""
    def __init__(self, strings):
        self.strings = strings


class TestResolveKirinDns:
    def test_valid_adrp_record(self):
        """A valid ADRP TXT record is parsed and ports returned."""
        mock_answer = MagicMock()
        mock_answer.__iter__ = MagicMock(return_value=iter([
            MockRData(['v=spf1 include:example.com -all']),  # SPF — should be skipped
            MockRData(['{"http": 8080, "https": 8443}']),   # ADRP — should be used
        ]))

        with patch.object(dns.resolver, 'resolve', return_value=mock_answer):
            result = resolve_kirin_dns("example.com")

        assert result["http"] == 8080
        assert result["https"] == 8443

    def test_no_txt_records(self):
        """NoAnswer -> fallback ports."""
        with patch.object(dns.resolver, 'resolve', side_effect=dns.resolver.NoAnswer):
            result = resolve_kirin_dns("example.com")

        assert result == {"http": 80, "https": 443, "ws": 80, "wss": 443}

    def test_nxdomain(self):
        """NXDOMAIN -> fallback ports."""
        with patch.object(dns.resolver, 'resolve', side_effect=dns.resolver.NXDOMAIN):
            result = resolve_kirin_dns("nonexistent.invalid")

        assert result == {"http": 80, "https": 443, "ws": 80, "wss": 443}

    def test_dns_exception(self):
        """Generic DNSException -> fallback ports."""
        with patch.object(dns.resolver, 'resolve', side_effect=DNSException("network error")):
            result = resolve_kirin_dns("example.com")

        assert result == {"http": 80, "https": 443, "ws": 80, "wss": 443}

    def test_malformed_txt_records(self):
        """All TXT records malformed -> fallback ports."""
        mock_answer = MagicMock()
        mock_answer.__iter__ = MagicMock(return_value=iter([
            MockRData(['v=spf1 include:example.com -all']),  # SPF
            MockRData(['not json at all']),                   # malformed
        ]))

        with patch.object(dns.resolver, 'resolve', return_value=mock_answer):
            result = resolve_kirin_dns("example.com")

        assert result == {"http": 80, "https": 443, "ws": 80, "wss": 443}

    def test_partial_adrp_record(self):
        """ADRP record with only https key -> http falls back to 80."""
        mock_answer = MagicMock()
        mock_answer.__iter__ = MagicMock(return_value=iter([
            MockRData(['{"https": 8443}']),
        ]))

        with patch.object(dns.resolver, 'resolve', return_value=mock_answer):
            result = resolve_kirin_dns("example.com")

        assert result["http"] == 80   # fallback
        assert result["https"] == 8443

    def test_first_valid_wins(self):
        """First valid ADRP record wins; subsequent records ignored."""
        mock_answer = MagicMock()
        mock_answer.__iter__ = MagicMock(return_value=iter([
            MockRData(['{"http": 9090, "https": 9443}']),  # first valid — used
            MockRData(['{"http": 1111}']),                   # second valid — ignored
        ]))

        with patch.object(dns.resolver, 'resolve', return_value=mock_answer):
            result = resolve_kirin_dns("example.com")

        assert result["http"] == 9090
        assert result["https"] == 9443

    def test_all_four_protocols(self):
        """All four protocol keys present."""
        mock_answer = MagicMock()
        mock_answer.__iter__ = MagicMock(return_value=iter([
            MockRData(['{"http": 8080, "https": 8443, "ws": 8080, "wss": 8443}']),
        ]))

        with patch.object(dns.resolver, 'resolve', return_value=mock_answer):
            result = resolve_kirin_dns("example.com")

        assert result == {"http": 8080, "https": 8443, "ws": 8080, "wss": 8443}

    def test_txt_string_split_across_rdata(self):
        """TXT record split across multiple strings in RDATA."""
        mock_answer = MagicMock()
        mock_answer.__iter__ = MagicMock(return_value=iter([
            MockRData(['{"http": ', '8080}']),  # split string
        ]))

        with patch.object(dns.resolver, 'resolve', return_value=mock_answer):
            result = resolve_kirin_dns("example.com")

        assert result["http"] == 8080


# ---------------------------------------------------------------------------
# Interoperability: cross-language consistency
# ---------------------------------------------------------------------------

class TestCrossLanguageConsistency:
    """
    These tests define the canonical expected outputs for each input.
    The same test cases are replicated in the JavaScript, Go, and Rust
    test suites. If all implementations pass these tests, they are
    interoperable.
    """

    TEST_CASES = [
        # (input_txt, expected_output)
        ('{"http": 8080, "https": 8443}', {"http": 8080, "https": 8443}),
        ('{"https": 443}', {"https": 443}),
        ('{"http": 1, "https": 65535}', {"http": 1, "https": 65535}),
        ('{"http": 0}', None),          # invalid port
        ('{"http": 65536}', None),      # invalid port
        ('{"http": "80"}', None),       # not an integer
        ('{"unknown": 80}', None),      # no recognized key
        ('{}', None),                    # empty
        ('v=spf1 include:example.com -all', None),  # SPF — not JSON
        ('not json', None),              # not JSON
        ('{"http": 8080, "https": 8443, "ws": 8080, "wss": 8443}',
         {"http": 8080, "https": 8443, "ws": 8080, "wss": 8443}),
    ]

    @pytest.mark.parametrize("input_txt,expected", TEST_CASES)
    def test_canonical_cases(self, input_txt, expected):
        result = _parse_txt_value(input_txt)
        if expected is None:
            assert result == {}
        else:
            assert result == expected
