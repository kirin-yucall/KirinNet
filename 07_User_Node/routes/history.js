// KirinNet User Node — Browsing History / 足迹
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// POST /api/history — record a view
router.post('/history', requireAuth, asyncHandler(async (req, res) => {
  const { content_id, domain } = req.body;
  if (!content_id) return res.status(400).json({ error: 'missing_content_id' });
  if (!domain) return res.status(400).json({ error: 'missing_domain' });

  const row = await db.get(
    'INSERT INTO history (content_id, domain) VALUES (?, ?) RETURNING id, viewed_at',
    content_id, domain
  );

  res.status(201).json({
    id: row.id,
    content_id,
    domain,
    viewed_at: row.viewed_at,
  });
}));

// GET /api/history?domain=&limit=&offset= — list history
router.get('/history', asyncHandler(async (req, res) => {
  const { domain, limit, offset } = req.query;
  const l = parseInt(limit) || 50;
  const o = parseInt(offset) || 0;

  let rows;
  if (domain) {
    rows = await db.all(
      'SELECT id, content_id, domain, viewed_at FROM history WHERE domain = ? ORDER BY viewed_at DESC LIMIT ? OFFSET ?',
      domain, l, o
    );
  } else {
    rows = await db.all(
      'SELECT id, content_id, domain, viewed_at FROM history ORDER BY viewed_at DESC LIMIT ? OFFSET ?',
      l, o
    );
  }
  res.json(rows);
}));

// DELETE /api/history/:id — remove single entry
router.delete('/history/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM history WHERE id = ?', req.params.id);
  res.status(204).send();
}));

// DELETE /api/history/clear/:domain — clear all history for a domain
router.delete('/history/clear/:domain', requireAuth, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM history WHERE domain = ?', req.params.domain);
  res.status(204).send();
}));

module.exports = { router, set_db };
