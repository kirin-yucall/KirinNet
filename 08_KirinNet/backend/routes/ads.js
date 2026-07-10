// KirinNet Platform — Ad Slots (open registration, no auth)
// Publishers register ad positions. Revenue goes to domain owner.
const express = require('express');
const router = express.Router();

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// GET /api/v1/ads — list available ad slots
router.get('/ads', asyncHandler(async (req, res) => {
  const db = req.app.locals.db;
  const { position, domain, status } = req.query;
  const limit = Math.min(+req.query.limit || 20, 100);
  const offset = +req.query.offset || 0;

  let where = "WHERE 1=1";
  const params = [];
  if (position) { where += ' AND position = ?'; params.push(position); }
  if (domain)    { where += ' AND domain = ?'; params.push(domain); }
  if (status)    { where += ' AND status = ?'; params.push(status); }
  else           { where += " AND status = 'available'"; }

  const total = await db.get(`SELECT COUNT(*)::INTEGER AS cnt FROM ad_slots ${where}`, ...params);
  const results = await db.all(
    `SELECT * FROM ad_slots ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );

  res.json({ total: total.cnt, limit, offset, results });
}));

// POST /api/v1/ads — register an ad slot (domain = identity, no auth)
router.post('/ads', asyncHandler(async (req, res) => {
  const db = req.app.locals.db;
  const { domain, slot_name, position, ad_title, ad_image_cid, redirect_url, price } = req.body;
  if (!domain || !slot_name) return res.status(400).json({ error: 'domain and slot_name required' });

  const row = await db.get(
    `INSERT INTO ad_slots (domain, slot_name, position, ad_title, ad_image_cid, redirect_url, price)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`,
    domain, slot_name, position || 'sidebar', ad_title || null,
    ad_image_cid || null, redirect_url || null, price || 0
  );

  res.status(201).json({
    id: row.id, domain, slot_name, position: position || 'sidebar',
    ad_title, redirect_url, price: price || 0,
    status: 'available', created_at: row.created_at,
  });
}));

// PUT /api/v1/ads/:id — update ad slot
router.put('/ads/:id', asyncHandler(async (req, res) => {
  const db = req.app.locals.db;
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });

  const existing = await db.get('SELECT * FROM ad_slots WHERE id = ?', req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const fields = ['slot_name', 'position', 'ad_title', 'ad_image_cid', 'redirect_url', 'price', 'status'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { sets.push(`${f}=?`); vals.push(req.body[f]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'no_fields' });
  sets.push('updated_at=CURRENT_TIMESTAMP');

  await db.run(`UPDATE ad_slots SET ${sets.join(',')} WHERE id=?`, ...vals, req.params.id);
  const updated = await db.get('SELECT * FROM ad_slots WHERE id = ?', req.params.id);
  res.json(updated);
}));

// DELETE /api/v1/ads/:id
router.delete('/ads/:id', asyncHandler(async (req, res) => {
  const db = req.app.locals.db;
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  await db.run('DELETE FROM ad_slots WHERE id = ?', req.params.id);
  res.status(204).send();
}));

module.exports = router;
