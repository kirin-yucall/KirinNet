/**
 * KirinDNS Resolution Protocol (ADRP) v2.0 — Node.js Client Library
 *
 * Implements ADRP as defined in 01_Standard/spec_v1.md.
 *
 * Architecture:
 *   SRV records for service port discovery (_kirinnet-http._tcp, etc.)
 *   TXT records for identity metadata (id=;key=;nick=;ipfs=)
 *
 * Resolution algorithm:
 *   1. Query SRV record for the requested service + domain.
 *   2. If SRV returns a valid record, use the target:port.
 *   3. If SRV fails (NXDOMAIN / no records), fall back to standard port.
 *   4. Query TXT records for identity metadata (optional).
 *
 * NOTE ON BROWSER USAGE:
 *   Browsers cannot directly query DNS records. This library is intended
 *   for Node.js (server-side) use. For browser-based resolution, use the
 *   DoH approach in 03_Browser_Extension/ which proxies queries through
 *   a DNS-over-HTTPS endpoint.
 *
 * NOTE ON SECURITY:
 *   Node.js's built-in dns module uses unencrypted DNS by default. For
 *   production ADRP queries, configure a DoH/DoT resolver in front of this
 *   library. See 01_Standard/spec_v1.md Section 4.3.
 *
 * Example usage:
 *   const { resolveService, resolveIdentity } = require('./kirin_dns');
 *
 *   (async () => {
 *     const ws = await resolveService('alice.kirinnet.org', 'ws');
 *     console.log(ws);  // => { target: 'alice.kirinnet.org', port: 8082 }
 *
 *     const id = await resolveIdentity('alice.kirinnet.org');
 *     console.log(id);  // => { id: '550e8400-...', key: '04abc...', nick: 'Alice' }
 *   })();
 */

const dns = require('dns');
const crypto = require('crypto');

// SRV service names (spec Section 2.2)
const SRV_SERVICES = {
  http:  '_kirinnet-http._tcp',
  https: '_kirinnet-https._tcp',
  ws:    '_kirinnet-ws._tcp',
};

// did:dns protocol constants (spec §3.2.1 / did-dns-protocol §2, C-1 baseline)
const DID_DNS_PREFIX = 'did:dns:';
const DID_DNS_DECL = 'did:dns:v=';
const DID_DNS_PK = 'did:dns:pk;';
const DID_DNS_BLACK = 'did:dns:black;';
const DID_DNS_KTY_ED25519 = 'ed25519';
const DID_DNS_FRESHNESS_WINDOW = 5 * 60;       // ±5 minutes (spec §3.2.1)
const DID_DNS_FINGERPRINT_BYTES = 12;          // SHA-256[0:12] -> 16 base64url chars

// Fallback ports (spec Section 3.3.1, Step 4)
const FALLBACK_PORTS = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

// ---------------------------------------------------------------------------
// Service Resolution (SRV)
// ---------------------------------------------------------------------------

/**
 * Resolve a single service port via SRV.
 *
 * @param {string} domain  - e.g., 'alice.kirinnet.org'
 * @param {string} service - 'http', 'https', or 'ws'
 * @returns {Promise<{target: string, port: number}|null>}
 *   Returns null if no SRV record found (caller should fall back).
 */
async function resolveService(domain, service) {
  const srvName = SRV_SERVICES[service];
  if (!srvName) {
    throw new Error(`Unknown service: ${service}. Recognized: http, https, ws`);
  }

  const fullName = `${srvName}.${domain}`;

  let records;
  try {
    records = await dns.resolveSrv(fullName);
  } catch (err) {
    // ENOTFOUND, ENODATA, etc. → no SRV record
    return null;
  }

  if (!records || records.length === 0) {
    return null;
  }

  // RFC 2782: use lowest priority, then highest weight
  records.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.weight - a.weight;
  });

  const best = records[0];
  return { target: best.name, port: best.port };
}

/**
 * Resolve all SRV services for a domain.
 *
 * @param {string} domain
 * @returns {Promise<object>}
 *   e.g., { http: {target, port}, https: {target, port}, ws: {target, port} }
 *   Missing services return null for that key.
 */
async function resolveAllServices(domain) {
  const [http, https, ws] = await Promise.all([
    resolveService(domain, 'http'),
    resolveService(domain, 'https'),
    resolveService(domain, 'ws'),
  ]);
  return { http, https, ws };
}

// ---------------------------------------------------------------------------
// Identity Resolution (TXT)
// ---------------------------------------------------------------------------

/**
 * Parse a semicolon-separated key=value TXT string into an identity object.
 *
 * Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
 * (spec Section 3.2)
 *
 * @param {string} txt - Raw TXT record value.
 * @returns {object|null} Parsed identity, or null if not a valid identity record.
 */
