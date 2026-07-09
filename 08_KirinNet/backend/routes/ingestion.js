// ============================================================================
// KirinNet — Ingestion Log API
//
// GET  /api/v1/ingestion          — Paginated view of all index events
// GET  /api/v1/ingestion/content/:id — Ingestion history for a single content
// GET  /api/v1/ingestion/stats       — Summary stats (total, by action, by day)
// ============================================================================

const express = require('express');
const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/v1/ingestion — All ingestion events
// ---------------------------------------------------------------------------
router.get('/ingestion', async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const {
      action,      // indexed | updated | de_indexed | re_indexed
      source_node, // filter by domain
      page = 1,
      limit = 50,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    let countSql = 'SELECT COUNT(*) as total FROM ingestion_log WHERE 1=1';
    let querySql = `
      SELECT il.*, c.title as content_title, c.category as content_type, c.creator_domain
      FROM ingestion_log il
      JOIN content c ON c.id = il.content_id
      WHERE 1=1`;
    const params = [];
    const countParams = [];

    if (action && ['indexed', 'updated', 'de_indexed', 're_indexed'].includes(action)) {
      const clause = ' AND il.action = $' + (params.length + 1);
      querySql += clause;
      countSql += clause;
      params.push(action);
      countParams.push(action);
    }
    if (source_node) {
      const clause = ' AND il.source_node = $' + (params.length + 1);
      querySql += clause;
      countSql += clause;
      params.push(source_node);
      countParams.push(source_node);
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total, 10);

    querySql += ` ORDER BY il.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limitNum, offset);

    const result = await pool.query(querySql, params);

    res.json({
      total,
      page: pageNum,
      limit: limitNum,
      events: result.rows,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/ingestion/content/:id — History for a single piece of content
// ---------------------------------------------------------------------------
router.get('/ingestion/content/:id', async (req, res, next) => {
  try {
    const { pool } = require('../server');

    const result = await pool.query(
      `SELECT il.*, c.title as content_title, c.category as content_type
       FROM ingestion_log il
       JOIN content c ON c.id = il.content_id
       WHERE il.content_id = $1
       ORDER BY il.created_at DESC`,
      [req.params.id]
    );

    res.json({
      content_id: req.params.id,
      history: result.rows,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/ingestion/stats — Summary statistics
// ---------------------------------------------------------------------------
router.get('/ingestion/stats', async (req, res, next) => {
  try {
    const { pool } = require('../server');

    const [totalResult, actionResult, dailyResult, typeResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM ingestion_log'),
      pool.query(
        `SELECT action, COUNT(*) as count
         FROM ingestion_log
         GROUP BY action
         ORDER BY count DESC`
      ),
      pool.query(
        `SELECT DATE(created_at) as date, COUNT(*) as count
         FROM ingestion_log
         WHERE created_at >= NOW() - INTERVAL '30 days'
         GROUP BY DATE(created_at)
         ORDER BY date DESC
         LIMIT 30`
      ),
      pool.query(
        `SELECT c.category as type, COUNT(DISTINCT il.content_id) as count
         FROM ingestion_log il
         JOIN content c ON c.id = il.content_id
         GROUP BY c.category
         ORDER BY count DESC`
      ),
    ]);

    res.json({
      total_indexed: parseInt(totalResult.rows[0].total, 10),
      by_action: actionResult.rows,
      by_type: typeResult.rows,
      daily_30d: dailyResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
