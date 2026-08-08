/**
 * KirinDNS v2.0 -- JavaScript Library Tests
 *
 * Run with: npx jest
 *
 * Dependencies: jest
 *     npm install --save-dev jest
 */

const dns = require('dns');

// Import the library
const {
  resolveService,
  resolveAllServices,
  resolveIdentity,
  resolve_kirin_dns,
  parseIdentityTxt,
  SRV_SERVICES,
  FALLBACK_PORTS,
} = require('../kirin_dns');

// ---------------------------------------------------------------------------
// Identity TXT Parser Tests
// ---------------------------------------------------------------------------

describe('parseIdentityTxt', () => {
  test('full identity record', () => {
    const result = parseIdentityTxt(
      'id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false'
    );
    expect(result.id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.key).toBe('04abc');
    expect(result.nick).toBe('Alice');
    expect(result.ipfs).toBe(false);
  });

  test('ipfs=true parsed as boolean', () => {
    const result = parseIdentityTxt('id=test;key=04;ipfs=true');
    expect(result.ipfs).toBe(true);
  });

  test('minimal identity (only id + key)', () => {
    const result = parseIdentityTxt('id=minimal;key=0x00');
    expect(result.id).toBe('minimal');
    expect(result.key).toBe('0x00');
    expect(result.nick).toBeUndefined();
  });

  test('SPF record skipped', () => {
    expect(parseIdentityTxt('v=spf1 include:_spf.example.com')).toBeNull();
  });

  test('empty string returns null', () => {
    expect(parseIdentityTxt('')).toBeNull();
  });

  test('missing key returns null', () => {
    expect(parseIdentityTxt('id=nokey')).toBeNull();
  });

  test('missing id returns null', () => {
    expect(parseIdentityTxt('key=noid')).toBeNull();
  });

  test('whitespace around values trimmed', () => {
    const result = parseIdentityTxt('id= test ;key= 04abc ;nick= Alice ');
    expect(result.id).toBe('test');
    expect(result.key).toBe('04abc');
    expect(result.nick).toBe('Alice');
  });

  test('unknown keys ignored', () => {
    const result = parseIdentityTxt('id=test;key=04;custom=ignored');
    expect(result.id).toBe('test');
    expect(result.key).toBe('04');
    expect(result.custom).toBe('ignored');
  });
});

// ---------------------------------------------------------------------------
// SRV Service Resolution Tests (mocked)
// ---------------------------------------------------------------------------

describe('resolveService', () => {
  beforeEach(() => {
    jest.spyOn(dns, 'resolveSrv').mockRestore();
  });

  test('resolves WS service via SRV', async () => {
    dns.resolveSrv.mockResolvedValue([
      { name: 'alice.kirinnet.org', port: 8082, priority: 0, weight: 0 },
    ]);

    const result = await resolveService('alice.kirinnet.org', 'ws');
    expect(result).toEqual({ target: 'alice.kirinnet.org', port: 8082 });
  });

  test('SRV returns null for nonexistent domain', async () => {
    dns.resolveSrv.mockRejectedValue(new Error('ENOTFOUND'));

    const result = await resolveService('nonexistent.invalid', 'ws');
    expect(result).toBeNull();
  });

  test('SRV returns null for empty answer', async () => {
    dns.resolveSrv.mockResolvedValue([]);

    const result = await resolveService('example.com', 'http');
    expect(result).toBeNull();
  });

  test('throws on unknown service', async () => {
    await expect(resolveService('example.com', 'unknown'))
      .rejects.toThrow('Unknown service');
  });

  test('RFC 2782: lowest priority selected', async () => {
    dns.resolveSrv.mockResolvedValue([
      { name: 'high-prio.kirinnet.org', port: 9000, priority: 5, weight: 0 },
      { name: 'low-prio.kirinnet.org',  port: 8080, priority: 1, weight: 0 },
      { name: 'mid-prio.kirinnet.org',  port: 3000, priority: 3, weight: 0 },
    ]);

    const result = await resolveService('example.com', 'http');
    expect(result.target).toBe('low-prio.kirinnet.org');
    expect(result.port).toBe(8080);
  });
});

// ---------------------------------------------------------------------------
// Identity Resolution Tests (mocked)
// ---------------------------------------------------------------------------

describe('resolveIdentity', () => {
  beforeEach(() => {
    jest.spyOn(dns, 'resolveTxt').mockRestore();
  });

  test('resolves identity from TXT', async () => {
    dns.resolveTxt.mockResolvedValue([
      ['v=spf1 -all'],
      ['id=550e8400;key=04abc;nick=Alice'],
    ]);

    const result = await resolveIdentity('alice.kirinnet.org');
    expect(result.id).toBe('550e8400');
    expect(result.key).toBe('04abc');
    expect(result.nick).toBe('Alice');
  });

  test('returns null when no identity TXT', async () => {
    dns.resolveTxt.mockResolvedValue([
      ['v=spf1 -all'],
      ['v=DKIM1; k=rsa; p=...'],
    ]);

    const result = await resolveIdentity('example.com');
    expect(result).toBeNull();
  });

  test('returns null for NXDOMAIN', async () => {
    dns.resolveTxt.mockRejectedValue(new Error('ENOTFOUND'));

    const result = await resolveIdentity('nonexistent.invalid');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Legacy Compatibility Wrapper Tests
// ---------------------------------------------------------------------------

describe('resolve_kirin_dns (legacy wrapper)', () => {
  test('returns full resolution with fallback WS', async () => {
    jest.spyOn(dns, 'resolveSrv').mockResolvedValue([]);
    jest.spyOn(dns, 'resolveTxt').mockResolvedValue([]);

    const result = await resolve_kirin_dns('unknown.domain');
    expect(result.ws.port).toBe(80); // fallback
    expect(result.http).toBeNull();
    expect(result.https).toBeNull();
    expect(result.identity).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Constants Tests
// ---------------------------------------------------------------------------

describe('Constants', () => {
  test('SRV_SERVICES has all three services', () => {
    expect(SRV_SERVICES.http).toBe('_kirinnet-http._tcp');
    expect(SRV_SERVICES.https).toBe('_kirinnet-https._tcp');
    expect(SRV_SERVICES.ws).toBe('_kirinnet-ws._tcp');
  });

  test('FALLBACK_PORTS has standard ports', () => {
    expect(FALLBACK_PORTS.http).toBe(80);
    expect(FALLBACK_PORTS.https).toBe(443);
    expect(FALLBACK_PORTS.ws).toBe(80);
    expect(FALLBACK_PORTS.wss).toBe(443);
  });
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  dns.resolveSrv = jest.fn();
  dns.resolveTxt = jest.fn();
});

afterAll(() => {
  dns.resolveSrv.mockRestore();
  dns.resolveTxt.mockRestore();
});