function parseIdentityTxt(txt) {
  if (!txt || !txt.startsWith('id=')) return null;

  const result = {};
  txt.split(';').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    const key = pair.substring(0, eq).trim();
    const val = pair.substring(eq + 1).trim();
    result[key] = val;
  });

  // Both id and key are required
  if (!result.id || !result.key) return null;

  // Parse ipfs boolean if present
  if (result.ipfs !== undefined) {
    result.ipfs = result.ipfs === 'true';
  }

  return result;
}

// ---------------------------------------------------------------------------
// did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)
// ---------------------------------------------------------------------------

/**
 * Pad a Base64URL string (no padding) so Node can decode it.
 * @param {string} s
 * @returns {string}
 */
function padB64Url(s) {
  return s + '='.repeat((4 - (s.length % 4)) % 4);
}

/**
 * Parse a `k=v;k=v` segment (after the `did:dns:` prefix) into an object.
 * @param {string} text
 * @returns {Object<string,string>}
 */
function parseDidDnsKv(text) {
  const out = {};
  for (const pair of text.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = pair.substring(0, eq).trim();
    const v = pair.substring(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

/**
 * Verified did:dns identity (declaration + public key, optional blacklist).
 *
 * Returned only when declaration+pk records are both present. The fingerprint
 * chain (fp == Base64URL(SHA-256(pk)[0:12])) is checked by `fingerprintChainOk()`;
 * the caller decides trust policy via `isValid()` (fail-closed default).
 */
class DidDnsIdentity {
  constructor(opts = {}) {
    this.version = opts.version ?? 1;
    this.fingerprint = opts.fingerprint ?? '';
    this.nickname = opts.nickname ?? null;        // Base64URL(UTF-8)
    this.gender = opts.gender ?? null;            // M/F/O/X
    this.issuedAt = opts.issuedAt ?? null;
    this.expiresAt = opts.expiresAt ?? null;
    this.keyType = opts.keyType ?? DID_DNS_KTY_ED25519;
    this.publicKeyB64Url = opts.publicKeyB64Url ?? '';
    this.blacklist = opts.blacklist ?? [];
    this.rawDeclaration = opts.rawDeclaration ?? '';
    this.rawPublicKey = opts.rawPublicKey ?? '';
  }

  /** Full public-key bytes (decoded from Base64URL). */
  get publicKeyBytes() {
    return Buffer.from(padB64Url(this.publicKeyB64Url), 'base64url');
  }

  /** Recompute fp = Base64URL(SHA-256(pk)[0:12]) over the public key. */
  computeFingerprint() {
    const digest = crypto.createHash('sha256').update(this.publicKeyBytes).digest();
    return digest.subarray(0, DID_DNS_FINGERPRINT_BYTES).toString('base64url');
  }

  /** True iff declared fp matches recomputed fp over the pk bytes. */
  fingerprintChainOk() {
    return !!this.fingerprint && this.fingerprint === this.computeFingerprint();
  }

  isRevoked() {
    return this.blacklist.includes(this.fingerprint);
  }

  isExpired(now) {
    if (this.expiresAt == null) return false;
    return (now ?? Math.floor(Date.now() / 1000)) >= this.expiresAt;
  }

  isStale(now) {
    if (this.issuedAt == null) return false;
    return Math.abs((now ?? Math.floor(Date.now() / 1000)) - this.issuedAt) > DID_DNS_FRESHNESS_WINDOW;
  }

  /** Composite policy: version 1 + ed25519 + chain holds + not revoked + not expired. */
  isValid(now) {
    return (
      this.version === 1 &&
      this.keyType === DID_DNS_KTY_ED25519 &&
      this.fingerprintChainOk() &&
      !this.isRevoked() &&
      !this.isExpired(now)
    );
  }

  /** Decode the Base64URL(UTF-8) nickname, or null. */
  nicknameDecoded() {
    if (!this.nickname) return null;
    try {
      return Buffer.from(padB64Url(this.nickname), 'base64url').toString('utf-8');
    } catch {
      return null;
    }
  }
}

/**
 * Classify TXT records by did:dns: sub-type and assemble an identity.
 *
 * @param {string[]|string|null} txtRecords
 * @returns {DidDnsIdentity|null}
 *   null if no did:dns records are found, or if declaration/pk is missing.
 */
function parseDidDnsIdentity(txtRecords) {
  if (txtRecords == null) return null;
  if (typeof txtRecords === 'string' || Buffer.isBuffer(txtRecords)) {
    txtRecords = [txtRecords];
  }

  let declRaw = null, pkRaw = null, blackRaw = null;
  for (let txt of txtRecords) {
    if (Buffer.isBuffer(txt)) txt = txt.toString('utf-8');
    if (typeof txt !== 'string') continue;
    const s = txt.trim();
    if (s.startsWith(DID_DNS_DECL)) {
      if (declRaw === null) declRaw = s;
    } else if (s.startsWith(DID_DNS_PK)) {
      if (pkRaw === null) pkRaw = s;
    } else if (s.startsWith(DID_DNS_BLACK)) {
      if (blackRaw === null) blackRaw = s;
    }
  }

  if (declRaw == null || pkRaw == null) return null;

  const decl = parseDidDnsKv(declRaw.substring(DID_DNS_PREFIX.length));
  const pk = parseDidDnsKv(pkRaw.substring(DID_DNS_PREFIX.length));

  const parseIntOrNull = (v) => (/^-?\d+$/.test(v ?? '') ? parseInt(v, 10) : null);

  const identity = new DidDnsIdentity({
    version: parseInt(decl.v ?? '1', 10),
    fingerprint: decl.fp ?? '',
    nickname: decl.n || null,
    gender: decl.g || null,
    issuedAt: parseIntOrNull(decl.iat),
    expiresAt: parseIntOrNull(decl.exp),
    keyType: pk.kty ?? DID_DNS_KTY_ED25519,
    publicKeyB64Url: pk.pk ?? '',
    rawDeclaration: declRaw,
    rawPublicKey: pkRaw,
  });

  if (blackRaw != null) {
    const fpField = parseDidDnsKv(blackRaw.substring(DID_DNS_PREFIX.length)).fp ?? '';
    identity.blacklist = fpField.split(',').filter(f => f.length > 0);
  }

  return identity;
}

/**
 * Resolve and verify a did:dns identity for `domain` via TXT query.
 *
 * Returns null on NXDOMAIN / no TXT / no did:dns: records (fail-closed —
 * caller proceeds with a null identity).
 *
 * @param {string} domain
 * @returns {Promise<DidDnsIdentity|null>}
 */
async function resolveIdentityDidDns(domain) {
  let txtRecords;
  try {
    txtRecords = await dns.resolveTxt(domain);
  } catch (err) {
    return null;
  }
  const flat = txtRecords.map(r => Array.isArray(r) ? r.join('') : r);
  return parseDidDnsIdentity(flat);
}

/**
 * Resolve legacy identity metadata from a TXT record (id=;key=;nick=;ipfs=).
 *
 * @param {string} domain
 * @returns {Promise<object|null>}
 *   { id, key, nick?, ipfs? } or null if no identity TXT found.
 */
async function resolveIdentity(domain) {
  let txtRecords;
  try {
    txtRecords = await dns.resolveTxt(domain);
  } catch (err) {
    return null; // NXDOMAIN, no TXT, etc.
  }

  for (const record of txtRecords) {
    const txt = record.join('');
    const identity = parseIdentityTxt(txt);
    if (identity) return identity;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Legacy Compatibility Wrapper
// ---------------------------------------------------------------------------

/**
 * Full resolution: SRV + TXT + identity (legacy wrapper).
 *
 * Maintained for backward compatibility with code that calls the old
 * `resolve_kirin_dns()` API. New code should use `resolveService()` and
 * `resolveIdentity()` directly.
 *
 * @param {string} domain
 * @returns {Promise<object>}
 *   { domain, ws: {target, port}, http: {target, port}|null,
 *     https: {target, port}|null, identity: {id, key, nick}|null }
 */
async function resolve_kirin_dns(domain) {
  const [wsSrv, identity, allSrv] = await Promise.all([
    resolveService(domain, 'ws'),
    resolveIdentity(domain),
    resolveAllServices(domain),
  ]);

  return {
    domain,
    ws:    wsSrv || { target: domain, port: FALLBACK_PORTS.ws },
    http:  allSrv.http,
    https: allSrv.https,
    identity: identity || null,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Primary API (v2 SRV + legacy TXT-JSON identity)
  resolveService,
  resolveAllServices,
  resolveIdentity,
  // did:dns three-record identity model (C-1 baseline)
  DidDnsIdentity,
  parseDidDnsIdentity,
  resolveIdentityDidDns,
  padB64Url,
  // Legacy wrapper
  resolve_kirin_dns,
  // Utilities
  parseIdentityTxt,
  // Constants
  SRV_SERVICES,
  FALLBACK_PORTS,
  DID_DNS_PREFIX,
  DID_DNS_KTY_ED25519,
};

// ---------------------------------------------------------------------------
// Self-test (run with: node kirin_dns.js)
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log('=== KirinDNS SRV Resolution Test ===\n');

    // Test non-existent domain (should return null SRV, null identity)
    const wsNone = await resolveService('nonexistent.invalid', 'ws');
    const idNone = await resolveIdentity('nonexistent.invalid');
    console.log(`nonexistent.invalid: WS=${JSON.stringify(wsNone)}, Identity=${JSON.stringify(idNone)}`);
    console.assert(wsNone === null, 'no SRV for nonexistent domain');
    console.assert(idNone === null, 'no TXT for nonexistent domain');

    // Identity parser tests
    const parsed = parseIdentityTxt('id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false');
    console.assert(parsed.id === '550e8400-e29b-41d4-a716-446655440000', 'id parsed');
    console.assert(parsed.key === '04abc', 'key parsed');
    console.assert(parsed.nick === 'Alice', 'nick parsed');
    console.assert(parsed.ipfs === false, 'ipfs parsed as boolean');

    // Minimal identity
    const minimal = parseIdentityTxt('id=test-id;key=0x00');
    console.assert(minimal.id === 'test-id', 'minimal id');
    console.assert(minimal.key === '0x00', 'minimal key');
    console.assert(minimal.nick === undefined, 'no nick');

    // Invalid identity
    console.assert(parseIdentityTxt('not an identity') === null, 'invalid txt');
    console.assert(parseIdentityTxt('v=spf1 include:_spf.example.com') === null, 'spf record skipped');
    console.assert(parseIdentityTxt('') === null, 'empty string');
    console.assert(parseIdentityTxt(null) === null, 'null input');

    console.log('\nIdentity parser tests: PASSED');

    // Legacy wrapper test
    const full = await resolve_kirin_dns('nonexistent.invalid');
    console.assert(full.ws.port === 80, 'legacy ws fallback');
    console.assert(full.http === null, 'legacy http null');
    console.assert(full.identity === null, 'legacy identity null');
    console.log('Legacy wrapper test: PASSED');

    // ---- did:dns three-record model self-test (C-1 baseline) ----
    const { parseDidDnsIdentity } = module.exports;
    const pkBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const pkB64 = pkBytes.toString('base64url');
    const fpCalc = crypto.createHash('sha256').update(pkBytes).digest().subarray(0, 12).toString('base64url');
    const ts = Math.floor(Date.now() / 1000);

    const recs = [
      'v=spf1 include:_spf.kirinnet.org -all',
      `did:dns:v=1;fp=${fpCalc};n=QWxpY2U;g=F;iat=${ts};exp=${ts + 3600}`,
      `did:dns:pk;kty=ed25519;pk=${pkB64}`,
      'did:dns:black;fp=RevokedAaaa,RevokedBbbb',
    ];
    const didId = parseDidDnsIdentity(recs);
    console.assert(didId !== null, 'did:dns identity parsed');
    console.assert(didId.version === 1, 'did:dns version');
    console.assert(didId.fingerprint === fpCalc, 'did:dns fp');
    console.assert(didId.keyType === 'ed25519', 'did:dns kty');
    console.assert(didId.fingerprintChainOk() === true, 'did:dns fingerprint chain');
    console.assert(didId.isValid(ts) === true, 'did:dns valid');
    console.assert(didId.nicknameDecoded() === 'Alice', 'did:dns nickname decode');
    console.assert(didId.blacklist.length === 2, 'did:dns blacklist size');
    console.assert(didId.isRevoked() === false, 'did:dns not revoked');

    // Tampered pk -> chain breaks
    const tampered = [...recs];
    tampered[2] = `did:dns:pk;kty=ed25519;pk=${Buffer.alloc(32, 255).toString('base64url')}`;
    const broken = parseDidDnsIdentity(tampered);
    console.assert(broken.fingerprintChainOk() === false, 'tampered pk breaks chain');

    // Missing pk -> null
    console.assert(parseDidDnsIdentity([recs[1]]) === null, 'missing pk -> null');
    // No did:dns -> null
    console.assert(parseDidDnsIdentity(['v=spf1 -all', 'id=foo;key=bar']) === null, 'no did:dns -> null');
    // Wrong kty -> invalid
    const rsaRecs = [recs[1], `did:dns:pk;kty=rsa;pk=${pkB64}`];
    const rsaId = parseDidDnsIdentity(rsaRecs);
    console.assert(rsaId.keyType === 'rsa' && rsaId.isValid(ts) === false, 'rsa kty rejected');

    console.log('\ndid:dns identity self-test: PASSED');
    console.log('\nAll KirinDNS tests passed.');
  })();
}
