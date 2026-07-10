// KirinNet User Node — Payment Methods / 支付收款设置
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---- Payment Methods ----------------------------------------------------------

// POST /api/payment-methods — create payment method (auth required)
router.post('/payment-methods', requireAuth, asyncHandler(async (req, res) => {
  const { method_type, label, account, qr_code } = req.body;
  if (!method_type || !['bank', 'crypto', 'alipay', 'wechat', 'paypal'].includes(method_type))
    return res.status(400).json({ error: 'invalid_method_type' });
  if (!label) return res.status(400).json({ error: 'missing_label' });
  if (!account) return res.status(400).json({ error: 'missing_account' });

  const row = await db.get(
    `INSERT INTO payment_methods (method_type, label, account, qr_code)
     VALUES (?, ?, ?, ?) RETURNING id, created_at`,
    method_type, label, account, qr_code || ''
  );

  // If this is the first payment method, make it default
  const count = await db.get('SELECT COUNT(*)::INTEGER AS cnt FROM payment_methods');
  if (count && count.cnt === 1) {
    await db.run('UPDATE payment_methods SET is_default = TRUE WHERE id = ?', row.id);
  }

  res.status(201).json({
    id: row.id,
    method_type,
    label,
    account,
    qr_code: qr_code || '',
    is_default: count && count.cnt === 1,
    created_at: row.created_at,
  });
}));

// GET /api/payment-methods — list all payment methods
router.get('/payment-methods', asyncHandler(async (req, res) => {
  const methods = await db.all(
    'SELECT id, method_type, label, account, qr_code, is_default, created_at, updated_at FROM payment_methods ORDER BY is_default DESC, created_at DESC'
  );
  res.json(methods);
}));

// PUT /api/payment-methods/:id — update payment method
router.put('/payment-methods/:id', requireAuth, asyncHandler(async (req, res) => {
  const method = await db.get('SELECT * FROM payment_methods WHERE id = ?', req.params.id);
  if (!method) return res.status(404).json({ error: 'not_found' });

  const { method_type, label, account, qr_code } = req.body;

  const newType = method_type || method.method_type;
  if (method_type && !['bank', 'crypto', 'alipay', 'wechat', 'paypal'].includes(method_type)) {
    return res.status(400).json({ error: 'invalid_method_type' });
  }

  await db.run(
    `UPDATE payment_methods
     SET method_type = ?, label = ?, account = ?, qr_code = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    newType,
    label !== undefined ? label : method.label,
    account !== undefined ? account : method.account,
    qr_code !== undefined ? qr_code : method.qr_code,
    req.params.id
  );

  const updated = await db.get('SELECT * FROM payment_methods WHERE id = ?', req.params.id);
  res.json(updated);
}));

// PUT /api/payment-methods/:id/default — set as default, unset others
router.put('/payment-methods/:id/default', requireAuth, asyncHandler(async (req, res) => {
  const method = await db.get('SELECT * FROM payment_methods WHERE id = ?', req.params.id);
  if (!method) return res.status(404).json({ error: 'not_found' });

  await db.run('UPDATE payment_methods SET is_default = FALSE, updated_at = CURRENT_TIMESTAMP');
  await db.run(
    'UPDATE payment_methods SET is_default = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    req.params.id
  );

  const updated = await db.get('SELECT * FROM payment_methods WHERE id = ?', req.params.id);
  res.json(updated);
}));

// DELETE /api/payment-methods/:id — delete payment method (auth required)
router.delete('/payment-methods/:id', requireAuth, asyncHandler(async (req, res) => {
  const method = await db.get('SELECT id FROM payment_methods WHERE id = ?', req.params.id);
  if (!method) return res.status(404).json({ error: 'not_found' });
  await db.run('DELETE FROM payment_methods WHERE id = ?', req.params.id);
  res.status(204).send();
}));

module.exports = { router, set_db };
