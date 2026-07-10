// KirinNet — Ad Slot Auction
// Ad positions as marketplace products. Anyone bids. Revenue → node owner.
// 2 slots per page, numbered. Bookable 7d ahead, 1-30 day slots.
const express = require('express');
const router = express.Router();

let db, _requireAuth, settingsCache = {};
function set_db(d, auth) { db = d; _requireAuth = auth; }

async function settingsInt(key, fallback) {
  if (settingsCache[key]) return settingsCache[key];
  const v = await db.getSetting(key);
  const n = parseInt(v) || fallback;
  settingsCache[key] = n;
  return n;
}

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

function dateStr(d) { return d.toISOString().slice(0, 10); }

// ---- Generate ad slot products ------------------------------------------------
// POST /api/ad-slots/generate
// { start_date: '2026-07-15', days: 30, slots_per_page: 2 }
router.post('/ad-slots/generate', requireAuth, asyncHandler(async (req, res) => {
  const { start_date, days, slots_per_page } = req.body;
  if (!start_date) return res.status(400).json({ error: 'start_date required' });

  const start = new Date(start_date);
  if (isNaN(start)) return res.status(400).json({ error: 'invalid start_date' });
  const totalDays = Math.min(days || 30, await settingsInt('ad_max_duration_days', 90));
  const perPage = Math.min(slots_per_page || await settingsInt('ad_slots_per_page', 2), 10);
  const reserveDays = await settingsInt('ad_reserve_days', 7);

  const minStart = new Date(Date.now() + reserveDays * 24 * 60 * 60 * 1000);
  if (start < minStart) {
    return res.status(400).json({ error: `must be at least ${reserveDays} days in advance`, earliest: dateStr(minStart) });
  }

  const created = [];
  for (let d = 0; d < totalDays; d++) {
    const day = new Date(start.getTime() + d * 24 * 60 * 60 * 1000);
    for (let s = 1; s <= perPage; s++) {
      try {
        const row = await db.get(
          `INSERT INTO ad_slot_products (slot_number, slot_start_date, slot_end_date, base_price, status)
           VALUES (?, ?, ?, ?, 'open') RETURNING id`,
          s, dateStr(day), dateStr(day), 0
        );
        created.push({ id: row.id, slot_number: s, date: dateStr(day) });
      } catch (e) {
        if (!e.message.includes('UNIQUE')) throw e; // skip duplicates
      }
    }
  }

  res.status(201).json({
    generated: created.length,
    start_date: dateStr(start),
    days: totalDays,
    slots_per_page: perPage,
    slots: created.slice(0, 20),
  });
}));

