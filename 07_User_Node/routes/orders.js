// KirinNet User Node — Orders (Buy/Sell Transactions)
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---- Orders -------------------------------------------------------------------

// POST /api/orders — create order
router.post('/orders', requireAuth, asyncHandler(async (req, res) => {
  const { order_type, buyer, seller, items, total, currency, note } = req.body;
  if (!order_type || !['buy', 'sell'].includes(order_type))
    return res.status(400).json({ error: 'invalid_order_type' });
  if (!buyer || !seller)
    return res.status(400).json({ error: 'missing_buyer_or_seller' });

  const itemsJson = items ? JSON.stringify(items) : '[]';

  const row = await db.get(
    `INSERT INTO orders (order_type, buyer, seller, items, total, currency, note)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`,
    order_type, buyer, seller, itemsJson, total || 0, currency || 'CNY', note || ''
  );

  res.status(201).json({
    id: row.id,
    order_type,
    buyer,
    seller,
    items: items || [],
    total: total || 0,
    currency: currency || 'CNY',
    status: 'pending',
    note: note || '',
    created_at: row.created_at,
  });
}));

// GET /api/orders — list orders with filters
router.get('/orders', asyncHandler(async (req, res) => {
  const { seller, buyer, status, type, limit, offset } = req.query;
  const conditions = [];
  const params = [];

  if (seller) { conditions.push('seller = ?'); params.push(seller); }
  if (buyer)  { conditions.push('buyer = ?'); params.push(buyer); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (type)   { conditions.push('order_type = ?'); params.push(type); }

  let sql = 'SELECT * FROM orders';
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';

  const lim = parseInt(limit) || 50;
  const off = parseInt(offset) || 0;
  sql += ` LIMIT ${lim} OFFSET ${off}`;

  const orders = await db.all(sql, ...params);
  // Parse items JSON for each order
  for (const o of orders) {
    try { o.items = JSON.parse(o.items); } catch (_) { o.items = []; }
  }
  res.json(orders);
}));

// GET /api/orders/:id — single order detail
router.get('/orders/:id', asyncHandler(async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  try { order.items = JSON.parse(order.items); } catch (_) { order.items = []; }
  res.json(order);
}));

// PUT /api/orders/:id — update order (status flow: pending→paid→shipped→completed, or pending→cancelled)
router.put('/orders/:id', requireAuth, asyncHandler(async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });

  const { status, note } = req.body;

  // Validate status transition
  const validTransitions = {
    pending:   ['paid', 'cancelled'],
    paid:      ['shipped', 'cancelled'],
    shipped:   ['completed'],
    completed: [],
    cancelled: [],
  };

  if (status) {
    if (!validTransitions[order.status] || !validTransitions[order.status].includes(status)) {
      return res.status(400).json({
        error: 'invalid_status_transition',
        current: order.status,
        allowed: validTransitions[order.status] || [],
      });
    }
    await db.run(
      "UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      status, req.params.id
    );
  }

  if (note !== undefined) {
    await db.run(
      "UPDATE orders SET note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      note, req.params.id
    );
  }

  const updated = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  try { updated.items = JSON.parse(updated.items); } catch (_) { updated.items = []; }
  res.json(updated);
}));

// DELETE /api/orders/:id — cancel order (soft: set status to cancelled)
router.delete('/orders/:id', requireAuth, asyncHandler(async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  await db.run(
    "UPDATE orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    req.params.id
  );
  res.status(204).send();
}));

module.exports = { router, set_db };
