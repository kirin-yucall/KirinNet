/**
 * KirinDNS — did:dns three-record identity model tests (C-1 baseline).
 *
 * Mirrors python/tests/test_did_dns.py. These vectors are the canonical
 * cross-language conformance cases. Run: npx jest tests/did_dns.test.js
 */

const crypto = require('crypto');
const {
  parseDidDnsIdentity,
  DidDnsIdentity,
  padB64Url,
} = require('../kirin_dns');

// Deterministic 32-byte "Ed25519" public key + matching fingerprint.
const PK_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const PK_B64 = PK_BYTES.toString('base64url');
const FP = crypto.createHash('sha256').update(PK_BYTES).digest().subarray(0, 12).toString('base64url');
const NOW = 1_700_000_000;

function records(overrides = {}) {
  const iat = overrides.iat ?? NOW;
  const exp = overrides.exp ?? NOW + 3600;
  let decl = `did:dns:v=1;fp=${overrides.fp ?? FP}`;
  if (overrides.n !== undefined) decl += `;n=${overrides.n}`;
  if (overrides.g !== undefined) decl += `;g=${overrides.g}`;
  decl += `;iat=${iat};exp=${exp}`;
  const recs = ['v=spf1 include:_spf.kirinnet.org -all', decl];
  if (overrides.kty !== undefined) {
    recs.push(`did:dns:pk;kty=${overrides.kty};pk=${overrides.pk ?? PK_B64}`);
  } else {
    recs.push(`did:dns:pk;kty=ed25519;pk=${overrides.pk ?? PK_B64}`);
  }
  if (overrides.black !== undefined) recs.push(`did:dns:black;fp=${overrides.black}`);
  if (overrides.noise !== undefined) recs.push(overrides.noise);
  return recs;
}

describe('parseDidDnsIdentity — classification', () => {
  test('full three-record set', () => {
    const id = parseDidDnsIdentity(records());
    expect(id).not.toBeNull();
    expect(id.version).toBe(1);
    expect(id.fingerprint).toBe(FP);
    expect(id.keyType).toBe('ed25519');
    expect(id.publicKeyB64Url).toBe(PK_B64);
    expect(id.issuedAt).toBe(NOW);
    expect(id.expiresAt).toBe(NOW + 3600);
  });

  test('records in any order', () => {
    const id = parseDidDnsIdentity([...records()].reverse());
    expect(id).not.toBeNull();
    expect(id.fingerprint).toBe(FP);
  });

  test('SPF/DKIM noise ignored', () => {
    const id = parseDidDnsIdentity(records({ noise: 'v=DKIM1; k=rsa; p=MIGfMA0' }));
    expect(id).not.toBeNull();
    expect(id.fingerprintChainOk()).toBe(true);
  });

  test('missing declaration returns null', () => {
    expect(parseDidDnsIdentity([`did:dns:pk;kty=ed25519;pk=${PK_B64}`])).toBeNull();
  });

  test('missing pk returns null', () => {
    expect(parseDidDnsIdentity([`did:dns:v=1;fp=${FP};iat=${NOW};exp=${NOW + 1}`])).toBeNull();
  });

  test('no did:dns returns null (legacy id= ignored)', () => {
    expect(parseDidDnsIdentity(['id=foo;key=bar;nick=Alice'])).toBeNull();
    expect(parseDidDnsIdentity(['v=spf1 -all', 'random txt'])).toBeNull();
  });

  test('accepts single string', () => {
    expect(parseDidDnsIdentity(`did:dns:v=1;fp=${FP};iat=${NOW};exp=${NOW + 1}`)).toBeNull();
  });

  test('accepts Buffer', () => {
    const id = parseDidDnsIdentity(records().map(r => Buffer.from(r, 'utf-8')));
    expect(id).not.toBeNull();
  });

  test('null input returns null', () => {
    expect(parseDidDnsIdentity(null)).toBeNull();
  });

  test('blacklist parsed', () => {
    const id = parseDidDnsIdentity(records({ black: 'OldAaaa,OldBbbb' }));
    expect(id.blacklist).toEqual(['OldAaaa', 'OldBbbb']);
  });
});

describe('fingerprint chain', () => {
  test('holds for real pk', () => {
    expect(parseDidDnsIdentity(records()).fingerprintChainOk()).toBe(true);
  });

  test('breaks on tampered pk', () => {
    const wrongPk = Buffer.alloc(32, 255).toString('base64url');
    const id = parseDidDnsIdentity(records({ pk: wrongPk }));
    expect(id).not.toBeNull();
    expect(id.fingerprintChainOk()).toBe(false);
  });

  test('computeFingerprint matches spec (16 chars)', () => {
    const id = new DidDnsIdentity({ publicKeyB64Url: PK_B64 });
    const computed = id.computeFingerprint();
    expect(computed).toHaveLength(16);
    expect(computed).toBe(FP);
  });

  test('padB64Url helper', () => {
    expect(padB64Url('YWJj')).toBe('YWJj');
    expect(padB64Url('YWJ')).toBe('YWJ=');
    expect(padB64Url('YW')).toBe('YW==');
    expect(padB64Url('QWxpY2U')).toBe('QWxpY2U=');
  });
});

describe('isValid policy', () => {
  test('fresh ed25519 is valid', () => {
    expect(parseDidDnsIdentity(records()).isValid(NOW)).toBe(true);
  });

  test('rsa kty rejected', () => {
    const id = parseDidDnsIdentity(records({ kty: 'rsa' }));
    expect(id.keyType).toBe('rsa');
    expect(id.isValid(NOW)).toBe(false);
  });

  test('revoked fingerprint rejected', () => {
    const id = parseDidDnsIdentity(records({ black: FP }));
    expect(id.isRevoked()).toBe(true);
    expect(id.isValid(NOW)).toBe(false);
  });

  test('expired rejected', () => {
    const id = parseDidDnsIdentity(records({ exp: NOW - 1 }));
    expect(id.isExpired(NOW)).toBe(true);
    expect(id.isValid(NOW)).toBe(false);
  });

  test('stale iat flagged', () => {
    const id = parseDidDnsIdentity(records({ iat: NOW - 600 }));
    expect(id.isStale(NOW)).toBe(true);
  });

  test('broken chain rejected', () => {
    const wrongPk = Buffer.alloc(32, 255).toString('base64url');
    const id = parseDidDnsIdentity(records({ pk: wrongPk }));
    expect(id.isValid(NOW)).toBe(false);
  });
});

describe('nickname decoding', () => {
  test('decoded Alice', () => {
    const id = parseDidDnsIdentity(records({ n: 'QWxpY2U' }));
    expect(id.nicknameDecoded()).toBe('Alice');
  });

  test('no nickname', () => {
    expect(parseDidDnsIdentity(records()).nicknameDecoded()).toBeNull();
  });

  test('unicode nickname', () => {
    const enc = Buffer.from('麒麟', 'utf-8').toString('base64url');
    const id = parseDidDnsIdentity(records({ n: enc }));
    expect(id.nicknameDecoded()).toBe('麒麟');
  });
});
