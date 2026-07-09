/**
 * service_worker.js — KirinDNS Browser Extension Service Worker
 *
 * Intercepts HTTP/HTTPS requests and redirects them to ADRP-discovered
 * non-standard ports.
 *
 * Architecture:
 *   - An in-memory cache (ADRP_CACHE) holds domain -> ports mappings.
 *     This is loaded from chrome.storage.local on startup so that the
 *     webRequest.onBeforeRequest callback can redirect synchronously.
 *   - When a request arrives for a domain not in the cache, the worker
 *     resolves ADRP in the background. The current request is NOT blocked;
 *     it proceeds to the default port. Subsequent requests to the same
 *     domain will be redirected because the cache will have been populated.
 *
 * Manifest V3 constraint: webRequest.onBeforeRequest with the "blocking"
 * extra info spec requires a synchronous callback. Because DNS resolution
 * is async, we cannot block the first request to a new domain. The in-memory
 * cache makes subsequent redirects synchronous.
 *
 * Error handling: If DoH resolution fails (network error, DNS failure), the
 * request proceeds to the default port. We never cancel a user's request due
 * to ADRP resolution failures.
 */

// ---------------------------------------------------------------------------
// In-memory ADRP cache (loaded from chrome.storage.local on startup)
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} domain -> ports object */
const ADRP_CACHE = new Map();

// Fallback ports (spec Section 3.2, Step 5)
const FALLBACK_PORTS = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

// ---------------------------------------------------------------------------
// Load cached ADRP data from chrome.storage.local into memory
// ---------------------------------------------------------------------------

/**
 * Populate ADRP_CACHE from chrome.storage.local on service worker startup.
 */
async function loadCache() {
  const all = await chrome.storage.local.get();
  for (const [key, entry] of Object.entries(all)) {
    if (!key.startsWith('aura_dns_cache_')) {
      continue;
    }
    // Skip expired entries
    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      continue;
    }
    const domain = key.replace('aura_dns_cache_', '');
    ADRP_CACHE.set(domain, entry.ports);
  }
}

// Load cache immediately on startup
loadCache().catch(() => {
  // If loading fails, the cache is simply empty; requests fall back to defaults.
});

// ---------------------------------------------------------------------------
// ADRP Resolution (imported from dns_fetcher.js)
// ---------------------------------------------------------------------------

// Re-implement the ADRP validation inline (service workers cannot use require)
const RECOGNIZED_KEYS = new Set(['http', 'https', 'ws', 'wss']);
const DOH_URL = 'https://1.1.1.1/dns-query';
const DOH_HEADERS = { 'Accept': 'application/dns-json' };
const CACHE_TTL = 3600000;

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

/**
 * Resolve ADRP ports for a domain via Cloudflare DoH (in the background).
 * Updates both the in-memory cache and chrome.storage.local.
 * @param {string} domain
 */
async function resolveKirinDNS(domain) {
  // If already cached, nothing to do
  if (ADRP_CACHE.has(domain)) {
    return;
  }

  // Mark as "in progress" with a sentinel to avoid duplicate queries
  ADRP_CACHE.set(domain, null);

  const result = { ...FALLBACK_PORTS };

  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(domain)}&type=TXT`;
    const response = await fetch(url, { headers: DOH_HEADERS });

    if (!response.ok) {
      ADRP_CACHE.delete(domain);
      return;
    }

    const dnsJson = await response.json();
    const answers = dnsJson.Answer || [];
    let foundValid = false;

    for (const record of answers) {
      if (record.type !== 16) {
        continue;
      }
      const txtValue = record.data.join('');
      const parsed = parseKirinDnsTxt(txtValue);
      if (parsed !== null) {
        Object.assign(result, parsed);
        foundValid = true;
        break;
      }
    }

    if (foundValid) {
      ADRP_CACHE.set(domain, result);
      // Persist to chrome.storage.local
      const cacheKey = `aura_dns_cache_${domain}`;
      await chrome.storage.local.set({
        [cacheKey]: {
          ports: result,
          timestamp: Date.now(),
          ttl: CACHE_TTL,
        },
      });
    } else {
      // No valid ADRP record — remove the sentinel
      ADRP_CACHE.delete(domain);
    }
  } catch (err) {
    // Network error — remove the sentinel so we can retry later
    ADRP_CACHE.delete(domain);
  }
}

// ---------------------------------------------------------------------------
// URL Port Injection
// ---------------------------------------------------------------------------

/**
 * Build a new URL with the ADRP-discovered port injected.
 * Returns null if the port is the default (no redirect needed).
 *
 * @param {URL} url - The original request URL.
 * @param {object} ports - ADRP port mapping.
 * @returns {string|null} The redirect URL, or null if no redirect needed.
 */
function buildRedirectUrl(url, ports) {
  // Determine the protocol key
  const protocolKey = url.protocol === 'https:' ? 'https' : 'http';

  // If the key is not in the ADRP result, no redirect
  if (!Object.prototype.hasOwnProperty.call(ports, protocolKey)) {
    return null;
  }

  const targetPort = ports[protocolKey];
  const defaultPort = FALLBACK_PORTS[protocolKey];

  // If the ADRP port matches the default, no redirect needed
  if (targetPort === defaultPort) {
    return null;
  }

  // If the URL already has the target port, no redirect needed
  if (url.port === String(targetPort)) {
    return null;
  }

  // Construct the redirect URL with the target port
  const redirect = url.clone();
  redirect.port = targetPort;
  return redirect.href;
}

// ---------------------------------------------------------------------------
// webRequest Interceptor
// ---------------------------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only intercept http: and https: requests (spec Section 3.2)
    const url = new URL(details.url);
    const protocolKey = url.protocol === 'https:' ? 'https' : 'http';

    if (protocolKey !== 'http' && protocolKey !== 'https') {
      // Not HTTP/HTTPS — let it through
      return undefined;
    }

    const domain = url.hostname;
    const cachedPorts = ADRP_CACHE.get(domain);

    if (cachedPorts !== undefined && cachedPorts !== null) {
      // We have cached ADRP data — check if a redirect is needed
      const redirectUrl = buildRedirectUrl(url, cachedPorts);
      if (redirectUrl) {
        return { redirectUrl };
      }
    } else if (cachedPorts === undefined) {
      // Domain not in cache at all — resolve in the background.
      // The current request proceeds to the default port; future requests
      // will benefit from the cached ADRP data.
      resolveKirinDNS(domain);
    }
    // cachedPorts === null means "in progress" — let the request proceed.

    // No redirect needed (or in progress) — let the request continue
    return undefined;
  },
  {
    urls: ['<all_urls>'],
  },
  ['blocking']
);

// ---------------------------------------------------------------------------
// Logging (for development)
// ---------------------------------------------------------------------------

// Uncomment the following block for debug logging:
//
// chrome.webRequest.onBeforeRequest.addListener(
//   (details) => {
//     const url = new URL(details.url);
//     const domain = url.hostname;
//     const cached = ADRP_CACHE.get(domain);
//     console.log(`[KirinDNS] Request: ${details.url} | Cache:`, cached);
//   },
//   { urls: ['<all_urls>'] },
//   []
// );
