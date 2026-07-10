// KirinNet User Node — Notifications
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/notifications?limit=&offset= — list notifications
router.get('/notifications', asyncHandler(async (req, res) => {
  const { limit, offset } = req.query;
  const l = parseInt(limit) || 50;
  const o = parseInt(offset) || 0;

  const rows = await db.all(
    'SELECT id, notify_type, title, body, from_domain, is_read, created_at FROM notifications ORDER BY created_at DESC LIMIT ? OFFSET ?',
    l, o
  );
  res.json(rows);
}));

// GET /api/notifications/unread-count — get unread count
router.get('/notifications/unread-count', asyncHandler(async (req, res) => {
  const row = await db.get(
    "SELECT COUNT(*)::INTEGER AS count FROM notifications WHERE is_read = FALSE"
  );
  res.json({ count: row ? row.count : 0 });
}));

// PUT /api/notifications/:id/read — mark single notification as read
router.put('/notifications/:id/read', requireAuth, asyncHandler(async (req, res) => {
  await db.run('UPDATE notifications SET is_read = TRUE WHERE id = ?', req.params.id);
  res.status(204).send();
}));

// PUT /api/notifications/read-all — mark all as read
router.put('/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
  await db.run("UPDATE notifications SET is_read = TRUE WHERE is_read = FALSE");
  res.status(204).send();
}));

// DELETE /api/notifications/:id — delete a notification
router.delete('/notifications/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM notifications WHERE id = ?', req.params.id);
  res.status(204).send();
}));

// POST /api/notifications — create notification (system/internal use)
router.post('/notifications', requireAuth, asyncHandler(async (req, res) => {
  const { notify_type, title, body, from_domain } = req.body;
  if (!title) return res.status(400).json({ error: 'missing_title' });

  const row = await db.get(
    `INSERT INTO notifications (notify_type, title, body, from_domain)
     VALUES (?, ?, ?, ?) RETURNING id, created_at`,
    notify_type || 'system',
    title,
    body || '',
    from_domain || ''
  );

  res.status(201).json({
    id: row.id,
    notify_type: notify_type || 'system',
    title,
    body: body || '',
    from_domain: from_domain || '',
    is_read: false,
    created_at: row.created_at,
  });
}));

module.exports = { router, set_db };
