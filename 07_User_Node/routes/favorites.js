// KirinNet User Node — Favorites / Bookmarks
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// POST /api/favorites — add favorite
router.post('/favorites', requireAuth, asyncHandler(async (req, res) => {
  const { content_id, domain } = req.body;
  if (!content_id) return res.status(400).json({ error: 'missing_content_id' });
  if (!domain) return res.status(400).json({ error: 'missing_domain' });

  const row = await db.get(
    `INSERT INTO favorites (content_id, domain) VALUES (?, ?)
     ON CONFLICT(content_id, domain) DO NOTHING
     RETURNING id, created_at`,
    content_id, domain
  );

  if (!row) {
    // Already exists, fetch existing
    const existing = await db.get(
      'SELECT id, created_at FROM favorites WHERE content_id = ? AND domain = ?',
      content_id, domain
    );
    return res.status(201).json({
      id: existing.id,
      content_id,
      domain,
      created_at: existing.created_at,
    });
  }

  res.status(201).json({
    id: row.id,
    content_id,
    domain,
    created_at: row.created_at,
  });
}));

// GET /api/favorites?domain= — list favorites
router.get('/favorites', asyncHandler(async (req, res) => {
  const { domain } = req.query;
  let rows;
  if (domain) {
    rows = await db.all(
      'SELECT id, content_id, domain, created_at FROM favorites WHERE domain = ? ORDER BY created_at DESC',
      domain
    );
  } else {
    rows = await db.all(
      'SELECT id, content_id, domain, created_at FROM favorites ORDER BY created_at DESC'
    );
  }
  res.json(rows);
}));

// DELETE /api/favorites/:id — remove favorite
router.delete('/favorites/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM favorites WHERE id = ?', req.params.id);
  res.status(204).send();
}));

// GET /api/favorites/check/:contentId?domain= — check if favorited
router.get('/favorites/check/:contentId', asyncHandler(async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'missing_domain' });

  const row = await db.get(
    'SELECT id FROM favorites WHERE content_id = ? AND domain = ?',
    req.params.contentId, domain
  );
  res.json({ favorited: !!row });
}));

module.exports = { router, set_db };