// ---- List available ad slots --------------------------------------------------
// GET /api/ad-slots?date=2026-07-15&slot=1&status=open
router.get('/ad-slots', asyncHandler(async (req, res) => {
  const { date, slot, status } = req.query;
  const limit = Math.min(+req.query.limit || 50, 200);
  const offset = +req.query.offset || 0;

  let where = "WHERE 1=1";
  const params = [];
  if (date)  { where += ' AND slot_start_date = ?'; params.push(date); }
  if (slot)  { where += ' AND slot_number = ?'; params.push(+slot); }
  if (status) { where += ' AND status = ?'; params.push(status); }

  const total = await db.get(`SELECT COUNT(*)::INTEGER AS cnt FROM ad_slot_products ${where}`, ...params);
  const slots = await db.all(
    `SELECT * FROM ad_slot_products ${where} ORDER BY slot_start_date, slot_number LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );

  // For each open slot, check if expired and close
  const now = dateStr(new Date());
  for (const s of slots) {
    if (s.status === 'open' && s.slot_start_date < now) {
      await db.run("UPDATE ad_slot_products SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?", s.id);
      s.status = 'expired';
    }
  }

  res.json({ total: total.cnt, limit, offset, slots });
}));

// ---- Place a bid --------------------------------------------------------------
// POST /api/ad-slots/:id/bid
// { bidder_domain: 'alice.local', amount: 50.0 }
router.post('/ad-slots/:id/bid', asyncHandler(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });

  const slot = await db.get("SELECT * FROM ad_slot_products WHERE id = ? AND status = 'open'", req.params.id);
  if (!slot) return res.status(404).json({ error: 'not_found_or_closed' });

  // 7-day rule: cannot bid on slots starting within 7 days
  const minStart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (new Date(slot.slot_start_date) < minStart) {
    return res.status(400).json({ error: 'bidding_closed', message: 'Slots close 7 days before start date' });
  }

  const { bidder_domain, amount } = req.body;
  if (!bidder_domain || !amount) return res.status(400).json({ error: 'bidder_domain and amount required' });
  if (amount <= slot.current_bid) {
    return res.status(400).json({ error: 'bid_too_low', current_bid: slot.current_bid, your_bid: amount });
  }

  // Record bid
  await db.run(
    'INSERT INTO ad_slot_bids (product_id, bidder_domain, amount) VALUES (?, ?, ?)',
    req.params.id, bidder_domain, amount
  );

  // Update slot
  await db.run(
    "UPDATE ad_slot_products SET current_bid = ?, bidder_domain = ?, bid_count = bid_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    amount, bidder_domain, req.params.id
  );

  const updated = await db.get('SELECT * FROM ad_slot_products WHERE id = ?', req.params.id);
  res.json({
    status: 'bid_accepted',
    slot_id: updated.id,
    slot_number: updated.slot_number,
    date: updated.slot_start_date,
    current_bid: updated.current_bid,
    bidder_domain: updated.bidder_domain,
    bid_count: updated.bid_count,
  });
}));

// ---- List bids for a slot -----------------------------------------------------
// GET /api/ad-slots/:id/bids
router.get('/ad-slots/:id/bids', asyncHandler(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });

  const slot = await db.get('SELECT * FROM ad_slot_products WHERE id = ?', req.params.id);
  if (!slot) return res.status(404).json({ error: 'not_found' });

  const bids = await db.all(
    'SELECT * FROM ad_slot_bids WHERE product_id = ? ORDER BY amount DESC',
    req.params.id
  );

  res.json({ slot_id: slot.id, slot_number: slot.slot_number, date: slot.slot_start_date, current_bid: slot.current_bid, bid_count: slot.bid_count, bids });
}));

// ---- Finalize: close bidding 7 days before, mark winner -----------------------
// POST /api/ad-slots/:id/finalize
router.post('/ad-slots/:id/finalize', requireAuth, asyncHandler(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });

  const slot = await db.get("SELECT * FROM ad_slot_products WHERE id = ? AND status = 'open'", req.params.id);
  if (!slot) return res.status(404).json({ error: 'not_found_or_closed' });

  if (slot.bid_count === 0) {
    await db.run("UPDATE ad_slot_products SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?", req.params.id);
    return res.json({ status: 'expired', reason: 'no_bids' });
  }

  await db.run("UPDATE ad_slot_products SET status = 'sold', updated_at = CURRENT_TIMESTAMP WHERE id = ?", req.params.id);
  const updated = await db.get('SELECT * FROM ad_slot_products WHERE id = ?', req.params.id);

  // Auto-extend: generate new slot for same position, 30 days later
  const nextDate = new Date(updated.slot_start_date);
  nextDate.setDate(nextDate.getDate() + 30);
  try {
    await db.get(
      `INSERT INTO ad_slot_products (slot_number, slot_start_date, slot_end_date, base_price, status)
       VALUES (?, ?, ?, ?, 'open') RETURNING id`,
      updated.slot_number, dateStr(nextDate), dateStr(nextDate), updated.current_bid
    );
  } catch (e) { /* duplicate OK */ }

  res.json({
    status: 'sold',
    slot_id: updated.id,
    slot_number: updated.slot_number,
    date: updated.slot_start_date,
    winner: updated.bidder_domain,
    final_price: updated.current_bid,
  });
}));

function clearCache() { settingsCache = {}; }

module.exports = { router, set_db, clearCache };
