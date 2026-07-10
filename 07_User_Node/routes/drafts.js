// KirinNet User Node — Content Drafts / 草稿
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// POST /api/drafts — create draft (requires auth)
router.post('/drafts', requireAuth, asyncHandler(async (req, res) => {
  const {
    content_type, title, body, description, thumbnail,
    comment_permission, required_points, required_vip
  } = req.body;

  const row = await db.get(
    `INSERT INTO drafts (content_type, title, body, description, thumbnail, comment_permission, required_points, required_vip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, saved_at`,
    content_type || 'article',
    title || '',
    body || '',
    description || '',
    thumbnail || '',
    comment_permission || 'all',
    required_points || 0,
    required_vip || ''
  );

  res.status(201).json({
    id: row.id,
    content_type: content_type || 'article',
    title: title || '',
    body: body || '',
    description: description || '',
    thumbnail: thumbnail || '',
    comment_permission: comment_permission || 'all',
    required_points: required_points || 0,
    required_vip: required_vip || '',
    saved_at: row.saved_at,
  });
}));

// GET /api/drafts — list all drafts (requires auth)
router.get('/drafts', requireAuth, asyncHandler(async (req, res) => {
  const rows = await db.all(
    'SELECT id, content_type, title, body, description, thumbnail, comment_permission, required_points, required_vip, saved_at, updated_at FROM drafts ORDER BY updated_at DESC'
  );
  res.json(rows);
}));

// GET /api/drafts/:id — get draft detail
router.get('/drafts/:id', asyncHandler(async (req, res) => {
  const row = await db.get(
    'SELECT id, content_type, title, body, description, thumbnail, comment_permission, required_points, required_vip, saved_at, updated_at FROM drafts WHERE id = ?',
    req.params.id
  );
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
}));

// PUT /api/drafts/:id — update draft (requires auth)
router.put('/drafts/:id', requireAuth, asyncHandler(async (req, res) => {
  const existing = await db.get('SELECT id FROM drafts WHERE id = ?', req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const {
    content_type, title, body, description, thumbnail,
    comment_permission, required_points, required_vip
  } = req.body;

  await db.run(
    `UPDATE drafts SET
       content_type = ?, title = ?, body = ?, description = ?, thumbnail = ?,
       comment_permission = ?, required_points = ?, required_vip = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    content_type !== undefined ? content_type : existing.content_type,
    title !== undefined ? title : existing.title,
    body !== undefined ? body : existing.body,
    description !== undefined ? description : existing.description,
    thumbnail !== undefined ? thumbnail : existing.thumbnail,
    comment_permission !== undefined ? comment_permission : existing.comment_permission,
    required_points !== undefined ? required_points : existing.required_points,
    required_vip !== undefined ? required_vip : existing.required_vip,
    req.params.id
  );

  res.status(204).send();
}));

// DELETE /api/drafts/:id — delete draft (requires auth)
router.delete('/drafts/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM drafts WHERE id = ?', req.params.id);
  res.status(204).send();
}));

// POST /api/drafts/:id/publish — publish draft as live content (requires auth)
router.post('/drafts/:id/publish', requireAuth, asyncHandler(async (req, res) => {
  const draft = await db.get('SELECT * FROM drafts WHERE id = ?', req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft_not_found' });

  const { v4: uuidv4 } = require('uuid');
  const contentId = uuidv4();

  await db.run(
    `INSERT INTO content (id, title, description, content_type, url, thumbnail, comment_permission, required_points, required_vip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    contentId,
    draft.title || '',
    draft.description || '',
    draft.content_type || 'article',
    '', // url — can be set later
    draft.thumbnail || '',
    draft.comment_permission || 'all',
    draft.required_points || 0,
    draft.required_vip || ''
  );

  // Delete the draft after publishing
  await db.run('DELETE FROM drafts WHERE id = ?', req.params.id);

  res.status(201).json({
    content_id: contentId,
    title: draft.title,
    content_type: draft.content_type || 'article',
  });
}));

module.exports = { router, set_db };
