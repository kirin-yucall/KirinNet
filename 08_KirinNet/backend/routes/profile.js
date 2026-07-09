// ============================================================================
// KirinNet — Profile API
//
// GET /api/v1/profile/:domain          — user profile + KirinDNS resolution
// GET /api/v1/profile/:domain/content  — user's published content
// Matches api_contract.md Section 4.
// ============================================================================
const express = require('express');
const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/v1/profile/:domain
// ---------------------------------------------------------------------------
router.get('/profile/:domain', async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const { domain } = req.params;

    // Look up user
    const userResult = await pool.query(
      'SELECT id, domain, public_key, display_name, bio, avatar_cid, created_at FROM users WHERE domain = $1',
      [domain]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'profile_not_found',
        message: `No user registered for domain '${domain}'`,
      });
    }

    const user = userResult.rows[0];

    // Count content and views
    const stats = await pool.query(
      'SELECT COUNT(*) AS content_count, COALESCE(SUM(view_count), 0) AS total_views FROM content WHERE creator_domain = $1 AND is_indexed = true',
      [domain]
    );

    // Get recent content
    const contentResult = await pool.query(
      `SELECT id, cid, storage_type, title, category, tags, view_count, is_indexed, created_at
       FROM content
       WHERE creator_domain = $1 AND is_indexed = true
       ORDER BY created_at DESC
       LIMIT 20`,
      [domain]
    );

    const content = contentResult.rows.map(row => ({
      content_id: String(row.id),
      title: row.title,
      cid: row.cid,
      storage_type: row.storage_type,
      category: row.category,
      tags: row.tags || [],
      view_count: row.view_count || 0,
      created_at: row.created_at,
      direct_url: row.storage_type === 'ipfs'
        ? `https://gateway.kirinnet.org/ipfs/${row.cid}`
        : `https://arweave.net/${row.cid}`,
    }));

    res.json({
      domain: user.domain,
      name: user.display_name || domain,
      bio: user.bio || null,
      public_key: user.public_key,
      avatar_url: user.avatar_cid
        ? `https://gateway.kirinnet.org/ipfs/${user.avatar_cid}`
        : null,
      content_count: parseInt(stats.rows[0].content_count, 10),
      total_views: parseInt(stats.rows[0].total_views, 10),
      joined_at: user.created_at,
      content,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/profile/:domain/content
// ---------------------------------------------------------------------------
router.get('/profile/:domain/content', async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const { domain } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const includeDeindexed = req.query.include_de_indexed === 'true';

    // Check user exists
    const userResult = await pool.query('SELECT id FROM users WHERE domain = $1', [domain]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'profile_not_found',
        message: `No user registered for domain '${domain}'`,
      });
    }

    // Build query
    let whereClause = 'creator_domain = $1';
    const params = [domain];
    let paramIdx = 2;

    if (!includeDeindexed) {
      whereClause += ' AND is_indexed = true';
    }

    // Count total
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total FROM content WHERE ${whereClause}`,
      [domain]
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Fetch results
    const result = await pool.query(
      `SELECT id, cid, storage_type, title, category, tags, view_count, is_indexed, created_at
       FROM content
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [domain, limit, offset]
    );

    const results = result.rows.map(row => ({
      content_id: String(row.id),
      title: row.title,
      cid: row.cid,
      storage_type: row.storage_type,
      category: row.category,
      tags: row.tags || [],
      view_count: row.view_count || 0,
      is_indexed: row.is_indexed,
      created_at: row.created_at,
      direct_url: row.storage_type === 'ipfs'
        ? `https://gateway.kirinnet.org/ipfs/${row.cid}`
        : `https://arweave.net/${row.cid}`,
    }));

    res.json({ total, limit, offset, results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
