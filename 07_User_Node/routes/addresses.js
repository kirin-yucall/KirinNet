// KirinNet User Node — Marketplace Addresses
// Addresses belong to this node's owner (no user_domain needed)
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/marketplace/addresses
router.get('/marketplace/addresses', asyncHandler(async (req, res) => {
  const addresses = await db.all(`
    SELECT id, label, recipient, phone, address, city, state,
           postal_code, country, is_default, created_at, updated_at
    FROM marketplace_addresses ORDER BY is_default DESC, created_at DESC
  `);
  res.json({ count: addresses.length, addresses });
}));

// GET /api/marketplace/addresses/:id
router.get('/marketplace/addresses/:id', asyncHandler(async (req, res) => {
  const addr = await db.get('SELECT * FROM marketplace_addresses WHERE id = ?', req.params.id);
  if (!addr) return res.status(404).json({ error: 'not_found' });
  res.json(addr);
}));

// POST /api/marketplace/addresses
router.post('/marketplace/addresses', requireAuth, asyncHandler(async (req, res) => {
  const { label, recipient, phone, address, city, state, postal_code, country, is_default } = req.body;
  if (!recipient || !address) return res.status(400).json({ error: 'missing_required', required: ['recipient', 'address'] });

  // If setting as default, unset others
  if (is_default) {
    await db.run('UPDATE marketplace_addresses SET is_default = FALSE');
  }

  const row = await db.get(`
    INSERT INTO marketplace_addresses (label, recipient, phone, address, city, state, postal_code, country, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id, created_at, updated_at
  `, label || 'default', recipient, phone || '', address, city || '', state || '', postal_code || '', country || 'CN', !!is_default);

  res.status(201).json({
    id: row.id,
    label: label || 'default',
    recipient, phone: phone || '',
    address, city: city || '', state: state || '',
    postal_code: postal_code || '', country: country || 'CN',
    is_default: !!is_default,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}));

// PUT /api/marketplace/addresses/:id
router.put('/marketplace/addresses/:id', requireAuth, asyncHandler(async (req, res) => {
  const existing = await db.get('SELECT * FROM marketplace_addresses WHERE id = ?', req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const fields = ['label', 'recipient', 'phone', 'address', 'city', 'state', 'postal_code', 'country', 'is_default'];
  const sets = [];
  const vals = [];

  for (const f of fields) {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(f === 'is_default' ? !!req.body[f] : req.body[f]);
    }
  }

  if (sets.length === 0) return res.status(400).json({ error: 'no_fields' });

  // If setting as default, unset others
  if (req.body.is_default) {
    await db.run('UPDATE marketplace_addresses SET is_default = FALSE WHERE id != ?', req.params.id);
  }

  sets.push('updated_at = CURRENT_TIMESTAMP');
  await db.run(`UPDATE marketplace_addresses SET ${sets.join(', ')} WHERE id = ?`, ...vals, req.params.id);

  const updated = await db.get('SELECT * FROM marketplace_addresses WHERE id = ?', req.params.id);
  res.json(updated);
}));

// DELETE /api/marketplace/addresses/:id
router.delete('/marketplace/addresses/:id', requireAuth, asyncHandler(async (req, res) => {
  const existing = await db.get('SELECT * FROM marketplace_addresses WHERE id = ?', req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  await db.run('DELETE FROM marketplace_addresses WHERE id = ?', req.params.id);
  res.status(204).send();
}));

module.exports = { router, set_db };
