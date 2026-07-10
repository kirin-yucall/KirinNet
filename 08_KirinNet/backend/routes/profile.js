// KirinNet — Profile API (DuckDB)
const express = require('express');
const router = express.Router();

// GET /api/v1/profile/:domain
router.get('/profile/:domain', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const user = await db.get(
      'SELECT id, domain, display_name, avatar, bio, role, created_at FROM users WHERE domain = ?',
      req.params.domain
    );
    if (!user) return res.status(404).json({ error: 'not_found', message: 'User not found' });

    const counts = await db.get(
      'SELECT COUNT(*) AS content_count FROM content WHERE creator_domain = ? AND is_indexed = true',
      req.params.domain
    );

    res.json({ ...user, content_count: counts.content_count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/v1/profile/:domain/content
router.get('/profile/:domain/content', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const limit = Math.min(+req.query.limit || 20, 100);
    const offset = Math.max(+req.query.offset || 0, 0);

    const content = await db.all(
      'SELECT * FROM content WHERE creator_domain = ? AND is_indexed = true ORDER BY created_at DESC LIMIT ? OFFSET ?',
      req.params.domain, limit, offset
    );
    const total = (await db.get('SELECT COUNT(*) AS total FROM content WHERE creator_domain = ? AND is_indexed = true', req.params.domain)).total;

    res.json({ domain: req.params.domain, total, limit, offset, content });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/v1/profile/:domain (authenticated by token matching domain)
router.put('/profile/:domain', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { display_name, bio } = req.body;

    const user = await db.get('SELECT id FROM users WHERE domain = ?', req.params.domain);
    if (!user) return res.status(404).json({ error: 'not_found' });

    if (display_name !== undefined) await db.run('UPDATE users SET display_name = ? WHERE domain = ?', display_name, req.params.domain);
    if (bio !== undefined) await db.run('UPDATE users SET bio = ? WHERE domain = ?', bio, req.params.domain);

    res.json({ message: 'Profile updated', domain: req.params.domain });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
