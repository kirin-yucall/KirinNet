// ============================================================================
// KirinNet — Search API
//
// GET /api/v1/search       — full-text search with filters
// GET /api/v1/search/trending — trending content (past 24h)
// Matches api_contract.md Section 3.
// ============================================================================
const express = require('express');
const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/v1/search
// ---------------------------------------------------------------------------
router.get('/search', async (req, res, next) => {
  try {
    const { pool } = require('../server');

    const q           = req.query.q || '';
    const category    = req.query.category || null;
    const tags        = req.query.tags ? req.query.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const sort        = req.query.sort || 'relevance';
    const limit       = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset      = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const VALID_CATEGORIES = ['video', 'article', 'audio', 'image', 'other'];
    const VALID_SORTS = ['relevance', 'newest', 'oldest', 'most_viewed'];

    // Validate category
    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
      });
    }

    // Validate sort
    const sortField = VALID_SORTS.includes(sort) ? sort : 'relevance';

    // Build WHERE clause
    let whereClause = 'is_indexed = true';
    const params = [];
    let paramIdx = 1;

    if (q) {
      // Full-text search: use PostgreSQL tsquery
      // Convert "decentralized web3" → "decentralized & web3"
      const tsq = q.trim().split(/\s+/).join(' & ');
      whereClause += ` AND to_tsvector('english', title || ' ' || COALESCE(description, '')) @@ to_tsquery('english', $${paramIdx})`;
      params.push(tsq);
      paramIdx++;
    }

    if (category) {
      whereClause += ` AND category = $${paramIdx}`;
      params.push(category);
      paramIdx++;
    }

    if (tags.length > 0) {
      whereClause += ` AND tags && $${paramIdx}::text[]`;
      params.push(tags);
      paramIdx++;
    }

    // Build ORDER BY
    let orderClause;
    switch (sortField) {
      case 'newest':
        orderClause = 'ORDER BY created_at DESC';
        break;
      case 'oldest':
        orderClause = 'ORDER BY created_at ASC';
        break;
      case 'most_viewed':
        orderClause = 'ORDER BY view_count DESC, created_at DESC';
        break;
      case 'relevance':
      default:
        if (q) {
          orderClause = 'ORDER BY ts_rank(to_tsvector(\'english\', title || \' \' || COALESCE(description, \'\')), to_tsquery(\'english\', $1)) DESC, created_at DESC';
        } else {
          orderClause = 'ORDER BY created_at DESC';
        }
        break;
    }

    // Count total (separate query for accurate pagination)
    const countQuery = `SELECT COUNT(*) AS total FROM content WHERE ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Fetch results
    const dataQuery = `
      SELECT id, cid, storage_type, title, description, category, tags,
             creator_domain, thumbnail_cid, view_count, created_at
      FROM content
      WHERE ${whereClause}
      ${orderClause}
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    params.push(limit, offset);

    const result = await pool.query(dataQuery, params);

    const results = result.rows.map(row => ({
      content_id: String(row.id),
      title: row.title,
      description: row.description,
      cid: row.cid,
      storage_type: row.storage_type,
      category: row.category,
      tags: row.tags || [],
      creator_domain: row.creator_domain,
      view_count: row.view_count || 0,
      created_at: row.created_at,
      thumbnail_url: row.thumbnail_cid
        ? `https://gateway.kirinnet.org/ipfs/${row.thumbnail_cid}`
        : null,
    }));

    res.json({
      total,
      limit,
      offset,
      results,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/search/trending
//
// Top 50 by view count (content published or viewed in last 24h, approximate)
// ---------------------------------------------------------------------------
router.get('/search/trending', async (req, res, next) => {
  try {
    const { pool } = require('../server');

    const result = await pool.query(`
      SELECT id, cid, storage_type, title, category,
             creator_domain, thumbnail_cid, view_count, created_at
      FROM content
      WHERE is_indexed = true
        AND created_at >= NOW() - INTERVAL '7 days'
      ORDER BY view_count DESC
      LIMIT 50
    `);

    const results = result.rows.map(row => ({
      content_id: String(row.id),
      title: row.title,
      cid: row.cid,
      storage_type: row.storage_type,
      category: row.category,
      creator_domain: row.creator_domain,
      view_count: row.view_count || 0,
      created_at: row.created_at,
      thumbnail_url: row.thumbnail_cid
        ? `https://gateway.kirinnet.org/ipfs/${row.thumbnail_cid}`
        : null,
    }));

    res.json({
      period: '7d',
      results,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/v1/search/related/:id — Related content by tag overlap
// ============================================================================
router.get('/search/related/:id', async (req, res, next) => {
  try {
    const { pool } = require('../server');

    // Get target content's tags and category
    const target = await pool.query(
      'SELECT id, tags, category, creator_domain FROM content WHERE id = $1 AND is_indexed = TRUE',
      [req.params.id]
    );

    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Content not found' });
    }

    const { tags: targetTags, category, creator_domain, id: targetId } = target.rows[0];

    if (!targetTags || targetTags.length === 0) {
      // No tags — fall back to same-category recommendations
      const result = await pool.query(
        `SELECT id, cid, title, category, tags, creator_domain, thumbnail_cid, view_count, created_at
         FROM content
         WHERE is_indexed = TRUE
           AND id != $1
           AND category = $2
         ORDER BY view_count DESC
         LIMIT 20`,
        [targetId, category]
      );
      return res.json({ content_id: targetId, results: result.rows });
    }

    // Tag overlap scoring
    const result = await pool.query(
      `SELECT id, cid, title, category, tags, creator_domain, thumbnail_cid, view_count,
              (
                SELECT COUNT(*) FROM unnest($2::text[]) AS t
                WHERE t = ANY(tags)
              ) AS overlap,
              created_at
       FROM content
       WHERE is_indexed = TRUE
         AND id != $1
         AND tags && $2::text[]
       ORDER BY overlap DESC, view_count DESC
       LIMIT 20`,
      [targetId, targetTags]
    );

    res.json({
      content_id: targetId,
      tags: targetTags,
      results: result.rows,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// GET /api/v1/swipe — TikTok-style swipe feed (cursor-based)
//
// Query params:
//   type     — post | article | video | all (default: all)
//   cursor   — content_id to start after (for pagination)
//   limit    — default 10, max 30
// ============================================================================
router.get('/swipe', async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const {
      type,      // post | article | video | all
      cursor,    // content_id for cursor pagination
      limit = 10,
    } = req.query;

    const limitNum = Math.min(30, Math.max(1, parseInt(limit, 10) || 10));
    const types = type && type !== 'all'
      ? [type]
      : ['post', 'video', 'article'];

    let sql = `
      SELECT id, cid, title, description, category, tags, creator_domain,
             thumbnail_cid, view_count, storage_type, created_at
      FROM content
      WHERE is_indexed = TRUE
        AND category = ANY($1::text[])`;
    const params = [types];

    if (cursor) {
      sql += ` AND id > $${params.length + 1}`;
      params.push(parseInt(cursor, 10));
    }

    sql += ` ORDER BY id DESC LIMIT $${params.length + 1}`;
    params.push(limitNum + 1); // fetch one extra to detect hasMore

    const result = await pool.query(sql, params);
    const hasMore = result.rows.length > limitNum;
    const items = hasMore ? result.rows.slice(0, limitNum) : result.rows;

    res.json({
      items,
      hasMore,
      nextCursor: items.length > 0 ? String(items[items.length - 1].id) : null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
