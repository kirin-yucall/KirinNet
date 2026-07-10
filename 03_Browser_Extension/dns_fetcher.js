/**
 * dns_fetcher.js -- KirinDNS DNS-over-HTTPS (DoH) Fetcher (v2.0)
 *
 * Queries Cloudflare's DoH API to resolve ADRP SRV records for service
 * discovery and TXT records for identity metadata. Caches results in
 * chrome.storage.local.
 *
 * DoH Endpoint: https://1.1.1.1/dns-query
 *
 * Caching:
 *   SRV cache key:   kirin_srv_{domain}_{service}
 *   TXT cache key:   kirin_identity_{domain}
 *   TTL: 1 hour (3600000 ms)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOH_URL = 'https://1.1.1.1/dns-query';
const DOH_HEADERS = { 'Accept': 'application/dns-json' };

// SRV service names (spec v2 Section 2.2)
const SRV_SERVICES = {
  http:  '_kirinnet-http._tcp',
  https: '_kirinnet-https._tcp',
  ws:    '_kirinnet-ws._tcp',
};

const FALLBACK_PORTS = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

const CACHE_TTL = 3600000; // 1 hour

// ---------------------------------------------------------------------------
// Cache Helpers
// ---------------------------------------------------------------------------

function srvCacheKey(domain, service) {
  return `kirin_srv_${domain}_${service}`;
}

function identityCacheKey(domain) {
  return `kirin_identity_${domain}`;
}

async function getCached(key) {
  const result = await chrome.storage.local.get(key);
  const entry = result[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > entry.ttl) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.data;
}

async function setCached(key, data) {
  await chrome.storage.local.set({
    [key]: { data, timestamp: Date.now(), ttl: CACHE_TTL },
  });
}

// ---------------------------------------------------------------------------
// SRV Resolution via DoH
// ---------------------------------------------------------------------------

/**
 * Resolve a single service via SRV over DoH.
 *
 * @param {string} domain  - e.g., 'alice.kirinnet.org'
 * @param {string} service - 'http', 'https', 'ws'
 * @returns {Promise<{target: string, port: number}|null>}
 */
async function resolveService(domain, service) {
  const srvName = SRV_SERVICES[service];
  if (!srvName) return null;

  // Check cache
  const cacheKey = srvCacheKey(domain, service);
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const fullName = `${srvName}.${domain}`;
  const url = `${DOH_URL}?name=${encodeURIComponent(fullName)}&type=SRV`;

  let response;
  try {
    response = await fetch(url, { headers: DOH_HEADERS });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let dnsJson;
  try {
    dnsJson = await response.json();
  } catch {
    return null;
  }

  const answers = (dnsJson.Answer || []).filter(r => r.type === 33); // SRV = type 33
  if (answers.length === 0) return null;

  // RFC 2782: sort by priority, then weight
  answers.sort((a, b) => {
    const pa = parseInt(a.data.split(' ')[0]) || 0;
    const pb = parseInt(b.data.split(' ')[0]) || 0;
    if (pa !== pb) return pa - pb;
    const wa = parseInt(a.data.split(' ')[1]) || 0;
    const wb = parseInt(b.data.split(' ')[1]) || 0;
    return wb - wa;
  });

  const parts = answers[0].data.split(' ');
  const result = {
    target: (parts[3] || domain).replace(/\.$/, ''),
    port: parseInt(parts[2]) || FALLBACK_PORTS[service] || 80,
  };

  await setCached(cacheKey, result);
  return result;
}

/**
 * Resolve all SRV services for a domain.
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
// Identity TXT Resolution via DoH
// ---------------------------------------------------------------------------

/**
 * Parse a semicolon-separated identity TXT string.
 * Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
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

  if (!result.id || !result.key) return null;
  if (result.ipfs !== undefined) result.ipfs = result.ipfs === 'true';
  return result;
}

/**
 * Resolve identity metadata from TXT record via DoH.
 */
async function resolveIdentity(domain) {
  // Check cache
  const cacheKey = identityCacheKey(domain);
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const url = `${DOH_URL}?name=${encodeURIComponent(domain)}&type=TXT`;

  let response;
  try {
    response = await fetch(url, { headers: DOH_HEADERS });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let dnsJson;
  try {
    dnsJson = await response.json();
  } catch {
    return null;
  }

  const answers = (dnsJson.Answer || []).filter(r => r.type === 16); // TXT = type 16
  for (const record of answers) {
    const txt = record.data.join('');
    const identity = parseIdentityTxt(txt);
    if (identity) {
      await setCached(cacheKey, identity);
      return identity;
    }
  }

  return null;
}

module.exports = {
  resolveService,
  resolveAllServices,
  resolveIdentity,
  parseIdentityTxt,
  SRV_SERVICES,
  FALLBACK_PORTS,
};
