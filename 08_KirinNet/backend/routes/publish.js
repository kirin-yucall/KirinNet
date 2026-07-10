// KirinNet — Publish API (DuckDB)
const express = require('express');
const router = express.Router();

router.post('/publish', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { cid, storage_type, content_type, title, description, category, tags, creator_domain, creator_key, signature, thumbnail_cid, allow_comments } = req.body;

    if (!cid || !title || !creator_domain) {
      return res.status(400).json({ error: 'invalid_request', message: 'cid, title, and creator_domain are required' });
    }

    // Auto-create user if not exists (domain IS identity)
    let user = await db.get('SELECT id FROM users WHERE domain = ?', creator_domain);
    if (!user) {
      const r = await db.all('INSERT INTO users (domain) VALUES (?) RETURNING id', creator_domain);
      user = { id: r[0].id };
    }

    const rows = await db.all(
      `INSERT INTO content (cid, storage_type, content_type, title, description, category, tags, creator_domain, creator_key, signature, thumbnail_cid, allow_comments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      cid, storage_type || 'ipfs', content_type || 'article', title, description || null,
      category || 'other', JSON.stringify(tags || []), creator_domain,
      creator_key || '', signature || '', thumbnail_cid || null,
      allow_comments !== undefined ? !!allow_comments : true
    );
    const id = rows[0].id;

    await db.all(
      "INSERT INTO ingestion_log (content_id, action, source_node, cid) VALUES (?, 'indexed', ?, ?) RETURNING id",
      id, creator_domain, cid
    );

    res.status(201).json({ content_id: String(id), cid, title, content_type: content_type || 'article', created_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
