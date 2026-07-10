// KirinNet — Indexer Module (optional, gated by settings.public_indexing)
// Content aggregation, search, marketplace display. Trusts DNS (open indexer).
const express = require('express');
const router = express.Router();
let db;
let indexEnabled = true;

function set_db(d) { db = d; }
function setIndexEnabled(val) { indexEnabled = val; }

function checkIndex(req, res, next) {
  if (!indexEnabled) return res.status(403).json({ error: 'indexing_disabled', message: 'Node owner has not enabled public indexing' });
  next();
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(e => res.status(500).json({ error: e.message }));

// All indexer routes use this guard
router.use(checkIndex);

// ---- Admin auth (same Bearer) -------------------------------------------------
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'unauthorized' });
  // reuse kirin's requireAuth via db helpers — inject at module level
  if (!_requireAuthFn) return res.status(500).json({ error: 'admin_auth_not_configured' });
  return _requireAuthFn(req, res, next);
}
let _requireAuthFn = null;
function setRequireAuth(fn) { _requireAuthFn = fn; }

// ---- Blacklist helpers --------------------------------------------------------
async function isBlacklisted(domain) {
  const row = await db.get('SELECT 1 FROM push_blacklist WHERE domain = ?', domain);
  return !!row;
}

// ---- Initialize indexed_content table -----------------------------------------
async function initIndexer() {
  await db.exec(`
    CREATE SEQUENCE IF NOT EXISTS indexed_content_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS ingestion_log_seq START 1;
    CREATE TABLE IF NOT EXISTS indexed_content (
      id            INTEGER PRIMARY KEY DEFAULT nextval('indexed_content_seq'),
      cid           VARCHAR NOT NULL UNIQUE,
      storage_type  VARCHAR DEFAULT 'ipfs',
      content_type  VARCHAR DEFAULT 'article',
      title         VARCHAR NOT NULL,
      description   TEXT,
      category      VARCHAR DEFAULT 'other',
      tags          JSON,
      creator_domain VARCHAR NOT NULL,
      creator_key   VARCHAR,
      signature     VARCHAR,
      thumbnail_cid VARCHAR,
      comment_permission VARCHAR DEFAULT 'all',
      view_count    INTEGER DEFAULT 0,
      is_indexed    BOOLEAN DEFAULT true,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ingestion_log (
      id          INTEGER PRIMARY KEY DEFAULT nextval('ingestion_log_seq'),
      content_id  INTEGER NOT NULL,
      action      VARCHAR NOT NULL,
      source_node VARCHAR,
      cid         VARCHAR,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ic_creator    ON indexed_content(creator_domain);
    CREATE INDEX IF NOT EXISTS idx_ic_category   ON indexed_content(category);
    CREATE INDEX IF NOT EXISTS idx_ic_created    ON indexed_content(created_at);
    CREATE INDEX IF NOT EXISTS idx_ic_indexed    ON indexed_content(is_indexed);
  `);
}

