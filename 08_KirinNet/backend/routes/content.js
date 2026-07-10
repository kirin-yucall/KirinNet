// KirinNet — Content API (DuckDB)
const express = require('express');
const router = express.Router();

// GET /api/v1/content
router.get('/content', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const limit = Math.min(+req.query.limit || 20, 100);
    const offset = Math.max(+req.query.offset || 0, 0);

    const total = (await db.get('SELECT COUNT(*) AS total FROM content WHERE is_indexed = true')).total;
    const results = await db.all(
      'SELECT * FROM content WHERE is_indexed = true ORDER BY created_at DESC LIMIT ? OFFSET ?',
      limit, offset
    );
    res.json({ total, limit, offset, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/v1/content/:id
router.get('/content/:cid', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const result = await db.get('SELECT * FROM content WHERE cid = ? AND is_indexed = true', req.params.cid);
    if (!result) return res.status(404).json({ error: 'not_found', message: 'Content not found' });

    // Increment view count via RocksDB for fast counter
    await db.kv.put(`views:${result.id}`, String(((await db.kv.get(`views:${result.id}`).catch(() => '0')) | 0) + 1));

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/v1/stats
router.get('/stats', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const [
      contentCount, userCount, recentCount,
      categoryBreakdown
    ] = await Promise.all([
      db.get('SELECT COUNT(*) AS total FROM content'),
      db.get('SELECT COUNT(*) AS total FROM users'),
      db.get("SELECT COUNT(*) AS total FROM content WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'"),
      db.all('SELECT category, COUNT(*)::INTEGER AS count FROM content GROUP BY category ORDER BY count DESC')
    ]);

    res.json({
      total_content: contentCount.total,
      total_users: userCount.total,
      recent_24h: recentCount.total,
      categories: categoryBreakdown
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
