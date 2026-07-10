// KirinNet — Comments API (DuckDB)
const express = require('express');
const router = express.Router();

// GET /api/v1/content/:cid/comments
router.get('/content/:cid/comments', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const content = await db.get('SELECT id, allow_comments FROM content WHERE cid = ?', req.params.cid);
    if (!content) return res.status(404).json({ error: 'not_found' });
    if (!content.allow_comments) return res.status(403).json({ error: 'comments_disabled' });

    const rows = await db.all(
      `SELECT c.id, c.author_domain, c.body, c.parent_comment_id, c.created_at
       FROM comments c WHERE c.content_id = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC`, content.id
    );
    // Nest replies under parents
    const parents = rows.filter(r => !r.parent_comment_id);
    const replies = rows.filter(r => r.parent_comment_id);
    const tree = parents.map(p => ({
      ...p,
      replies: replies.filter(r => r.parent_comment_id === p.id)
    }));

    res.json({ content_id: content.id, cid: req.params.cid, allow_comments: !!content.allow_comments, total: rows.length, comments: tree });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/v1/content/:cid/comments
router.post('/content/:cid/comments', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { author_domain, body, parent_comment_id } = req.body;
    if (!author_domain || !body) return res.status(400).json({ error: 'missing_fields' });

    const content = await db.get('SELECT id, allow_comments FROM content WHERE cid = ?', req.params.cid);
    if (!content) return res.status(404).json({ error: 'not_found' });
    if (!content.allow_comments) return res.status(403).json({ error: 'comments_disabled' });

    if (parent_comment_id) {
      const parent = await db.get('SELECT id FROM comments WHERE id = ? AND content_id = ? AND deleted_at IS NULL', parent_comment_id, content.id);
      if (!parent) return res.status(404).json({ error: 'parent_not_found' });
    }

    const rows = await db.all(
      'INSERT INTO comments (content_id, author_domain, body, parent_comment_id) VALUES (?, ?, ?, ?) RETURNING id',
      content.id, author_domain, body, parent_comment_id || null
    );
    res.status(201).json({ comment_id: String(rows[0].id), cid: req.params.cid, author_domain, body, created_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/v1/comments/:id — owner can soft-delete
router.delete('/comments/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    // In production: verify the requester is the author or content owner
    const comment = await db.get('SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL', req.params.id);
    if (!comment) return res.status(404).json({ error: 'not_found' });
    await db.run('UPDATE comments SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', req.params.id);
    res.status(204).send();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/v1/content/:cid/comments/toggle — toggle allow_comments
router.put('/content/:cid/comments/toggle', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { allow } = req.body;
    const content = await db.get('SELECT id FROM content WHERE cid = ?', req.params.cid);
    if (!content) return res.status(404).json({ error: 'not_found' });
    await db.run('UPDATE content SET allow_comments = ?, updated_at = CURRENT_TIMESTAMP WHERE cid = ?', !!allow, req.params.cid);
    res.json({ cid: req.params.cid, allow_comments: !!allow });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
