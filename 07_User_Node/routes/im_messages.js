// KirinNet User Node — IM Messages (Group Chat + Private Chat)
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---- IM Messages --------------------------------------------------------------

// POST /api/im/messages — send message (auth required)
// Body: { group_id, body }  for group chat
// Body: { to_domain, body } for private chat
router.post('/im/messages', requireAuth, asyncHandler(async (req, res) => {
  const { group_id, to_domain, body } = req.body;
  if (!body) return res.status(400).json({ error: 'missing_body' });
  if (group_id == null && !to_domain)
    return res.status(400).json({ error: 'missing_group_id_or_to_domain' });

  const from_domain = 'self';

  const row = await db.get(
    `INSERT INTO im_messages (group_id, from_domain, to_domain, body)
     VALUES (?, ?, ?, ?) RETURNING id, created_at`,
    group_id || null, from_domain, to_domain || '', body
  );

  res.status(201).json({
    id: row.id,
    group_id: group_id || null,
    from_domain,
    to_domain: to_domain || '',
    body,
    created_at: row.created_at,
  });
}));

// GET /api/im/messages — fetch messages
// ?group_id=&limit=&offset=  → group chat messages
// ?with=&limit=&offset=       → private chat messages (bidirectional)
// ?group_id=&before=&limit=   → history pagination (created_at < before)
router.get('/im/messages', asyncHandler(async (req, res) => {
  const { group_id, with: withDomain, before, limit, offset } = req.query;

  // History pagination: messages before a timestamp (for group or private)
  if (before) {
    if (group_id) {
      const messages = await db.all(
        `SELECT id, group_id, from_domain, body, created_at
         FROM im_messages
         WHERE group_id = ? AND created_at < ?
         ORDER BY created_at DESC
         LIMIT ?`,
        group_id, before, parseInt(limit) || 50
      );
      return res.json(messages.reverse());
    }

    if (withDomain) {
      const messages = await db.all(
        `SELECT id, from_domain, to_domain, body, created_at
         FROM im_messages
         WHERE group_id IS NULL
           AND ((from_domain = 'self' AND to_domain = ?) OR (from_domain = ? AND to_domain = 'self'))
           AND created_at < ?
         ORDER BY created_at DESC
         LIMIT ?`,
        withDomain, withDomain, before, parseInt(limit) || 50
      );
      return res.json(messages.reverse());
    }

    return res.status(400).json({ error: 'missing_group_id_or_with_for_before' });
  }

  // Group chat messages
  if (group_id != null) {
    const messages = await db.all(
      `SELECT id, group_id, from_domain, body, created_at
       FROM im_messages
       WHERE group_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      group_id, parseInt(limit) || 50, parseInt(offset) || 0
    );
    return res.json(messages);
  }

  // Private chat messages (bidirectional)
  if (withDomain) {
    const messages = await db.all(
      `SELECT id, from_domain, to_domain, body, created_at
       FROM im_messages
       WHERE group_id IS NULL
         AND ((from_domain = 'self' AND to_domain = ?) OR (from_domain = ? AND to_domain = 'self'))
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      withDomain, withDomain, parseInt(limit) || 50, parseInt(offset) || 0
    );
    return res.json(messages);
  }

  // No filter: return all messages (most recent)
  const messages = await db.all(
    `SELECT id, group_id, from_domain, to_domain, body, created_at
     FROM im_messages
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    parseInt(limit) || 50, parseInt(offset) || 0
  );
  res.json(messages);
}));

// DELETE /api/im/messages/:id — recall/delete message (auth required)
router.delete('/im/messages/:id', requireAuth, asyncHandler(async (req, res) => {
  const msg = await db.get('SELECT id FROM im_messages WHERE id = ?', req.params.id);
  if (!msg) return res.status(404).json({ error: 'not_found' });
  await db.run('DELETE FROM im_messages WHERE id = ?', req.params.id);
  res.status(204).send();
}));

module.exports = { router, set_db };