// ---- Publish (receive content push from external nodes) ----------------------
// POST /api/indexer/publish
// Same contract as old /api/v1/publish — domain=identity, no auth
router.post('/indexer/publish', asyncHandler(async (req, res) => {
  const { cid, storage_type, content_type, title, description, category, tags,
          creator_domain, creator_key, signature, thumbnail_cid, comment_permission } = req.body;
  if (!cid || !title || !creator_domain) {
    return res.status(400).json({ error: 'cid, title, creator_domain required' });
  }

  // Block blacklisted domains
  if (await isBlacklisted(creator_domain)) {
    return res.status(403).json({ error: 'domain_blacklisted', domain: creator_domain });
  }

  // Upsert: update if same cid, else insert
  const existing = await db.get('SELECT id FROM indexed_content WHERE cid = ?', cid);
  let id;
  if (existing) {
    await db.run(`UPDATE indexed_content SET title=?, description=?, category=?, tags=?, updated_at=CURRENT_TIMESTAMP
                  WHERE id=?`,
      title, description||null, category||'other', JSON.stringify(tags||[]), existing.id);
    id = existing.id;
  } else {
    const rows = await db.all(
      `INSERT INTO indexed_content (cid,storage_type,content_type,title,description,category,tags,
        creator_domain,creator_key,signature,thumbnail_cid,comment_permission)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      cid, storage_type||'ipfs', content_type||'article', title, description||null,
      category||'other', JSON.stringify(tags||[]), creator_domain, creator_key||'',
      signature||'', thumbnail_cid||null, comment_permission||'all');
    id = rows[0].id;
  }

  await db.run("INSERT INTO ingestion_log (content_id,action,source_node,cid) VALUES (?,?,?,?)",
    id, 'indexed', creator_domain, cid);

  res.status(201).json({ content_id: String(id), cid, title, creator_domain, action: existing ? 'updated' : 'created' });
}));

// ---- Search ------------------------------------------------------------------
// GET /api/indexer/search?q=...&category=...&sort=newest&limit=20&offset=0
router.get('/indexer/search', asyncHandler(async (req, res) => {
  const q = req.query.q || '', category = req.query.category || null;
  const sort = req.query.sort || 'newest';
  const limit = Math.min(+req.query.limit || 20, 100);
  const offset = Math.max(+req.query.offset || 0, 0);

  let where = "WHERE is_indexed = true", params = [];
  if (q) { where += " AND (title ILIKE ? OR COALESCE(description,'') ILIKE ?)"; params.push(`%${q}%`, `%${q}%`); }
  if (category) { where += ' AND category = ?'; params.push(category); }

  let order = 'ORDER BY created_at DESC';
  if (sort === 'oldest') order = 'ORDER BY created_at ASC';
  else if (sort === 'views') order = 'ORDER BY view_count DESC, created_at DESC';

  const total = (await db.get(`SELECT COUNT(*)::INTEGER AS total FROM indexed_content ${where}`, ...params)).total;
  const results = await db.all(`SELECT * FROM indexed_content ${where} ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  res.json({ total, limit, offset, results });
}));

// GET /api/indexer/swipe?limit=10&cursor=123
router.get('/indexer/swipe', asyncHandler(async (req, res) => {
  const limit = Math.min(30, Math.max(1, +req.query.limit || 10));
  const cursor = req.query.cursor ? +req.query.cursor : null;
  let sql = 'SELECT * FROM indexed_content WHERE is_indexed = true', params = [];
  if (cursor) { sql += ' AND id < ?'; params.push(cursor); }
  sql += ' ORDER BY id DESC LIMIT ?'; params.push(limit + 1);

  const items = await db.all(sql, ...params);
  const hasMore = items.length > limit;
  const results = hasMore ? items.slice(0, limit) : items;
  res.json({ items: results, hasMore, nextCursor: results.length ? String(results[results.length-1].id) : null });
}));

// GET /api/indexer/trending
router.get('/indexer/trending', asyncHandler(async (req, res) => {
  const results = await db.all(
    "SELECT * FROM indexed_content WHERE is_indexed=true AND created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days' ORDER BY view_count DESC LIMIT 50");
  res.json({ period: '7d', results });
}));

// GET /api/indexer/suggest?q=...
router.get('/indexer/suggest', asyncHandler(async (req, res) => {
  const q = req.query.q || '';
  const rows = await db.all('SELECT DISTINCT title FROM indexed_content WHERE title ILIKE ? LIMIT 10', `%${q}%`);
  res.json({ suggestions: rows.map(r => r.title) });
}));

// GET /api/indexer/view/:id — increment view count + return
router.get('/indexer/view/:id', asyncHandler(async (req, res) => {
  await db.run('UPDATE indexed_content SET view_count = view_count + 1 WHERE id = ?', req.params.id);
  const item = await db.get('SELECT * FROM indexed_content WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  res.json(item);
}));

// GET /api/indexer/ads?page=1 — show active ad slots for a page
router.get('/indexer/ads', asyncHandler(async (req, res) => {
  const page = +req.query.page || 1;
  const perPage = 2;
  // Calculate slot numbers for this page: page 1 → slots 1,2; page 2 → slots 3,4...
  const startSlot = (page - 1) * perPage + 1;
  const endSlot = startSlot + perPage - 1;
  const today = new Date().toISOString().slice(0,10);

  const ads = await db.all(
    `SELECT * FROM ad_slot_products
     WHERE slot_number BETWEEN ? AND ?
     AND status = 'sold'
     AND slot_start_date <= ? AND slot_end_date >= ?
     ORDER BY slot_number`,
    startSlot, endSlot, today, today);

  // Decorate with winner info
  const decorated = ads.map(a => ({
    slot: a.slot_number,
    page,
    date_range: `${a.slot_start_date} ~ ${a.slot_end_date}`,
    advertiser_domain: a.bidder_domain,
    price: a.current_bid,
  }));

  res.json({ page, per_page: perPage, ads: decorated });
}));

// ---- Admin: Hide/Show content -------------------------------------------------
// POST /api/indexer/hide/:id — hide indexed content from search/display
router.post('/indexer/hide/:id', requireAdmin, asyncHandler(async (req, res) => {
  const item = await db.get('SELECT id, title, creator_domain FROM indexed_content WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  await db.run('UPDATE indexed_content SET is_indexed = false WHERE id = ?', req.params.id);
  await db.run("INSERT INTO ingestion_log (content_id, action, source_node, cid) VALUES (?,'hidden','admin',?)",
    req.params.id, item.creator_domain);
  res.json({ status: 'hidden', id: +req.params.id, title: item.title });
}));

// POST /api/indexer/show/:id — restore hidden content
router.post('/indexer/show/:id', requireAdmin, asyncHandler(async (req, res) => {
  const item = await db.get('SELECT id, title FROM indexed_content WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  await db.run('UPDATE indexed_content SET is_indexed = true WHERE id = ?', req.params.id);
  await db.run("INSERT INTO ingestion_log (content_id, action, source_node, cid) VALUES (?,'shown','admin','')",
    req.params.id);
  res.json({ status: 'shown', id: +req.params.id, title: item.title });
}));

// GET /api/indexer/admin/flagged — content from blacklisted domains or hidden
router.get('/indexer/admin/flagged', requireAdmin, asyncHandler(async (req, res) => {
  const hidden = await db.all('SELECT * FROM indexed_content WHERE is_indexed = false ORDER BY created_at DESC LIMIT 100');
  const blacklistedDomains = await db.all('SELECT domain FROM push_blacklist ORDER BY created_at');
  const fromBlacklisted = await db.all(
    `SELECT * FROM indexed_content WHERE creator_domain IN (${blacklistedDomains.map(()=>'?').join(',')}) AND is_indexed = true ORDER BY created_at DESC LIMIT 100`,
    ...blacklistedDomains.map(d => d.domain)
  );
  res.json({
    hidden_count: hidden.length,
    hidden,
    blacklisted_domains: blacklistedDomains.map(d => d.domain),
    from_blacklisted: fromBlacklisted,
  });
}));

// ---- Admin: Domain blacklist --------------------------------------------------
// GET /api/indexer/blacklist
router.get('/indexer/blacklist', requireAdmin, asyncHandler(async (_req, res) => {
  const list = await db.all('SELECT * FROM push_blacklist ORDER BY created_at DESC');
  res.json({ total: list.length, domains: list });
}));

// POST /api/indexer/blacklist
router.post('/indexer/blacklist', requireAdmin, asyncHandler(async (req, res) => {
  const { domain, reason } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  await db.run('INSERT OR REPLACE INTO push_blacklist (domain, reason) VALUES (?, ?)',
    domain.toLowerCase(), reason || '');
  // Also hide existing content from this domain
  await db.run('UPDATE indexed_content SET is_indexed = false WHERE creator_domain = ?', domain.toLowerCase());
  res.status(201).json({ status: 'blacklisted', domain: domain.toLowerCase(), reason: reason || '' });
}));

// DELETE /api/indexer/blacklist/:domain
router.delete('/indexer/blacklist/:domain', requireAdmin, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM push_blacklist WHERE domain = ?', req.params.domain.toLowerCase());
  res.json({ status: 'unblocked', domain: req.params.domain.toLowerCase() });
}));

module.exports = { router, set_db, setIndexEnabled, initIndexer, setRequireAuth };
