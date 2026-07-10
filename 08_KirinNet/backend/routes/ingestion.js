// KirinNet — Ingestion API (DuckDB)
const express = require('express');
const router = express.Router();

router.post('/ingestion', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { cid, title, description, category, tags, creator_domain, creator_key, signature, storage_type, content_type, source_node, allow_comments } = req.body;

    if (!cid || !title || !creator_domain) {
      return res.status(400).json({ error: 'invalid_request', message: 'cid, title, and creator_domain are required' });
    }

    const existing = await db.get('SELECT id FROM content WHERE cid = ?', cid);
    if (existing) {
      return res.status(409).json({ error: 'duplicate', message: 'Content already indexed', content_id: String(existing.id) });
    }

    // Auto-create user
    let user = await db.get('SELECT id FROM users WHERE domain = ?', creator_domain);
    if (!user) {
      const r = await db.all('INSERT INTO users (domain) VALUES (?) RETURNING id', creator_domain);
      user = { id: r[0].id };
    }

    const rows = await db.all(
      `INSERT INTO content (cid, storage_type, content_type, title, description, category, tags, creator_domain, creator_key, signature, allow_comments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      cid, storage_type || 'ipfs', content_type || 'article', title, description || null,
      category || 'other', JSON.stringify(tags || []), creator_domain,
      creator_key || '', signature || '', allow_comments !== undefined ? !!allow_comments : true
    );
    const id = rows[0].id;

    await db.all(
      "INSERT INTO ingestion_log (content_id, action, source_node, cid, details) VALUES (?, 'ingested', ?, ?, ?) RETURNING id",
      id, source_node || 'unknown', cid, JSON.stringify(req.body)
    );

    res.status(201).json({ content_id: String(id), cid, status: 'ingested' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/ingestion/log', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const limit = Math.min(+req.query.limit || 20, 100);
    const rows = await db.all('SELECT * FROM ingestion_log ORDER BY created_at DESC LIMIT ?', limit);
    res.json({ count: rows.length, events: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
