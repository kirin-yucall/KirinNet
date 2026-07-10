// KirinNet User Node — Contacts (Nickname, Note, Block)
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---- Contacts -----------------------------------------------------------------

// POST /api/contacts — add contact (auth required)
router.post('/contacts', requireAuth, asyncHandler(async (req, res) => {
  const { domain, nickname, note } = req.body;
  if (!domain) return res.status(400).json({ error: 'missing_domain' });

  const existing = await db.get('SELECT id FROM contacts WHERE domain = ?', domain);
  if (existing) return res.status(409).json({ error: 'contact_already_exists' });

  const row = await db.get(
    `INSERT INTO contacts (domain, nickname, note)
     VALUES (?, ?, ?) RETURNING id, created_at`,
    domain, nickname || '', note || ''
  );

  res.status(201).json({
    id: row.id,
    domain,
    nickname: nickname || '',
    note: note || '',
    is_blocked: false,
    created_at: row.created_at,
  });
}));

// GET /api/contacts — list all contacts
router.get('/contacts', asyncHandler(async (req, res) => {
  const contacts = await db.all(
    'SELECT id, domain, nickname, note, is_blocked, created_at, updated_at FROM contacts ORDER BY created_at DESC'
  );
  res.json(contacts);
}));

// GET /api/contacts/:domain — single contact detail
router.get('/contacts/:domain', asyncHandler(async (req, res) => {
  const contact = await db.get(
    'SELECT id, domain, nickname, note, is_blocked, created_at, updated_at FROM contacts WHERE domain = ?',
    req.params.domain
  );
  if (!contact) return res.status(404).json({ error: 'not_found' });
  res.json(contact);
}));

// PUT /api/contacts/:domain — update contact (auth required)
router.put('/contacts/:domain', requireAuth, asyncHandler(async (req, res) => {
  const contact = await db.get('SELECT * FROM contacts WHERE domain = ?', req.params.domain);
  if (!contact) return res.status(404).json({ error: 'not_found' });

  const { nickname, note } = req.body;

  await db.run(
    `UPDATE contacts
     SET nickname = ?, note = ?, updated_at = CURRENT_TIMESTAMP
     WHERE domain = ?`,
    nickname !== undefined ? nickname : contact.nickname,
    note !== undefined ? note : contact.note,
    req.params.domain
  );

  const updated = await db.get(
    'SELECT id, domain, nickname, note, is_blocked, created_at, updated_at FROM contacts WHERE domain = ?',
    req.params.domain
  );
  res.json(updated);
}));

// PUT /api/contacts/:domain/block — block a contact (auth required)
router.put('/contacts/:domain/block', requireAuth, asyncHandler(async (req, res) => {
  const contact = await db.get('SELECT * FROM contacts WHERE domain = ?', req.params.domain);
  if (!contact) return res.status(404).json({ error: 'not_found' });

  await db.run(
    "UPDATE contacts SET is_blocked = TRUE, updated_at = CURRENT_TIMESTAMP WHERE domain = ?",
    req.params.domain
  );

  res.json({ domain: req.params.domain, is_blocked: true });
}));

// PUT /api/contacts/:domain/unblock — unblock a contact (auth required)
router.put('/contacts/:domain/unblock', requireAuth, asyncHandler(async (req, res) => {
  const contact = await db.get('SELECT * FROM contacts WHERE domain = ?', req.params.domain);
  if (!contact) return res.status(404).json({ error: 'not_found' });

  await db.run(
    "UPDATE contacts SET is_blocked = FALSE, updated_at = CURRENT_TIMESTAMP WHERE domain = ?",
    req.params.domain
  );

  res.json({ domain: req.params.domain, is_blocked: false });
}));

// DELETE /api/contacts/:domain — remove contact (auth required)
router.delete('/contacts/:domain', requireAuth, asyncHandler(async (req, res) => {
  const contact = await db.get('SELECT id FROM contacts WHERE domain = ?', req.params.domain);
  if (!contact) return res.status(404).json({ error: 'not_found' });
  await db.run('DELETE FROM contacts WHERE domain = ?', req.params.domain);
  res.status(204).send();
}));

module.exports = { router, set_db };
