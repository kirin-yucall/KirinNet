// KirinNet User Node — Points & VIP Monetization
// Other users buy points/VIP. Node owner sets content paywall.
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---- Helper: ensure points account exists ------------------------------------
async function ensurePointsAccount(domain) {
  const acct = await db.get('SELECT * FROM points_accounts WHERE domain = ?', domain);
  if (!acct) {
    await db.run('INSERT INTO points_accounts (domain, balance, total_earned, total_spent) VALUES (?, 0, 0, 0)', domain);
    return { domain, balance: 0, total_earned: 0, total_spent: 0 };
  }
  return acct;
}

// ---- Points ------------------------------------------------------------------

// POST /api/points/grant — node owner grants points to a domain
router.post('/points/grant', requireAuth, asyncHandler(async (req, res) => {
  const { domain, amount, reason } = req.body;
  if (!domain || !amount || amount <= 0) return res.status(400).json({ error: 'domain and positive amount required' });

  await ensurePointsAccount(domain);
  await db.run(
    'UPDATE points_accounts SET balance = balance + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ?',
    amount, amount, domain
  );
  await db.run(
    'INSERT INTO points_transactions (domain, amount, reason) VALUES (?, ?, ?)',
    domain, amount, reason || 'grant'
  );

  const acct = await db.get('SELECT * FROM points_accounts WHERE domain = ?', domain);
  res.json({ domain, ...acct, granted: amount });
}));

// POST /api/points/buy — user buys points (payment intent)
router.post('/points/buy', asyncHandler(async (req, res) => {
  const { domain, amount, payment_ref } = req.body;
  if (!domain || !amount || amount <= 0) return res.status(400).json({ error: 'domain and positive amount required' });

  await ensurePointsAccount(domain);

  // Record the purchase intent — actual payment verification is external
  await db.run(
    'INSERT INTO points_transactions (domain, amount, reason, ref_id) VALUES (?, ?, ?, ?)',
    domain, amount, 'purchase', payment_ref || ''
  );
  await db.run(
    'UPDATE points_accounts SET balance = balance + ?, total_earned = total_earned + ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ?',
    amount, amount, domain
  );

  const acct = await db.get('SELECT * FROM points_accounts WHERE domain = ?', domain);
  res.json({ domain, ...acct, purchased: amount });
}));

// GET /api/points/balance?domain=
router.get('/points/balance', asyncHandler(async (req, res) => {
  const domain = req.query.domain;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  const acct = await ensurePointsAccount(domain);
  res.json(acct);
}));

// POST /api/points/spend — spend points (deducted when accessing paid content)
router.post('/points/spend', asyncHandler(async (req, res) => {
  const { domain, amount, content_id } = req.body;
  if (!domain || !amount || amount <= 0) return res.status(400).json({ error: 'domain and positive amount required' });

  const acct = await ensurePointsAccount(domain);
  if (acct.balance < amount) return res.status(402).json({ error: 'insufficient_balance', balance: acct.balance, required: amount });

  await db.run(
    'UPDATE points_accounts SET balance = balance - ?, total_spent = total_spent + ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ?',
    amount, amount, domain
  );
  await db.run(
    'INSERT INTO points_transactions (domain, amount, reason, ref_id) VALUES (?, ?, ?, ?)',
    domain, -amount, 'spend', content_id || ''
  );

  const updated = await db.get('SELECT * FROM points_accounts WHERE domain = ?', domain);
  res.json({ ...updated, spent: amount });
}));

// GET /api/points/transactions?domain=
router.get('/points/transactions', asyncHandler(async (req, res) => {
  const { domain, limit, offset } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  const txs = await db.all(
    'SELECT * FROM points_transactions WHERE domain = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    domain, Math.min(+limit || 50, 200), +offset || 0
  );
  res.json({ domain, count: txs.length, transactions: txs });
}));

// ---- VIP ---------------------------------------------------------------------

// POST /api/vip/buy — buy VIP subscription
router.post('/vip/buy', asyncHandler(async (req, res) => {
  const { domain, level, duration_days, payment_ref } = req.body;
  if (!domain || !level) return res.status(400).json({ error: 'domain and level required' });
  if (!['basic', 'premium', 'pro'].includes(level)) return res.status(400).json({ error: 'invalid_level', valid: ['basic', 'premium', 'pro'] });

  const days = duration_days || 30;
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const existing = await db.get('SELECT * FROM vip_accounts WHERE domain = ?', domain);
  if (existing) {
    // Extend from current expiry or now, whichever is later
    const base = existing.expires_at && new Date(existing.expires_at) > new Date() ? existing.expires_at : new Date().toISOString();
    const newExp = new Date(new Date(base).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    await db.run(
      'UPDATE vip_accounts SET level = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ?',
      level, newExp, domain
    );
  } else {
    await db.run(
      'INSERT INTO vip_accounts (domain, level, expires_at) VALUES (?, ?, ?)',
      domain, level, expires
    );
  }

  const acct = await db.get('SELECT * FROM vip_accounts WHERE domain = ?', domain);
  res.json({ domain, ...acct, duration_days: days });
}));

// GET /api/vip/status?domain=
router.get('/vip/status', asyncHandler(async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const acct = await db.get('SELECT * FROM vip_accounts WHERE domain = ?', domain);
  if (!acct) return res.json({ domain, vip: false, level: null, expires_at: null });

  const isActive = acct.expires_at && new Date(acct.expires_at) > new Date();
  res.json({ domain, vip: isActive, level: isActive ? acct.level : null, expires_at: acct.expires_at });
}));

// ---- Content Access Check ----------------------------------------------------
// GET /api/access/:content_id?domain=
// Returns { can_access, reason, required_points, required_vip, balance, is_vip }
router.get('/access/:content_id', asyncHandler(async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const item = await db.get('SELECT * FROM content WHERE id = ? AND deleted_at IS NULL', req.params.content_id);
  if (!item) return res.status(404).json({ error: 'not_found' });

  const requiredPts = item.required_points || 0;
  const requiredVip = item.required_vip || '';

  const [acct, vip] = await Promise.all([
    ensurePointsAccount(domain),
    db.get('SELECT * FROM vip_accounts WHERE domain = ?', domain),
  ]);

  const isVip = vip && vip.expires_at && new Date(vip.expires_at) > new Date();
  const vipLevel = isVip ? vip.level : null;

  // VIP check: if content requires VIP, check level
  if (requiredVip) {
    const levels = { basic: 1, premium: 2, pro: 3 };
    const required = levels[requiredVip] || 0;
    const current = levels[vipLevel] || 0;
    if (current < required) {
      return res.json({
        can_access: false,
        reason: 'vip_required',
        required_vip: requiredVip,
        current_vip: vipLevel || 'none',
        required_points: requiredPts,
        balance: acct.balance,
        is_vip: isVip,
      });
    }
  }

  // Points check
  if (requiredPts > 0 && acct.balance < requiredPts) {
    return res.json({
      can_access: false,
      reason: 'insufficient_points',
      required_points: requiredPts,
      balance: acct.balance,
      required_vip: requiredVip || null,
      is_vip: isVip,
    });
  }

  res.json({
    can_access: true,
    content_id: req.params.content_id,
    required_points: requiredPts,
    required_vip: requiredVip || null,
    balance: acct.balance,
    is_vip: isVip,
    vip_level: vipLevel,
  });
}));

module.exports = { router, set_db };
