// KirinNet User Node — Coupons / 优惠卡券
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---- Coupons ------------------------------------------------------------------

// POST /api/coupons — create coupon (auth required)
router.post('/coupons', requireAuth, asyncHandler(async (req, res) => {
  const { code, coupon_type, value, min_order, max_discount, expires_at } = req.body;
  if (!code) return res.status(400).json({ error: 'missing_code' });
  if (!value && value !== 0) return res.status(400).json({ error: 'missing_value' });

  const existing = await db.get('SELECT id FROM coupons WHERE code = ?', code);
  if (existing) return res.status(409).json({ error: 'code_already_exists' });

  const row = await db.get(
    `INSERT INTO coupons (code, coupon_type, value, min_order, max_discount, expires_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at`,
    code, coupon_type || 'discount', value, min_order || 0,
    max_discount || null, expires_at || null
  );

  res.status(201).json({
    id: row.id,
    code,
    coupon_type: coupon_type || 'discount',
    value,
    min_order: min_order || 0,
    max_discount: max_discount || null,
    expires_at: expires_at || null,
    used: false,
    created_at: row.created_at,
  });
}));

// GET /api/coupons — list all coupons
router.get('/coupons', asyncHandler(async (req, res) => {
  const coupons = await db.all(
    'SELECT id, code, coupon_type, value, min_order, max_discount, expires_at, used, used_by, used_at, created_at FROM coupons ORDER BY created_at DESC'
  );
  res.json(coupons);
}));

// GET /api/coupons/validate/:code — validate a coupon code
router.get('/coupons/validate/:code', asyncHandler(async (req, res) => {
  const coupon = await db.get('SELECT * FROM coupons WHERE code = ?', req.params.code);
  if (!coupon) return res.json({ valid: false, discount: 0, message: 'coupon_not_found' });

  if (coupon.used) return res.json({ valid: false, discount: 0, message: 'already_used' });

  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return res.json({ valid: false, discount: 0, message: 'expired' });
  }

  const orderTotal = parseFloat(req.query.order_total) || 0;

  if (coupon.min_order && orderTotal < coupon.min_order) {
    return res.json({
      valid: false,
      discount: 0,
      message: `minimum_order_${coupon.min_order}_not_met`,
    });
  }

  let discount = 0;
  const couponType = coupon.coupon_type;

  if (couponType === 'discount') {
    discount = coupon.value;
    if (coupon.max_discount && discount > coupon.max_discount) {
      discount = coupon.max_discount;
    }
    if (discount > orderTotal) discount = orderTotal;
  } else if (couponType === 'free_shipping') {
    discount = 0; // free shipping doesn't reduce total, just waives shipping
  }

  res.json({ valid: true, discount, message: 'valid', coupon_type: couponType });
}));

// POST /api/coupons/:id/use — mark coupon as used
router.post('/coupons/:id/use', asyncHandler(async (req, res) => {
  const coupon = await db.get('SELECT * FROM coupons WHERE id = ?', req.params.id);
  if (!coupon) return res.status(404).json({ error: 'not_found' });
  if (coupon.used) return res.status(400).json({ error: 'already_used' });
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return res.status(400).json({ error: 'expired' });
  }

  const { domain } = req.body;
  await db.run(
    "UPDATE coupons SET used = TRUE, used_by = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?",
    domain || '', req.params.id
  );

  res.json({ status: 'used', coupon_id: +req.params.id, used_by: domain || '' });
}));

// DELETE /api/coupons/:id — delete coupon (auth required)
router.delete('/coupons/:id', requireAuth, asyncHandler(async (req, res) => {
  const coupon = await db.get('SELECT id FROM coupons WHERE id = ?', req.params.id);
  if (!coupon) return res.status(404).json({ error: 'not_found' });
  await db.run('DELETE FROM coupons WHERE id = ?', req.params.id);
  res.status(204).send();
}));

module.exports = { router, set_db };
