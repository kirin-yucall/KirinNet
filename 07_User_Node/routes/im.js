// KirinNet User Node — IM Groups & Temporary Trade Keys
// All data belongs to this node's owner. No domain filtering needed.
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---- IM Groups ---------------------------------------------------------------

// POST /api/im/groups — create group with initial members
router.post('/im/groups', requireAuth, asyncHandler(async (req, res) => {
  const { group_name, group_type, members } = req.body;
  if (!group_name) return res.status(400).json({ error: 'missing_group_name' });
  if (!members || !Array.isArray(members)) return res.status(400).json({ error: 'missing_members' });

  const row = await db.get(
    "INSERT INTO im_groups (group_name, group_type) VALUES (?, ?) RETURNING id, created_at",
    group_name, group_type || 'custom'
  );

  for (const domain of members) {
    await db.run("INSERT OR IGNORE INTO im_group_members (group_id, domain) VALUES (?, ?)", row.id, domain);
  }

  res.status(201).json({
    group_id: row.id,
    group_name,
    group_type: group_type || 'custom',
    member_count: members.length,
    created_at: row.created_at,
  });
}));

// GET /api/im/groups — list all groups
router.get('/im/groups', asyncHandler(async (req, res) => {
  const groups = await db.all(`
    SELECT g.id, g.group_name, g.group_type, g.created_at,
           COUNT(gm.domain)::INTEGER AS member_count
    FROM im_groups g LEFT JOIN im_group_members gm ON g.id = gm.group_id
    GROUP BY g.id, g.group_name, g.group_type, g.created_at
    ORDER BY g.created_at DESC
  `);
  res.json({ groups });
}));

// GET /api/im/groups/:id — group detail with members
router.get('/im/groups/:id', asyncHandler(async (req, res) => {
  const group = await db.get('SELECT * FROM im_groups WHERE id = ?', req.params.id);
  if (!group) return res.status(404).json({ error: 'not_found' });
  const members = await db.all('SELECT domain, joined_at FROM im_group_members WHERE group_id = ? ORDER BY joined_at', req.params.id);
  res.json({ ...group, members });
}));

// POST /api/im/groups/:id/members — add member to group
router.post('/im/groups/:id/members', requireAuth, asyncHandler(async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'missing_domain' });
  const group = await db.get('SELECT * FROM im_groups WHERE id = ?', req.params.id);
  if (!group) return res.status(404).json({ error: 'group_not_found' });
  await db.run("INSERT OR IGNORE INTO im_group_members (group_id, domain) VALUES (?, ?)", req.params.id, domain);
  res.json({ status: 'added', group_id: +req.params.id, domain });
}));

// DELETE /api/im/groups/:id/members/:domain — remove member
router.delete('/im/groups/:id/members/:domain', requireAuth, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM im_group_members WHERE group_id = ? AND domain = ?', req.params.id, req.params.domain);
  res.status(204).send();
}));

// DELETE /api/im/groups/:id — delete group
router.delete('/im/groups/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM im_group_members WHERE group_id = ?', req.params.id);
  await db.run('DELETE FROM im_groups WHERE id = ?', req.params.id);
  res.status(204).send();
}));

// ---- Temporary Trade Keys ----------------------------------------------------

// POST /api/im/temp-key — request temporary key pair (90 days)
router.post('/im/temp-key', requireAuth, asyncHandler(async (req, res) => {
  const { to_domain, temp_public_key, purpose } = req.body;
  if (!to_domain || !temp_public_key) return res.status(400).json({ error: 'missing_fields' });

  const ninetyDays = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const row = await db.get(
    `INSERT INTO im_temp_keys (from_domain, to_domain, temp_public_key, purpose, expires_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id, expires_at`,
    'self', to_domain, temp_public_key, purpose || 'trade', ninetyDays
  );

  res.status(201).json({
    temp_key_id: row.id,
    to_domain,
    purpose: purpose || 'trade',
    expires_at: row.expires_at,
    expires_in_days: 90,
  });
}));

// GET /api/im/temp-keys — list all temp keys
router.get('/im/temp-keys', asyncHandler(async (req, res) => {
  const keys = await db.all(`
    SELECT id, from_domain, to_domain, purpose, status, expires_at, created_at, accepted_at
    FROM im_temp_keys ORDER BY created_at DESC
  `);
  res.json({ count: keys.length, keys });
}));

// POST /api/im/temp-key/:id/accept — accept a temp key, create/join trade group
router.post('/im/temp-key/:id/accept', requireAuth, asyncHandler(async (req, res) => {
  const key = await db.get('SELECT * FROM im_temp_keys WHERE id = ? AND status = ?', req.params.id, 'pending');
  if (!key) return res.status(404).json({ error: 'not_found_or_not_pending' });

  await db.run("UPDATE im_temp_keys SET status = 'active', accepted_at = CURRENT_TIMESTAMP WHERE id = ?", req.params.id);

  // Ensure trade group exists
  let tradeGroup = await db.get("SELECT id FROM im_groups WHERE group_type = 'trade' LIMIT 1");
  if (!tradeGroup) {
    tradeGroup = await db.get("INSERT INTO im_groups (group_name, group_type) VALUES (?, ?) RETURNING id", 'Trade Group', 'trade');
  }

  // Add both parties to trade group
  if (key.from_domain !== 'self')
    await db.run("INSERT OR IGNORE INTO im_group_members (group_id, domain) VALUES (?, ?)", tradeGroup.id, key.from_domain);
  await db.run("INSERT OR IGNORE INTO im_group_members (group_id, domain) VALUES (?, ?)", tradeGroup.id, key.to_domain);

  res.json({
    status: 'active',
    trade_group_id: tradeGroup.id,
    counterparty: key.to_domain,
  });
}));

// POST /api/im/temp-key/:id/revoke
router.post('/im/temp-key/:id/revoke', requireAuth, asyncHandler(async (req, res) => {
  await db.run("UPDATE im_temp_keys SET status = 'revoked' WHERE id = ?", req.params.id);
  res.json({ status: 'revoked' });
}));

module.exports = { router, set_db };
