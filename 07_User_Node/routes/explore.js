// KirinNet User Node — Explore Module
// Direction CRUD + Crawl trigger + Results management + Blacklist management
const express = require('express');
const crypto = require('crypto');
const { isBlacklisted } = require('../lib/segment-hash');

const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

// Lazy auth middleware — defers to the real one injected via set_db
function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---- Schema initialization ----------------------------------------------------
async function initExploreSchema() {
  await db.exec(`
    CREATE SEQUENCE IF NOT EXISTS explore_directions_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS explore_results_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS explore_blacklist_seq START 1;

    -- Explore directions (preset + custom)
    CREATE TABLE IF NOT EXISTS explore_directions (
      id          INTEGER PRIMARY KEY DEFAULT nextval('explore_directions_seq'),
      direction_name VARCHAR NOT NULL,
      keywords    VARCHAR NOT NULL,
      icon        VARCHAR DEFAULT '',
      is_preset   BOOLEAN DEFAULT FALSE,
      is_active   BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Exploration results
    CREATE TABLE IF NOT EXISTS explore_results (
      id            INTEGER PRIMARY KEY DEFAULT nextval('explore_results_seq'),
      direction_id  INTEGER NOT NULL,
      title         VARCHAR NOT NULL,
      url           VARCHAR DEFAULT '',
      summary       TEXT DEFAULT '',
      source_domain VARCHAR DEFAULT '',
      tags          VARCHAR DEFAULT '',
      content_hash  VARCHAR(64) NOT NULL,
      saved         BOOLEAN DEFAULT FALSE,
      collected_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_er_direction ON explore_results(direction_id);
    CREATE INDEX IF NOT EXISTS idx_er_hash ON explore_results(content_hash);
    CREATE INDEX IF NOT EXISTS idx_er_collected ON explore_results(collected_at);

    -- Explore blacklist (pattern-based)
    CREATE TABLE IF NOT EXISTS explore_blacklist (
      id          INTEGER PRIMARY KEY DEFAULT nextval('explore_blacklist_seq'),
      pattern     VARCHAR NOT NULL,
      reason      VARCHAR DEFAULT '',
      is_active   BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed preset directions if table is empty
  const count = await db.get('SELECT COUNT(*)::INTEGER AS cnt FROM explore_directions');
  if (count.cnt === 0) {
    const presets = [
      { name: '科技数码', keywords: 'AI,人工智能,编程,开源,芯片', icon: '💻' },
      { name: '人文历史', keywords: '历史,哲学,文化,考古,文明', icon: '📚' },
      { name: '经济金融', keywords: '经济,金融,股市,投资,货币', icon: '💰' },
      { name: '自然科学', keywords: '物理,生物,化学,天文,地理', icon: '🔬' },
      { name: '艺术设计', keywords: '艺术,设计,绘画,音乐,建筑', icon: '🎨' },
    ];
    for (const p of presets) {
      await db.run(
        'INSERT INTO explore_directions (direction_name, keywords, icon, is_preset) VALUES (?, ?, ?, TRUE)',
        p.name, p.keywords, p.icon
      );
    }
  }
}

// ---- Direction Management -----------------------------------------------------

// POST /api/explore/directions — create custom direction (auth required)
router.post('/explore/directions', requireAuth, asyncHandler(async (req, res) => {
  const { direction_name, keywords, icon } = req.body;
  if (!direction_name || !keywords) {
    return res.status(400).json({ error: 'direction_name and keywords required' });
  }
  const rows = await db.all(
    'INSERT INTO explore_directions (direction_name, keywords, icon, is_preset) VALUES (?, ?, ?, FALSE) RETURNING id',
    direction_name, keywords, icon || ''
  );
  const id = rows[0].id;
  const created = await db.get('SELECT * FROM explore_directions WHERE id = ?', id);
  res.status(201).json(created);
}));

// GET /api/explore/directions — list all directions (preset + custom)
router.get('/explore/directions', asyncHandler(async (_req, res) => {
  const directions = await db.all(
    'SELECT id, direction_name, keywords, icon, is_preset, is_active, created_at FROM explore_directions ORDER BY is_preset DESC, id ASC'
  );
  res.json(directions);
}));

// PUT /api/explore/directions/:id — update direction (auth required)
router.put('/explore/directions/:id', requireAuth, asyncHandler(async (req, res) => {
  const dir = await db.get('SELECT * FROM explore_directions WHERE id = ?', req.params.id);
  if (!dir) return res.status(404).json({ error: 'direction_not_found' });

  const { is_active, keywords, icon, direction_name } = req.body;

  if (is_active !== undefined) {
    await db.run('UPDATE explore_directions SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      is_active, req.params.id);
  }
  if (keywords !== undefined) {
    await db.run('UPDATE explore_directions SET keywords = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      keywords, req.params.id);
  }
  if (icon !== undefined) {
    await db.run('UPDATE explore_directions SET icon = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      icon, req.params.id);
  }
  if (direction_name !== undefined) {
    await db.run('UPDATE explore_directions SET direction_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      direction_name, req.params.id);
  }

  const updated = await db.get('SELECT * FROM explore_directions WHERE id = ?', req.params.id);
  res.json(updated);
}));

// DELETE /api/explore/directions/:id — delete custom direction (auth required)
router.delete('/explore/directions/:id', requireAuth, asyncHandler(async (req, res) => {
  const dir = await db.get('SELECT * FROM explore_directions WHERE id = ?', req.params.id);
  if (!dir) return res.status(404).json({ error: 'direction_not_found' });
  if (dir.is_preset) {
    return res.status(403).json({ error: 'cannot_delete_preset_direction' });
  }
  await db.run('DELETE FROM explore_directions WHERE id = ?', req.params.id);
  res.status(204).send();
}));

// ---- Exploration Execution ----------------------------------------------------

// POST /api/explore/crawl — trigger exploration for a direction
router.post('/explore/crawl', requireAuth, asyncHandler(async (req, res) => {
  const { direction_id } = req.body;
  if (!direction_id) return res.status(400).json({ error: 'direction_id required' });

  // 1. Get direction and its keywords
  const dir = await db.get('SELECT * FROM explore_directions WHERE id = ?', direction_id);
  if (!dir) return res.status(404).json({ error: 'direction_not_found' });
  if (!dir.is_active) return res.status(400).json({ error: 'direction_inactive' });

  const keywords = dir.keywords.split(',').map(k => k.trim()).filter(Boolean);
  if (keywords.length === 0) return res.status(400).json({ error: 'no_keywords_defined' });

  // 2. Get active blacklist patterns
  const blacklistRows = await db.all('SELECT pattern, reason FROM explore_blacklist WHERE is_active = TRUE');
  const blacklistPatterns = blacklistRows.map(r => ({ pattern: r.pattern, reason: r.reason || '' }));

  let crawled = 0;
  let newCount = 0;
  let skippedBlacklist = 0;
  let skippedDup = 0;

  // 3. For each keyword, search indexed_content
  const seenHashes = new Set(); // in-memory dedup within this crawl session

  for (const kw of keywords) {
    // DuckDB: use LOWER() + LIKE instead of ILIKE
    const kwPattern = `%${kw.toLowerCase()}%`;
    const results = await db.all(
      `SELECT id, cid, title, COALESCE(description, '') AS description, COALESCE(tags, '') AS tags,
              creator_domain, created_at
       FROM indexed_content
       WHERE is_indexed = TRUE
         AND (LOWER(title) LIKE ? OR LOWER(COALESCE(description, '')) LIKE ? OR LOWER(COALESCE(tags, '')) LIKE ?)
       ORDER BY created_at DESC LIMIT 50`,
      kwPattern, kwPattern, kwPattern
    );

    for (const item of results) {
      crawled++;

      // 4. Blacklist filtering
      const checkText = item.title + ' ' + item.description + ' ' + item.tags;
      const blResult = isBlacklisted(checkText, blacklistPatterns);
      if (blResult.isBlocked) {
        skippedBlacklist++;
        continue;
      }

      // 5. Content dedup: SHA-256(title + summary)
      const summary = (item.description || '').substring(0, 200);
      const contentHash = crypto.createHash('sha256')
        .update(item.title + summary, 'utf8')
        .digest('hex');

      // Check in-memory dedup
      if (seenHashes.has(contentHash)) {
        skippedDup++;
        continue;
      }
      seenHashes.add(contentHash);

      // Check DB dedup
      const existing = await db.get(
        'SELECT id FROM explore_results WHERE content_hash = ?', contentHash
      );
      if (existing) {
        skippedDup++;
        continue;
      }

      // 6. Insert into explore_results
      await db.run(
        `INSERT INTO explore_results (direction_id, title, url, summary, source_domain, tags, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        direction_id,
        item.title,
        item.cid ? `kirin://${item.creator_domain}/${item.cid}` : '',
        summary,
        item.creator_domain || '',
        item.tags || '',
        contentHash
      );
      newCount++;
    }
  }

  res.status(202).json({
    direction_id,
    direction_name: dir.direction_name,
    crawled,
    new: newCount,
    skipped_blacklist: skippedBlacklist,
    skipped_dup: skippedDup,
  });
}));

