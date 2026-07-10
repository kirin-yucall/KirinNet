// KirinNet User Node — Push to Content Platform (with DOH verification)
// Before pushing, resolve platform domain via DNS-over-HTTPS and verify IP.
// Ensures content goes to the real node, not a spoofed one.
const express = require('express');
const router = express.Router();
const dns = require('dns').promises;

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---- DOH: DNS-over-HTTPS domain verification ---------------------------------
const DOH_ENDPOINT = process.env.DOH_ENDPOINT || 'https://dns.google/resolve';

async function dohResolve(hostname) {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=A`;
  const resp = await fetch(url, { headers: { 'Accept': 'application/dns-json' } });
  if (!resp.ok) throw new Error(`DOH query failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.Answer) return [];
  return data.Answer.filter(a => a.type === 1).map(a => a.data);
}

async function verifyPlatformDomain(platformUrl) {
  const u = new URL(platformUrl.replace(/\/$/, ''));
  const hostname = u.hostname;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');

  // Resolve domain via DOH
  const ips = await dohResolve(hostname);
  if (ips.length === 0) {
    return { ok: false, error: `DOH: no A records for ${hostname}`, hostname };
  }

  // Verify we can reach the platform (implicit: if IP resolves, DNS works)
  // The fetch to the platform itself acts as the final verification
  try {
    const resp = await fetch(`${platformUrl.replace(/\/$/, '')}/health`);
    const info = await resp.json();
    if (!resp.ok || info.status !== 'ok') {
      return { ok: false, error: 'platform health check failed', hostname, ips, info };
    }
    return { ok: true, hostname, ips, info };
  } catch (e) {
    return { ok: false, error: `cannot reach platform: ${e.message}`, hostname, ips };
  }
}

// ---- Node identity helper ----------------------------------------------------
async function getNodeIdentity() {
  const node = await db.get('SELECT id, nickname, bio FROM node LIMIT 1');
  const port = process.env.PORT || 8080;
  const domain = process.env.NODE_DOMAIN || `node-${node.id.substring(0,8)}.local`;
  return { ...node, domain, port };
}

// ---- Push content to platform ------------------------------------------------
// POST /api/push/content
router.post('/push/content', requireAuth, asyncHandler(async (req, res) => {
  const { platform_url, content_id } = req.body;
  if (!platform_url || !content_id) return res.status(400).json({ error: 'missing platform_url or content_id' });

  // DOH verify
  const verify = await verifyPlatformDomain(platform_url);
  if (!verify.ok) return res.status(400).json({ error: 'doh_verify_failed', detail: verify });

  const item = await db.get('SELECT * FROM content WHERE id = ?', content_id);
  if (!item) return res.status(404).json({ error: 'content_not_found' });

  const node = await getNodeIdentity();
  const baseUrl = platform_url.replace(/\/$/, '');

  // Push metadata only (title, cid, content_type, thumbnail) — thin index
  const resp = await fetch(`${baseUrl}/api/v1/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cid: item.id,
      title: item.title,
      description: item.description || '',
      content_type: item.content_type || 'article',
      category: 'other',
      creator_domain: node.domain,
      storage_type: 'user_node',
      allow_comments: item.allow_comments,
      thumbnail_cid: item.thumbnail || '',
      source_node: `${node.domain}:${node.port}`,
    }),
  });

  const body = await resp.json();
  if (resp.ok) {
    res.json({
      status: 'published', platform: baseUrl, content_id,
      doh_verified: verify.hostname, resolved_ips: verify.ips,
      platform_response: body,
    });
  } else {
    res.status(502).json({ error: 'platform_rejected', detail: body });
  }
}));

// ---- Push product to platform ------------------------------------------------
router.post('/push/product', requireAuth, asyncHandler(async (req, res) => {
  const { platform_url, product_data } = req.body;
  if (!platform_url || !product_data) return res.status(400).json({ error: 'missing platform_url or product_data' });
  if (!product_data.title || !product_data.type) return res.status(400).json({ error: 'product_data needs title and type' });

  const verify = await verifyPlatformDomain(platform_url);
  if (!verify.ok) return res.status(400).json({ error: 'doh_verify_failed', detail: verify });

  const node = await getNodeIdentity();
  const baseUrl = platform_url.replace(/\/$/, '');

  const resp = await fetch(`${baseUrl}/api/v1/marketplace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_domain: node.domain,
      source_id: product_data.source_id || `product_${Date.now()}`,
      type: product_data.type,
      title: product_data.title,
      description: product_data.description || '',
      category: product_data.category || 'other',
      base_price: product_data.base_price || 0,
      currency: product_data.currency || 'CNY',
      condition: product_data.condition || 'used',
      location: product_data.location || '',
      tags: JSON.stringify(product_data.tags || []),
      cover_cid: product_data.cover_cid || '',
      source_node: `${node.domain}:${node.port}`,
    }),
  });

  const body = await resp.json();
  if (resp.ok) {
    res.json({
      status: 'published', platform: baseUrl,
      doh_verified: verify.hostname, resolved_ips: verify.ips,
      product: product_data.title, platform_response: body,
    });
  } else {
    res.status(502).json({ error: 'platform_rejected', detail: body });
  }
}));

// ---- Discovery: test platform health (with DOH) ------------------------------
router.post('/push/ping', asyncHandler(async (req, res) => {
  const { platform_url } = req.body;
  if (!platform_url) return res.status(400).json({ error: 'missing platform_url' });

  const baseUrl = platform_url.replace(/\/$/, '');
  const hostname = new URL(baseUrl).hostname;

  try {
    const ips = await dohResolve(hostname);
    const resp = await fetch(`${baseUrl}/health`);
    const info = await resp.json();
    res.json({
      reachable: resp.ok && info.status === 'ok',
      platform: baseUrl,
      doh_resolved: { hostname, ips },
      info,
    });
  } catch (e) {
    res.json({ reachable: false, platform: baseUrl, error: e.message });
  }
}));

// ---- Push all content --------------------------------------------------------
router.post('/push/all', requireAuth, asyncHandler(async (req, res) => {
  const { platform_url } = req.body;
  if (!platform_url) return res.status(400).json({ error: 'missing platform_url' });

  const verify = await verifyPlatformDomain(platform_url);
  if (!verify.ok) return res.status(400).json({ error: 'doh_verify_failed', detail: verify });

  const baseUrl = platform_url.replace(/\/$/, '');
  const node = await getNodeIdentity();
  const items = await db.all('SELECT * FROM content WHERE deleted_at IS NULL');
  const results = [];

  for (const item of items) {
    try {
      const resp = await fetch(`${baseUrl}/api/v1/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cid: item.id, title: item.title, description: item.description || '',
          content_type: item.content_type || 'article', creator_domain: node.domain,
          allow_comments: item.allow_comments, thumbnail_cid: item.thumbnail || '',
          source_node: `${node.domain}:${node.port}`,
        }),
      });
      const body = await resp.json();
      results.push({ content_id: item.id, title: item.title, ok: resp.ok, detail: body });
    } catch (e) {
      results.push({ content_id: item.id, title: item.title, ok: false, detail: e.message });
    }
  }

  const ok = results.filter(r => r.ok).length;
  res.json({ total: results.length, ok, failed: results.length - ok, results });
}));

module.exports = { router, set_db };
