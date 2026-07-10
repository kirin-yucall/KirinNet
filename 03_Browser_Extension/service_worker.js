/**
 * service_worker.js -- KirinDNS Browser Extension Service Worker (v2.0)
 *
 * Intercepts HTTP/HTTPS requests and redirects them to SRV-discovered
 * non-standard ports.
 *
 * Architecture:
 *   - An in-memory SRV cache (SRV_CACHE) holds domain+service -> {target, port}.
 *   - An in-memory identity cache (IDENTITY_CACHE) holds domain -> identity.
 *   - Loaded from chrome.storage.local on startup for synchronous redirects.
 *   - When a request arrives for a domain not in cache, the worker resolves
 *     SRV in the background. The current request proceeds to the default port;
 *     subsequent requests to the same domain will be redirected.
 *
 * Manifest V3 constraint: webRequest.onBeforeRequest with "blocking" requires
 * a synchronous callback. Because DNS resolution is async, we cannot block the
 * first request to a new domain. The in-memory cache makes subsequent
 * redirects synchronous.
 */

// ---------------------------------------------------------------------------
// In-memory caches (loaded from chrome.storage.local on startup)
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} domain -> ports mapping for redirect */
const SRV_CACHE = new Map();

/** @type {Map<string, object>} domain -> identity mapping */
const IDENTITY_CACHE = new Map();

const SRV_SERVICES = {
  http:  '_kirinnet-http._tcp',
  https: '_kirinnet-https._tcp',
  ws:    '_kirinnet-ws._tcp',
};

const FALLBACK_PORTS = { http: 80, https: 443, ws: 80, wss: 443 };
const DOH_URL = 'https://1.1.1.1/dns-query';
const DOH_HEADERS = { 'Accept': 'application/dns-json' };
const CACHE_TTL = 3600000;

// ---------------------------------------------------------------------------
// Load cached data from chrome.storage.local into memory
// ---------------------------------------------------------------------------

async function loadCache() {
  const all = await chrome.storage.local.get();
  for (const [key, entry] of Object.entries(all)) {
    if (Date.now() - entry.timestamp > entry.ttl) continue;

    if (key.startsWith('kirin_srv_') && entry.data) {
      // key format: kirin_srv_{domain}_{service}
      const parts = key.replace('kirin_srv_', '').split('_');
      const service = parts.pop();
      const domain = parts.join('_');
      SRV_CACHE.set(`${domain}:${service}`, entry.data);
    } else if (key.startsWith('kirin_identity_') && entry.data) {
      const domain = key.replace('kirin_identity_', '');
      IDENTITY_CACHE.set(domain, entry.data);
    }
  }
}

loadCache().catch(() => {});

// ---------------------------------------------------------------------------
// SRV Resolution via DoH (background)
// ---------------------------------------------------------------------------

function parseIdentityTxt(txt) {
  if (!txt || !txt.startsWith('id=')) return null;
  const result = {};
  txt.split(';').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    result[pair.substring(0, eq).trim()] = pair.substring(eq + 1).trim();
  });
  if (!result.id || !result.key) return null;
  if (result.ipfs !== undefined) result.ipfs = result.ipfs === 'true';
  return result;
}

async function resolveSrv(domain, service) {
  const cacheKey = `${domain}:${service}`;
  if (SRV_CACHE.has(cacheKey)) return;

  const srvName = SRV_SERVICES[service];
  if (!srvName) return;

  // Sentinel to avoid duplicate queries
  SRV_CACHE.set(cacheKey, null);

  try {
    const fullName = `${srvName}.${domain}`;
    const url = `${DOH_URL}?name=${encodeURIComponent(fullName)}&type=SRV`;
    const response = await fetch(url, { headers: DOH_HEADERS });
    if (!response.ok) { SRV_CACHE.delete(cacheKey); return; }

    const dnsJson = await response.json();
    const answers = (dnsJson.Answer || []).filter(r => r.type === 33);
    if (answers.length === 0) { SRV_CACHE.delete(cacheKey); return; }

    answers.sort((a, b) => {
      const pa = parseInt(a.data.split(' ')[0]) || 0;
      const pb = parseInt(b.data.split(' ')[0]) || 0;
      if (pa !== pb) return pa - pb;
      return (parseInt(b.data.split(' ')[1]) || 0) - (parseInt(a.data.split(' ')[1]) || 0);
    });

    const parts = answers[0].data.split(' ');
    const result = {
      target: (parts[3] || domain).replace(/\.$/, ''),
      port: parseInt(parts[2]) || FALLBACK_PORTS[service] || 80,
    };

    SRV_CACHE.set(cacheKey, result);
    await chrome.storage.local.set({
      [`kirin_srv_${domain}_${service}`]: {
        data: result, timestamp: Date.now(), ttl: CACHE_TTL,
      },
    });
  } catch {
    SRV_CACHE.delete(cacheKey);
  }
}

// ---------------------------------------------------------------------------
// URL Port Injection
// ---------------------------------------------------------------------------

function buildRedirectUrl(url, srvResult) {
  if (!srvResult) return null;
  if (srvResult.port === FALLBACK_PORTS[url.protocol === 'https:' ? 'https' : 'http']) return null;
  if (url.port === String(srvResult.port)) return null;

  const redirect = new URL(url.href);
  redirect.port = srvResult.port;
  if (srvResult.target !== url.hostname) {
    redirect.hostname = srvResult.target;
  }
  return redirect.href;
}

// ---------------------------------------------------------------------------
// webRequest Interceptor
// ---------------------------------------------------------------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = new URL(details.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

    const domain = url.hostname;
    const protocolKey = url.protocol === 'https:' ? 'https' : 'http';
    const cacheKey = `${domain}:${protocolKey}`;

    const cached = SRV_CACHE.get(cacheKey);

    if (cached !== undefined && cached !== null) {
      const redirectUrl = buildRedirectUrl(url, cached);
      if (redirectUrl) return { redirectUrl };
    } else if (cached === undefined) {
      // Resolve in background; current request proceeds to default port
      resolveSrv(domain, protocolKey);
    }
    // cached === null means "in progress"

    return undefined;
  },
  { urls: ['<all_urls>'] },
  ['blocking']
);