// ---- Results Browsing ---------------------------------------------------------

// GET /api/explore/results — browse collected results
router.get('/explore/results', asyncHandler(async (req, res) => {
  const direction_id = req.query.direction_id || null;
  const saved_only = req.query.saved_only === 'true' || req.query.saved_only === '1';
  const limit = Math.min(+req.query.limit || 20, 100);
  const offset = +req.query.offset || 0;

  let where = 'WHERE 1=1';
  const params = [];

  if (direction_id) { where += ' AND direction_id = ?'; params.push(direction_id); }
  if (saved_only) { where += ' AND saved = TRUE'; }

  const total = await db.get(
    `SELECT COUNT(*)::INTEGER AS cnt FROM explore_results ${where}`, ...params
  );

  const results = await db.all(
    `SELECT id, direction_id, title, url, summary, source_domain, tags, saved, collected_at
     FROM explore_results ${where}
     ORDER BY collected_at DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );

  res.json({ total: total.cnt, limit, offset, results });
}));

// POST /api/explore/results/:id/save — mark as saved
router.post('/explore/results/:id/save', asyncHandler(async (req, res) => {
  const item = await db.get('SELECT id FROM explore_results WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'result_not_found' });
  await db.run('UPDATE explore_results SET saved = TRUE WHERE id = ?', req.params.id);
  res.json({ id: +req.params.id, is_saved: true });
}));

// POST /api/explore/results/:id/unsave — unmark saved
router.post('/explore/results/:id/unsave', asyncHandler(async (req, res) => {
  const item = await db.get('SELECT id FROM explore_results WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'result_not_found' });
  await db.run('UPDATE explore_results SET saved = FALSE WHERE id = ?', req.params.id);
  res.json({ id: +req.params.id, is_saved: false });
}));

// DELETE /api/explore/results/:id — delete result (auth required)
router.delete('/explore/results/:id', requireAuth, asyncHandler(async (req, res) => {
  const item = await db.get('SELECT id FROM explore_results WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'result_not_found' });
  await db.run('DELETE FROM explore_results WHERE id = ?', req.params.id);
  res.status(204).send();
}));

// ---- Stats --------------------------------------------------------------------

// GET /api/explore/stats
router.get('/explore/stats', asyncHandler(async (_req, res) => {
  const totalDirections = await db.get('SELECT COUNT(*)::INTEGER AS cnt FROM explore_directions');
  const activeDirections = await db.get('SELECT COUNT(*)::INTEGER AS cnt FROM explore_directions WHERE is_active = TRUE');
  const totalResults = await db.get('SELECT COUNT(*)::INTEGER AS cnt FROM explore_results');
  const savedResults = await db.get('SELECT COUNT(*)::INTEGER AS cnt FROM explore_results WHERE is_saved = TRUE');

  res.json({
    total_directions: totalDirections.cnt,
    active_directions: activeDirections.cnt,
    total_results: totalResults.cnt,
    saved_results: savedResults.cnt,
  });
}));

// ---- Blacklist Management -----------------------------------------------------

// GET /api/explore/blacklist
router.get('/explore/blacklist', asyncHandler(async (_req, res) => {
  const items = await db.all(
    'SELECT id, pattern, reason, is_active, created_at FROM explore_blacklist ORDER BY id ASC'
  );
  res.json(items);
}));

// POST /api/explore/blacklist — add pattern (auth required)
router.post('/explore/blacklist', requireAuth, asyncHandler(async (req, res) => {
  const { pattern, reason } = req.body;
  if (!pattern) return res.status(400).json({ error: 'pattern required' });

  const rows = await db.all(
    'INSERT INTO explore_blacklist (pattern, reason) VALUES (?, ?) RETURNING id',
    pattern, reason || ''
  );
  const created = await db.get('SELECT * FROM explore_blacklist WHERE id = ?', rows[0].id);
  res.status(201).json(created);
}));

// PUT /api/explore/blacklist/:id — toggle active (auth required)
router.put('/explore/blacklist/:id', requireAuth, asyncHandler(async (req, res) => {
  const item = await db.get('SELECT id FROM explore_blacklist WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'blacklist_entry_not_found' });

  const { is_active, pattern, reason } = req.body;

  if (is_active !== undefined) {
    await db.run('UPDATE explore_blacklist SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      is_active, req.params.id);
  }
  if (pattern !== undefined) {
    await db.run('UPDATE explore_blacklist SET pattern = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      pattern, req.params.id);
  }
  if (reason !== undefined) {
    await db.run('UPDATE explore_blacklist SET reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      reason, req.params.id);
  }

  const updated = await db.get('SELECT * FROM explore_blacklist WHERE id = ?', req.params.id);
  res.json(updated);
}));

// DELETE /api/explore/blacklist/:id — delete pattern (auth required)
router.delete('/explore/blacklist/:id', requireAuth, asyncHandler(async (req, res) => {
  const item = await db.get('SELECT id FROM explore_blacklist WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'blacklist_entry_not_found' });
  await db.run('DELETE FROM explore_blacklist WHERE id = ?', req.params.id);
  res.status(204).send();
}));

module.exports = { router, set_db, initExploreSchema };
