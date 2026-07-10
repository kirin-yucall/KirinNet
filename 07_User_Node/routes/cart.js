// KirinNet User Node — Shopping Cart
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// POST /api/cart — add item to cart
router.post('/cart', requireAuth, asyncHandler(async (req, res) => {
  const { content_id, domain, qty } = req.body;
  if (!content_id) return res.status(400).json({ error: 'missing_content_id' });
  if (!domain) return res.status(400).json({ error: 'missing_domain' });

  const row = await db.get(
    `INSERT INTO cart (content_id, domain, qty) VALUES (?, ?, ?)
     ON CONFLICT(content_id, domain) DO UPDATE SET qty = qty + excluded.qty, added_at = now()
     RETURNING id, added_at`,
    content_id, domain, qty || 1
  );

  res.status(201).json({
    id: row.id,
    content_id,
    domain,
    qty: qty || 1,
    added_at: row.added_at,
  });
}));

// GET /api/cart?domain= — list cart items
router.get('/cart', asyncHandler(async (req, res) => {
  const { domain } = req.query;
  let rows;
  if (domain) {
    rows = await db.all(
      'SELECT id, content_id, domain, qty, added_at FROM cart WHERE domain = ? ORDER BY added_at DESC',
      domain
    );
  } else {
    rows = await db.all(
      'SELECT id, content_id, domain, qty, added_at FROM cart ORDER BY added_at DESC'
    );
  }
  res.json(rows);
}));

// DELETE /api/cart/:id — remove single item
router.delete('/cart/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM cart WHERE id = ?', req.params.id);
  res.status(204).send();
}));

// DELETE /api/cart/clear/:domain — clear entire cart for a domain
router.delete('/cart/clear/:domain', requireAuth, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM cart WHERE domain = ?', req.params.domain);
  res.status(204).send();
}));

module.exports = { router, set_db };
