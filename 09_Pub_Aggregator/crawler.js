/**
 * crawler.js — KirinNet Public Aggregator Crawler
 *
 * Crawls User Nodes by resolving their KirinDNS TXT records,
 * fetching public content metadata from /kirin/content, then
 * storing it in SQLite. Content-only — no social graph, no IM.
 *
 * Key behaviors:
 * - Rate limiting: 1 request per second per domain
 * - Thumbnail verification: fetches thumbnails to confirm accessibility
 * - Graceful degradation: /kirin/profile is optional; content crawl proceeds regardless
 * - Never crashes on a single node failure
 */

const dns = require('dns').promises;
const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const DB_PATH = path.join(DATA_DIR, 'db', 'aggregator.db');

// Rate limiting: minimum delay between requests to the same domain (ms)
const RATE_LIMIT_DELAY = 1000;

// Ensure directories exist
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create schema
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    domain        TEXT NOT NULL UNIQUE,
    nickname      TEXT NOT NULL DEFAULT 'Unknown',
    bio           TEXT DEFAULT '',
    avatar        TEXT DEFAULT '',
    port          INTEGER,
    last_crawled  TIMESTAMP,
    crawl_error   TEXT,
    crawl_count   INTEGER DEFAULT 0,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS content (
    id            TEXT PRIMARY KEY,
    node_id       TEXT NOT NULL REFERENCES users(id),
    domain        TEXT NOT NULL,
    title         TEXT NOT NULL,
    type          TEXT NOT NULL,
    url           TEXT NOT NULL,
    thumbnail     TEXT DEFAULT '',
    description   TEXT DEFAULT '',
    file_size     INTEGER DEFAULT 0,
    mime_type     TEXT DEFAULT '',
    views         INTEGER DEFAULT 0,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_content_domain ON content(domain);
  CREATE INDEX IF NOT EXISTS idx_content_type ON content(type);
  CREATE INDEX IF NOT EXISTS idx_content_created ON content(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_content_views ON content(views DESC);
  CREATE INDEX IF NOT EXISTS idx_content_search ON content(title, description);
`;
db.exec(SCHEMA);

// --- HTTP helpers ---

function fetchJSON(url, timeout = 10000, sinceHeader = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout,
      headers: {},
    };
    if (sinceHeader) {
      options.headers['Since'] = sinceHeader;
    }
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * Verify a thumbnail URL is accessible (HEAD request, 5s timeout).
 * Returns true if the server responds with 2xx.
 */
function verifyThumbnail(thumbUrl, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(thumbUrl);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'HEAD',
        timeout,
      }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => { resolve(false); });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

// --- Rate limiter ---

const _lastRequestTime = new Map(); // domain -> timestamp

function rateLimit(domain) {
  const now = Date.now();
  const last = _lastRequestTime.get(domain) || 0;
  const elapsed = now - last;
  if (elapsed < RATE_LIMIT_DELAY) {
    const delay = RATE_LIMIT_DELAY - elapsed;
    _lastRequestTime.set(domain, Date.now());
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
  _lastRequestTime.set(domain, Date.now());
  return Promise.resolve();
}

// --- KirinDNS v2 SRV+TXT resolution ---

const SRV_SERVICES = {
  http:  '_kirinnet-http._tcp',
  https: '_kirinnet-https._tcp',
  ws:    '_kirinnet-ws._tcp',
};

const FALLBACK_PORTS = { http: 80, https: 443, ws: 80 };

/**
 * Resolve a single service via SRV.
 * Returns { target, port } or null.
 */
async function resolveService(domain, service) {
  if (!SRV_SERVICES[service]) {
    return null;
  }
  const srvName = `${SRV_SERVICES[service]}.${domain}`;
  try {
    const records = await dns.resolveSrv(srvName);
    if (!records || records.length === 0) return null;
    // RFC 2782: sort by priority ascending
    records.sort((a, b) => (a.priority || 0) - (b.priority || 0));
    return { target: records[0].name, port: records[0].port };
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') return null;
    return null;
  }
}

/**
 * Resolve identity via TXT (id=<uuid>;key=<hex>;nick=<name>).
 */
async function resolveIdentity(domain) {
  try {
    const records = await dns.resolveTxt(domain);
    for (const record of records) {
      const txt = record.join('');
      // Parse semicolon-delimited key=value pairs
      const parsed = {};
      for (const part of txt.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        parsed[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
      if (parsed.id && parsed.key) {
        return parsed;
      }
    }
    return null;
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') return null;
    return null;
  }
}

/**
 * Resolve full KirinDNS mapping for a domain.
 * Returns { http, https, ws, identity } — null entries for unresolvable.
 */
async function resolveKirinDNS(domain) {
  const [httpSrv, httpsSrv, wsSrv, identity] = await Promise.all([
    resolveService(domain, 'http'),
    resolveService(domain, 'https'),
    resolveService(domain, 'ws'),
    resolveIdentity(domain),
  ]);

  return {
    http:  httpSrv  || { target: domain, port: FALLBACK_PORTS.http },
    https: httpsSrv || { target: domain, port: FALLBACK_PORTS.https },
    ws:    wsSrv    || { target: domain, port: FALLBACK_PORTS.ws },
    identity,
  };
}

// --- Update crawl status ---

function updateCrawlStatus(domain, error) {
  const existing = db.prepare('SELECT id FROM users WHERE domain = ?').get(domain);
  if (existing) {
    db.prepare(
      'UPDATE users SET crawl_error = ?, last_crawled = datetime("now"), crawl_count = crawl_count + 1 WHERE domain = ?'
    ).run(error, domain);
  }
}

// --- Crawl a single User Node (CONTENT ONLY) ---

async function crawlUserNode(domain) {
  console.log(`[Crawler] Crawling ${domain}...`);

  try {
    // Step 1: Resolve KirinDNS v2 (SRV+TXT)
    const adrp = await resolveKirinDNS(domain);

    // Use HTTP service SRV target and port, with fallback to domain:80
    const targetHost = adrp.http.target || domain;
    const port = adrp.http.port || 80;
    const baseUrl = `http://${targetHost}:${port}`;

    // Log identity if available
    if (adrp.identity) {
      console.log(`[Crawler] KirinDNS identity: ${adrp.identity.nick || adrp.identity.id}`);
    }

    // Step 2: Fetch profile (OPTIONAL — content is what matters)
    let profile = null;
    try {
      await rateLimit(domain);
      profile = await fetchJSON(`${baseUrl}/kirin/profile`, 8000);
      if (!profile || !profile.nickname) profile = null;
    } catch (err) {
      console.log(`[Crawler] Profile fetch failed for ${domain}: ${err.message} — proceeding without profile`);
    }

    // Step 3: Fetch content list from /kirin/content
    // Handle both formats: bare array OR { items: [...], total, limit, offset }
    // Use incremental fetching with Since header if we have a previous crawl time
    let contentItems = [];
    const lastCrawled = db.prepare('SELECT last_crawled FROM users WHERE domain = ?').get(domain);
    const sinceHeader = lastCrawled ? lastCrawled.last_crawled : null;
    const isIncremental = !!sinceHeader;

    try {
      await rateLimit(domain);
      const rawData = await fetchJSON(`${baseUrl}/kirin/content?limit=200`, 15000, sinceHeader);
      if (Array.isArray(rawData)) {
        contentItems = rawData;
      } else if (rawData && Array.isArray(rawData.items)) {
        contentItems = rawData.items;
      }
    } catch (err) {
      console.log(`[Crawler] Content fetch failed for ${domain}: ${err.message}`);
      // If we couldn't get content at all, this crawl is useless
      if (!profile) {
        updateCrawlStatus(domain, `Content fetch failed: ${err.message}`);
        return false;
      }
    }

    // Step 4: Verify thumbnails (non-blocking, best-effort)
    const validThumbnails = new Map();
    const thumbPromises = [];
    for (const item of contentItems) {
      if (item.thumbnail) {
        const thumbUrl = item.thumbnail.startsWith('http')
          ? item.thumbnail
          : `${baseUrl}${item.thumbnail}`;
        thumbPromises.push(
          verifyThumbnail(thumbUrl).then((valid) => {
            validThumbnails.set(item.id, valid ? thumbUrl : '');
          }).catch(() => {
            validThumbnails.set(item.id, '');
          })
        );
      }
    }
    // Wait for thumbnail checks (with timeout)
    await Promise.race([
      Promise.allSettled(thumbPromises),
      new Promise((resolve) => setTimeout(resolve, 10000)),
    ]);

    // Step 5: Store in SQLite
    const identityId = adrp.identity ? adrp.identity.id : null;
    const nodeId = profile ? (profile.id || identityId || domain) : (identityId || domain);
    const identityNick = adrp.identity ? adrp.identity.nick : null;

    // Upsert user
    db.prepare(`
      INSERT INTO users (id, domain, nickname, bio, avatar, port, last_crawled, crawl_error, crawl_count)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), NULL, 1)
      ON CONFLICT(id) DO UPDATE SET
        domain = excluded.domain,
        nickname = excluded.nickname,
        bio = excluded.bio,
        avatar = excluded.avatar,
        port = excluded.port,
        last_crawled = datetime('now'),
        crawl_error = NULL,
        crawl_count = crawl_count + 1
    `).run(
      nodeId,
      domain,
      profile ? profile.nickname : (identityNick || domain.split('.')[0]),
      profile ? (profile.bio || '') : '',
      profile ? (profile.avatar || '') : '',
      port
    );

    // Delete old content for this domain (full sync)
    db.prepare('DELETE FROM content WHERE domain = ?').run(domain);

    // Insert content
    const insertContent = db.prepare(`
      INSERT OR REPLACE INTO content (id, node_id, domain, title, type, url, thumbnail, description, file_size, mime_type, views)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    for (const item of contentItems) {
      const contentId = item.id || `${domain}:${item.title}`;
      const verifiedThumb = validThumbnails.get(item.id) || '';
      // Handle both 'type' (current User Node) and 'category' (spec)
      const contentType = item.type || item.category || 'unknown';

      insertContent.run(
        contentId,
        nodeId,
        domain,
        item.title,
        contentType,
        item.url,
        verifiedThumb,
        item.description || '',
        item.file_size || 0,
        item.mime_type || ''
      );
    }

    const syncMode = isIncremental ? 'incremental' : 'full';
    const result = profile ? 'profile + content' : 'content only';
    console.log(`[Crawler] ${domain}: ${syncMode} sync, ${result} -- ${contentItems.length} items indexed`);
    return true;

  } catch (err) {
    console.log(`[Crawler] Error crawling ${domain}: ${err.message}`);
    updateCrawlStatus(domain, err.message);
    return false;
  }
}

// --- Crawl multiple domains with rate limiting ---

async function crawlDomains(domains, concurrency = 3) {
  const results = [];

  for (let i = 0; i < domains.length; i += concurrency) {
    const batch = domains.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(crawlUserNode));
    results.push(...batchResults);

    // Brief pause between batches to avoid overwhelming DNS
    if (i + concurrency < domains.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const success = results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
  const failed = results.length - success;

  console.log(`[Crawler] Done: ${success} succeeded, ${failed} failed out of ${results.length}`);
  return { success, failed, total: results.length };
}

// --- Discover domains from a seed list ---

async function discoverDomains(seedFile) {
  try {
    const data = fs.readFileSync(seedFile, 'utf-8');
    return data
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'));
  } catch {
    console.log(`[Crawler] Could not read seed file: ${seedFile}`);
    return [];
  }
}

// --- Increment view count (called by the API when content is accessed) ---

function incrementView(contentId) {
  db.prepare('UPDATE content SET views = views + 1 WHERE id = ?').run(contentId);
}

// --- CLI mode ---

if (require.main === module) {
  const arg = process.argv[2];

  if (arg) {
    // Try as domain first, fall back to seed file
    if (arg.includes('.')) {
      crawlUserNode(arg).then((success) => {
        process.exit(success ? 0 : 1);
      });
    } else {
      discoverDomains(arg).then((domains) => {
        crawlDomains(domains).then((result) => {
          process.exit(result.failed > 0 ? 1 : 0);
        });
      });
    }
  } else {
    console.log('Usage:');
    console.log('  node crawler.js <domain>        # Crawl a single domain');
    console.log('  node crawler.js <seed-file>     # Crawl domains from file');
  }
}

module.exports = { crawlUserNode, crawlDomains, resolveKirinDNS, discoverDomains, incrementView, db };

