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

// SRV service names (spec Section 2.2)
const SRV_SERVICES = {
  http:  '_kirinnet-http._tcp',
  https: '_kirinnet-https._tcp',
  ws:    '_kirinnet-ws._tcp',
};

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

/**
 * Resolve identity metadata from TXT record.
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
  // Primary API
  resolveService,
  resolveAllServices,
  resolveIdentity,
  // Legacy wrapper
  resolve_kirin_dns,
  // Utilities
  parseIdentityTxt,
  // Constants
  SRV_SERVICES,
  FALLBACK_PORTS,
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

    console.log('\nAll KirinDNS tests passed.');
  })();
}
