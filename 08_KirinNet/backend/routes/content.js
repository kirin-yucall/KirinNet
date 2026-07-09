// ============================================================================
// KirinNet — Content API
//
// GET    /api/v1/content/:id  — fetch single content item
// PUT    /api/v1/content/:id  — update metadata (creator only)
// DELETE /api/v1/content/:id  — de-index (creator only)
// Matches api_contract.md Section 5.
// ============================================================================
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// GET /api/v1/content/:content_id
// ---------------------------------------------------------------------------
router.get('/content/:content_id', async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const { content_id } = req.params;

    const result = await pool.query(
      `SELECT c.id, c.cid, c.storage_type, c.title, c.description, c.category,
              c.tags, c.creator_domain, c.creator_key, c.thumbnail_cid,
              c.view_count, c.is_indexed, c.created_at, c.updated_at,
              u.display_name AS creator_name
       FROM content c
       LEFT JOIN users u ON c.creator_domain = u.domain
       WHERE c.id = $1`,
      [content_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'not_found',
        message: 'Content not found',
      });
    }

    const row = result.rows[0];

    // Increment view count (fire-and-forget)
    pool.query('UPDATE content SET view_count = view_count + 1 WHERE id = $1', [content_id])
      .catch(() => {});

    res.json({
      content_id: String(row.id),
      title: row.title,
      description: row.description,
      cid: row.cid,
      storage_type: row.storage_type,
      category: row.category,
      tags: row.tags || [],
      creator_domain: row.creator_domain,
      creator_name: row.creator_name || row.creator_domain,
      view_count: row.view_count || 0,
      is_indexed: row.is_indexed,
      created_at: row.created_at,
      updated_at: row.updated_at,
      direct_url: row.storage_type === 'ipfs'
        ? `https://gateway.kirinnet.org/ipfs/${row.cid}`
        : `https://arweave.net/${row.cid}`,
      kirinnet_url: `https://kirinnet.org/content/${row.id}`,
      thumbnail_url: row.thumbnail_cid
        ? `https://gateway.kirinnet.org/ipfs/${row.thumbnail_cid}`
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/content/:content_id  (creator only)
// ---------------------------------------------------------------------------
router.put('/content/:content_id', requireAuth, async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const { content_id } = req.params;
    const { title, description, tags, signature } = req.body;
    const userId = parseInt(req.user.user_id, 10);

    // Fetch existing content
    const existing = await pool.query(
      'SELECT id, creator_domain, creator_key FROM content WHERE id = $1',
      [content_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Content not found' });
    }

    const content = existing.rows[0];

    // Verify ownership: user's domain must match creator_domain
    const userResult = await pool.query('SELECT domain FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' });
    }

    if (userResult.rows[0].domain !== content.creator_domain) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Only the creator can update this content',
      });
    }

    // Build update fields
    const updates = [];
    const params = [content_id];
    let paramIdx = 2;

    if (title !== undefined) {
      if (title.length > 200) {
        return res.status(400).json({ error: 'invalid_request', message: 'Title max 200 characters' });
      }
      updates.push(`title = $${paramIdx++}`);
      params.push(title);
    }

    if (description !== undefined) {
      updates.push(`description = $${paramIdx++}`);
      params.push(description);
    }

    if (tags !== undefined) {
      const tagArray = Array.isArray(tags) ? tags : [];
      if (tagArray.length > 10) {
        return res.status(400).json({ error: 'invalid_request', message: 'Max 10 tags' });
      }
      updates.push(`tags = $${paramIdx++}`);
      params.push(tagArray);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'invalid_request', message: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');

    const result = await pool.query(
      `UPDATE content SET ${updates.join(', ')} WHERE id = $1 RETURNING id, title, description, tags, updated_at`,
      params
    );

    const updated = result.rows[0];
    res.json({
      content_id: String(updated.id),
      title: updated.title,
      description: updated.description,
      updated_at: updated.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/content/:content_id  (creator only — de-index, not delete)
// ---------------------------------------------------------------------------
router.delete('/content/:content_id', requireAuth, async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const { content_id } = req.params;
    const userId = parseInt(req.user.user_id, 10);

    const existing = await pool.query(
      'SELECT id, cid, creator_domain FROM content WHERE id = $1',
      [content_id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Content not found' });
    }

    const content = existing.rows[0];

    // Verify ownership
    const userResult = await pool.query('SELECT domain FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0 || userResult.rows[0].domain !== content.creator_domain) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Only the creator can delete this content',
      });
    }

    // De-index: set is_indexed = false, do NOT delete the row or the IPFS content
    await pool.query(
      `UPDATE content SET is_indexed = false, de_indexed_by = $1, de_indexed_at = NOW(),
              de_indexed_reason = 'Creator removed'
       WHERE id = $2`,
      [String(userId), content_id]
    );

    console.log(`[content] De-indexed content ${content_id} (cid: ${content.cid}) by user ${userId}`);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
