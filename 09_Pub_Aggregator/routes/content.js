const express = require('express');
const path = require('path');

const router = express.Router();

// Share the db connection from crawler.js (single connection, WAL mode)
const { db, incrementView } = require('../crawler');

// --- GET /api/search?q=keyword&type=video&limit=20&offset=0 ---

router.get('/search', (req, res) => {
  const { q, type, limit, offset } = req.query;
  const limitNum = Math.min(parseInt(limit) || 20, 100);
  const offsetNum = parseInt(offset) || 0;

  let sql = 'SELECT c.*, u.nickname, u.avatar FROM content c JOIN users u ON c.node_id = u.id';
  const params = [];
  const conditions = [];

  if (q) {
    conditions.push('(c.title LIKE ? OR c.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  if (type) {
    conditions.push('c.type = ?');
    params.push(type);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
  params.push(limitNum, offsetNum);

  const items = db.prepare(sql).all(...params);

  // Get total count for pagination
  let countSql = 'SELECT COUNT(*) as total FROM content c';
  const countConditions = [];
  const countParams = [];

  if (q) {
    countConditions.push('(c.title LIKE ? OR c.description LIKE ?)');
    countParams.push(`%${q}%`, `%${q}%`);
  }
  if (type) {
    countConditions.push('c.type = ?');
    countParams.push(type);
  }
  if (countConditions.length > 0) {
    countSql += ' WHERE ' + countConditions.join(' AND ');
  }

  const total = db.prepare(countSql).get(...countParams).total;

  res.json({ total, limit: limitNum, offset: offsetNum, items });
});

// --- GET /api/feed?type=video&sort=trending&limit=20&offset=0 ---

router.get('/feed', (req, res) => {
  const { type, sort, limit, offset } = req.query;
  const limitNum = Math.min(parseInt(limit) || 20, 100);
  const offsetNum = parseInt(offset) || 0;

  // Supported sort options: trending (by views), recent (by date), popular (views + recency)
  let orderBy = 'c.created_at DESC'; // default: recent
  if (sort === 'trending') {
    orderBy = 'c.views DESC';
  } else if (sort === 'popular') {
    // Weighted: views * 0.7 + recency (last 7 days = 1, older = 0)
    orderBy = '(c.views * 0.7 + CASE WHEN c.created_at >= datetime("now", "-7 days") THEN 1 ELSE 0 END * 3) DESC';
  }

  let sql = 'SELECT c.*, u.nickname, u.avatar FROM content c JOIN users u ON c.node_id = u.id';
  const params = [];

  if (type) {
    sql += ' WHERE c.type = ?';
    params.push(type);
  }

  sql += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  params.push(limitNum, offsetNum);

  const items = db.prepare(sql).all(...params);

  // Total count
  let countSql = 'SELECT COUNT(*) as total FROM content';
  if (type) {
    countSql += ' WHERE type = ?';
  }
  const total = db.prepare(countSql).get(type ? type : undefined).total;

  res.json({ total, limit: limitNum, offset: offsetNum, sort, type, items });
});

// --- GET /api/user/:domain/content ---

router.get('/user/:domain/content', (req, res) => {
  const domain = req.params.domain;

  // Get user profile
  const user = db.prepare(
    'SELECT id, domain, nickname, bio, avatar, port, last_crawled, crawl_count FROM users WHERE domain = ?'
  ).get(domain);

  if (!user) {
    return res.status(404).json({ error: 'user not found', domain });
  }

  // Get user content
  const content = db.prepare(
    'SELECT * FROM content WHERE domain = ? ORDER BY created_at DESC'
  ).all(domain);

  // Content counts by type
  const byType = db.prepare(
    'SELECT type, COUNT(*) as count FROM content WHERE domain = ? GROUP BY type'
  ).all(domain);

  res.json({
    user: {
      ...user,
      content_count: content.length,
      by_type: byType,
    },
    content,
  });
});

// --- GET /api/content/:id (for the player page) ---

router.get('/content/:id', (req, res) => {
  const item = db.prepare(
    'SELECT c.*, u.nickname, u.avatar, u.domain as user_domain, u.port FROM content c JOIN users u ON c.node_id = u.id WHERE c.id = ?'
  ).get(req.params.id);

  if (!item) {
    return res.status(404).json({ error: 'content not found', id: req.params.id });
  }

  // Increment view count
  incrementView(item.id);

  // Build direct URL to the content on the User Node
  if (!item.url.startsWith('http')) {
    item.direct_url = `http://${item.domain}:${item.port || 80}${item.url}`;
  } else {
    item.direct_url = item.url;
  }

  // Build thumbnail URL
  if (item.thumbnail && !item.thumbnail.startsWith('http')) {
    item.thumbnail_url = `http://${item.domain}:${item.port || 80}${item.thumbnail}`;
  } else {
    item.thumbnail_url = item.thumbnail;
  }

  res.json(item);
});

// --- GET /api/stats ---

router.get('/stats', (_req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const contentCount = db.prepare('SELECT COUNT(*) as count FROM content').get().count;
  const contentByType = db.prepare('SELECT type, COUNT(*) as count FROM content GROUP BY type').all();

  // Top content by views
  const trending = db.prepare(
    'SELECT c.id, c.title, c.type, c.views, c.domain, u.nickname FROM content c JOIN users u ON c.node_id = u.id ORDER BY c.views DESC LIMIT 10'
  ).all();

  res.json({
    users: userCount,
    content: contentCount,
    content_by_type: contentByType,
    trending,
  });
});

module.exports = router;

