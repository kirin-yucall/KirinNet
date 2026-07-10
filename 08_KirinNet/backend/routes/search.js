// KirinNet — Search API (DuckDB)
const express = require('express');
const router = express.Router();

router.get('/search', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const q = req.query.q || '', category = req.query.category || null;
    const sort = req.query.sort || 'newest';
    const limit = Math.min(Math.max(+req.query.limit || 20, 1), 100);
    const offset = Math.max(+req.query.offset || 0, 0);

    let where = 'WHERE is_indexed = true', params = [];
    if (q) { where += ' AND (title ILIKE ? OR COALESCE(description, \'\') ILIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    if (category) { where += ' AND category = ?'; params.push(category); }

    let order = 'ORDER BY created_at DESC';
    if (sort === 'oldest') order = 'ORDER BY created_at ASC';
    else if (sort === 'most_viewed') order = 'ORDER BY view_count DESC, created_at DESC';

    const total = (await db.get(`SELECT COUNT(*) AS total FROM content ${where}`, ...params)).total;
    const results = await db.all(`SELECT * FROM content ${where} ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);

    res.json({ total, limit, offset, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/search/trending', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const results = await db.all("SELECT * FROM content WHERE is_indexed = true AND created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days' ORDER BY view_count DESC LIMIT 50");
    res.json({ period: '7d', results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/suggest', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const q = req.query.q || '';
    const rows = await db.all('SELECT DISTINCT title FROM content WHERE title ILIKE ? LIMIT 10', `%${q}%`);
    res.json({ suggestions: rows.map(r => r.title) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/search/related/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const target = await db.get('SELECT * FROM content WHERE id = ?', req.params.id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    const related = await db.all('SELECT * FROM content WHERE id != ? AND category = ? AND is_indexed = true ORDER BY view_count DESC LIMIT 20', target.id, target.category);
    res.json({ content_id: target.id, results: related });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/swipe', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const limit = Math.min(30, Math.max(1, +req.query.limit || 10));
    const cursor = req.query.cursor ? +req.query.cursor : null;
    let sql = 'SELECT * FROM content WHERE is_indexed = true', params = [];
    if (cursor) { sql += ' AND id < ?'; params.push(cursor); }
    sql += ' ORDER BY id DESC LIMIT ?'; params.push(limit + 1);

    const items = await db.all(sql, ...params);
    const hasMore = items.length > limit;
    const results = hasMore ? items.slice(0, limit) : items;
    res.json({ items: results, hasMore, nextCursor: results.length ? String(results[results.length - 1].id) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
