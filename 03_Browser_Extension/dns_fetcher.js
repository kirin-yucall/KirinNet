/**
 * dns_fetcher.js — KirinDNS DNS-over-HTTPS (DoH) Fetcher
 *
 * Queries Cloudflare's DoH API to resolve ADRP TXT records, caches results
 * in chrome.storage.local, and returns port mappings.
 *
 * DoH Endpoint: https://1.1.1.1/dns-query
 * CORS: Cloudflare's DoH endpoint supports CORS, so fetch() works directly
 * from the browser without a proxy.
 *
 * Caching:
 *   Key:   aura_dns_cache_{domain}
 *   Value: { ports: { http: 8080, ... }, timestamp: number, ttl: 3600000 }
 *   TTL:   1 hour (3600000 ms), matching the spec's TTL-based caching guidance.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOH_URL = 'https://1.1.1.1/dns-query';
const DOH_HEADERS = { 'Accept': 'application/dns-json' };

// Recognized ADRP keys (spec Section 3.1.1)
const RECOGNIZED_KEYS = new Set(['http', 'https', 'ws', 'wss']);

// Fallback ports (spec Section 3.2, Step 5)
const FALLBACK_PORTS = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

// Cache TTL in milliseconds (1 hour)
const CACHE_TTL = 3600000;

// ---------------------------------------------------------------------------
// ADRP Validation (same logic as Phase 2 JS library)
// ---------------------------------------------------------------------------

/**
 * Validate an ADRP JSON payload against the spec (Section 3.1).
 * @param {object} data - Parsed JSON object.
 * @returns {boolean}
 */
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

/**
 * Parse a TXT record value as ADRP JSON.
 * @param {string} txtValue - The full TXT record string.
 * @returns {object|null} Parsed ADRP record or null.
 */
function parseKirinDnsTxt(txtValue) {
  const trimmed = txtValue.trim();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return validateKirinDnsRecord(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Cache Helpers
// ---------------------------------------------------------------------------

/**
 * Build the cache key for a domain.
 * @param {string} domain
 * @returns {string}
 */
function cacheKey(domain) {
  return `aura_dns_cache_${domain}`;
}

/**
 * Retrieve a cached ADRP result for a domain.
 * Returns null if not cached or expired.
 * @param {string} domain
 * @returns {Promise<object|null>} The cached ports object, or null.
 */
async function getCachedPorts(domain) {
  const key = cacheKey(domain);
  const result = await chrome.storage.local.get(key);
  const entry = result[key];

  if (!entry) {
    return null;
  }

  // Check TTL expiration
  const age = Date.now() - entry.timestamp;
  if (age > entry.ttl) {
    // Expired — remove the stale entry
    await chrome.storage.local.remove(key);
    return null;
  }

  return entry.ports;
}

/**
 * Save an ADRP result to chrome.storage.local cache.
 * @param {string} domain
 * @param {object} ports
 */
async function setCachedPorts(domain, ports) {
  const key = cacheKey(domain);
  const entry = {
    ports: ports,
    timestamp: Date.now(),
    ttl: CACHE_TTL,
  };
  await chrome.storage.local.set({ [key]: entry });
}

// ---------------------------------------------------------------------------
// DoH Fetcher
// ---------------------------------------------------------------------------

/**
 * Resolve ADRP ports for a domain via Cloudflare DoH.
 *
 * Flow:
 *   1. Check in-extension cache (chrome.storage.local). If valid, return it.
 *   2. Fetch TXT records via Cloudflare DoH.
 *   3. Parse the Answer array for TXT records (type 16).
 *   4. Apply the "first valid" aggregation strategy (spec Section 3.1.2).
 *   5. If a valid ADRP record is found, cache it and return the ports.
 *   6. If no valid record, return fallback ports (no cache write — avoids
 *      caching negative results).
 *
 * @param {string} domain - The domain to resolve.
 * @returns {Promise<object>} Port mapping object.
 */
async function getKirinDNSPorts(domain) {
  // Step 1 — Check cache
  const cached = await getCachedPorts(domain);
  if (cached !== null) {
    return cached;
  }

  // Start with fallback; recognized keys will be overwritten if found.
  const result = { ...FALLBACK_PORTS };

  // Step 2 — Fetch from Cloudflare DoH
  const url = `${DOH_URL}?name=${encodeURIComponent(domain)}&type=TXT`;
  let response;
  try {
    response = await fetch(url, { headers: DOH_HEADERS });
  } catch (err) {
    // Network error — return fallback without caching
    return result;
  }

  if (!response.ok) {
    // HTTP error — return fallback without caching
    return result;
  }

  let dnsJson;
  try {
    dnsJson = await response.json();
  } catch (err) {
    return result;
  }

  // Step 3 — Parse Answer array for TXT records (type 16)
  const answers = dnsJson.Answer || [];
  let foundValid = false;

  for (const record of answers) {
    if (record.type !== 16) {
      // Not a TXT record — skip
      continue;
    }

    // Cloudflare DoH returns TXT data as an array of strings,
    // each wrapped in quotes.  Join them to reconstruct the full TXT value.
    const txtValue = record.data.join('');
    const parsed = parseKirinDnsTxt(txtValue);

    if (parsed !== null) {
      // Found the first valid ADRP record (spec Section 3.1.2)
      Object.assign(result, parsed);
      foundValid = true;
      break;
    }
  }

  // Step 5 — If valid, cache and return; otherwise return fallback
  if (foundValid) {
    await setCachedPorts(domain, result);
  }

  return result;
}

module.exports = { getKirinDNSPorts };
