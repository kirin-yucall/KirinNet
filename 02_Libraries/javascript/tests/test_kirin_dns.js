/**
 * KirinDNS — JavaScript Library Tests
 *
 * Run with: npx jest
 *
 * Dependencies: jest
 *     npm install --save-dev jest
 */

const dns = require('dns');

// Import the library (adjust path as needed)
const { resolve_kirin_dns } = require('../aura_dns');

// We need to re-export the internal functions for testing.
// Since aura_dns.js only exports resolve_kirin_dns, we re-implement
// the validation here for testing purposes, matching the spec.

const RECOGNIZED_KEYS = new Set(['http', 'https', 'ws', 'wss']);
const FALLBACK_PORTS = { http: 80, https: 443, ws: 80, wss: 443 };

function validateKirinDnsRecord(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false;
  }
  let recognizedKeyPresent = false;
  for (const [key, value] of Object.entries(data)) {
    if (RECOGNIZED_KEYS.has(key)) {
      recognizedKeyPresent = true;
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return false;
      }
    }
  }
  return recognizedKeyPresent;
}

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe('validateKirinDnsRecord', () => {
  test('valid http + https', () => {
    expect(validateKirinDnsRecord({ http: 8080, https: 8443 })).toBe(true);
  });

  test('valid single key', () => {
    expect(validateKirinDnsRecord({ https: 443 })).toBe(true);
  });

  test('valid all four keys', () => {
    expect(validateKirinDnsRecord({ http: 8080, https: 8443, ws: 8080, wss: 8443 })).toBe(true);
  });

  test('invalid port zero', () => {
    expect(validateKirinDnsRecord({ ws: 0 })).toBe(false);
  });

  test('invalid port too high', () => {
    expect(validateKirinDnsRecord({ ws: 65536 })).toBe(false);
  });

  test('invalid port string', () => {
    expect(validateKirinDnsRecord({ ws: '80' })).toBe(false);
  });

  test('invalid no recognized key', () => {
    expect(validateKirinDnsRecord({ unknown: 80 })).toBe(false);
  });

  test('invalid empty object', () => {
    expect(validateKirinDnsRecord({})).toBe(false);
  });

  test('invalid not object', () => {
    expect(validateKirinDnsRecord('not an object')).toBe(false);
  });

  test('invalid null', () => {
    expect(validateKirinDnsRecord(null)).toBe(false);
  });

  test('invalid array', () => {
    expect(validateKirinDnsRecord([1, 2])).toBe(false);
  });

  test('unknown key ignored with valid key', () => {
    expect(validateKirinDnsRecord({ https: 443, custom: 'anything' })).toBe(true);
  });

  test('port boundary low', () => {
    expect(validateKirinDnsRecord({ http: 1 })).toBe(true);
  });

  test('port boundary high', () => {
    expect(validateKirinDnsRecord({ http: 65535 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DNS resolution tests (mocked)
// ---------------------------------------------------------------------------

describe('resolve_kirin_dns', () => {
  beforeEach(() => {
    jest.spyOn(dns, 'resolveTxt').mockRestore();
  });

  test('valid ADRP TXT record returns correct ports', async () => {
    dns.resolveTxt.mockResolvedValue([
      ['v=spf1 include:example.com -all'],  // SPF — skipped
      ['{"http": 8080, "https": 8443}'],    // ADRP — used
    ]);

    const result = await resolve_kirin_dns('example.com');
    expect(result.http).toBe(8080);
    expect(result.https).toBe(8443);
  });

  test('ENOTFOUND returns fallback ports', async () => {
    dns.resolveTxt.mockRejectedValue(new dns.EOFError('ENOTFOUND'));

    const result = await resolve_kirin_dns('nonexistent.invalid');
    expect(result).toEqual({ http: 80, https: 443, ws: 80, wss: 443 });
  });

  test('malformed TXT records return fallback', async () => {
    dns.resolveTxt.mockResolvedValue([
      ['v=spf1 include:example.com -all'],  // SPF
      ['not json at all'],                   // malformed
    ]);

    const result = await resolve_kirin_dns('example.com');
    expect(result).toEqual({ http: 80, https: 443, ws: 80, wss: 443 });
  });

  test('partial ADRP record: http falls back to 80', async () => {
    dns.resolveTxt.mockResolvedValue([
      ['{"https": 8443}'],
    ]);

    const result = await resolve_kirin_dns('example.com');
    expect(result.http).toBe(80);   // fallback
    expect(result.https).toBe(8443);
  });

  test('first valid record wins', async () => {
    dns.resolveTxt.mockResolvedValue([
      ['{"http": 9090, "https": 9443}'],  // first — used
      ['{"http": 1111}'],                   // second — ignored
    ]);

    const result = await resolve_kirin_dns('example.com');
    expect(result.http).toBe(9090);
    expect(result.https).toBe(9443);
  });

  test('all four protocols', async () => {
    dns.resolveTxt.mockResolvedValue([
      ['{"http": 8080, "https": 8443, "ws": 8080, "wss": 8443}'],
    ]);

    const result = await resolve_kirin_dns('example.com');
    expect(result).toEqual({ http: 8080, https: 8443, ws: 8080, wss: 8443 });
  });

  test('network error returns fallback', async () => {
    dns.resolveTxt.mockRejectedValue(new Error('network error'));

    const result = await resolve_kirin_dns('example.com');
    expect(result).toEqual({ http: 80, https: 443, ws: 80, wss: 443 });
  });
});

// ---------------------------------------------------------------------------
// Interoperability: cross-language consistency (same test matrix as Python)
// ---------------------------------------------------------------------------

describe('Cross-Language Consistency', () => {
  const TEST_CASES = [
    ['{"http": 8080, "https": 8443}', { http: 8080, https: 8443 }],
    ['{"https": 443}', { https: 443 }],
    ['{"http": 1, "https": 65535}', { http: 1, https: 65535 }],
    ['{"http": 0}', null],
    ['{"http": 65536}', null],
    ['{"http": "80"}', null],
    ['{"unknown": 80}', null],
    ['{}', null],
    ['v=spf1 include:example.com -all', null],
    ['not json', null],
    ['{"http": 8080, "https": 8443, "ws": 8080, "wss": 8443}',
     { http: 8080, https: 8443, ws: 8080, wss: 8443 }],
  ];

  function parseTxtValue(text) {
    const trimmed = text.trim();
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    return validateKirinDnsRecord(parsed) ? parsed : null;
  }

  test.each(TEST_CASES)('input: %s -> expected: %j', (input, expected) => {
    const result = parseTxtValue(input);
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Setup: mock dns.resolveTxt before tests run
// ---------------------------------------------------------------------------
beforeAll(() => {
  dns.resolveTxt = jest.fn();
});

afterAll(() => {
  dns.resolveTxt.mockRestore();
});
