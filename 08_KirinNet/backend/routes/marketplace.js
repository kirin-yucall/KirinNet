// ============================================================================
// KirinNet Platform — Marketplace Routes
//
// Indexes and serves product listings from user nodes.
// Endpoints:
//   POST   /api/v1/marketplace/index          — Index a product (called by user node)
//   GET    /api/v1/marketplace                — Browse/search products
//   GET    /api/v1/marketplace/:id            — Product detail (platform view)
//   PUT    /api/v1/marketplace/:id/status     — Mark sold/removed
//   GET    /api/v1/marketplace/trending       — Trending products
//   GET    /api/v1/marketplace/by-domain/:domain — Node's listings
// ============================================================================

const express = require('express');
const router = express.Router();

// ============================================================================
// POST /marketplace/index — Index a product from a user node
// ============================================================================
router.post('/marketplace/index', (req, res) => {
  try {
    const { product, source_domain, source_id } = req.body;
    if (!source_domain || !source_id || !product)
      return res.status(400).json({ error: 'source_domain, source_id, and product are required' });

    const { db } = req.app.locals;
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const now = new Date().toISOString();
    const {
      type = 'simple',
      title,
      description,
      category = 'other',
      base_price = 0,
      currency = 'CNY',
      payment_methods = ['alipay'],
      condition = 'used',
      location: loc,
      tags = [],
      xrp_address,
      alipay_qr,
      cover_image,
      variants = [],
    } = product;

    // Upsert
    const existing = db.prepare(
      'SELECT id FROM marketplace_products WHERE source_domain = ? AND source_id = ?'
    ).get(source_domain, source_id);

    let productId;
    if (existing) {
      db.prepare(`
        UPDATE marketplace_products SET
          type = ?, title = ?, description = ?, category = ?, base_price = ?, currency = ?,
          payment_methods = ?, condition = ?, location = ?, tags = ?,
          xrp_address = ?, alipay_qr = ?, cover_cid = ?, updated_at = ?
        WHERE id = ?
      `).run(type, title, description || '', category, base_price, currency,
        JSON.stringify(payment_methods), condition, loc || null,
        JSON.stringify(tags), xrp_address || null, alipay_qr || null,
        cover_image || null, now, existing.id);
      productId = existing.id;
      // Clear old variants
      db.prepare('DELETE FROM marketplace_variants WHERE product_id = ?').run(productId);
      db.prepare('DELETE FROM marketplace_media WHERE product_id = ?').run(productId);
    } else {
      const result = db.prepare(`
        INSERT INTO marketplace_products
          (source_domain, source_id, type, title, description, category, base_price, currency,
           payment_methods, condition, location, tags, xrp_address, alipay_qr, cover_cid,
           indexed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(source_domain, source_id, type, title, description || '', category, base_price,
        currency, JSON.stringify(payment_methods), condition, loc || null,
        JSON.stringify(tags), xrp_address || null, alipay_qr || null,
        cover_image || null, now, now);
      productId = result.lastInsertRowid;
    }

    // Insert variants
    for (const v of variants) {
      db.prepare(`
        INSERT INTO marketplace_variants (product_id, sku, attributes, price_modifier, stock, status)
        VALUES (?, ?, ?, ?, ?, 'available')
      `).run(productId, v.sku, JSON.stringify(v.attributes || {}), v.price_modifier || 0, v.stock ?? 1);
    }

    // Insert media
    if (cover_image) {
      db.prepare(`
        INSERT INTO marketplace_media (product_id, ipfs_cid, is_cover, order_index)
        VALUES (?, ?, TRUE, 0)
      `).run(productId, cover_image);
    }

    res.json({ status: 'indexed', id: productId, source_domain, source_id });
  } catch (err) {
    console.error('[Marketplace] Index error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================================
// GET /marketplace — Browse/search
// ============================================================================
router.get('/marketplace', (req, res) => {
  try {
    const { db } = req.app.locals;
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const {
      category, type, condition, currency,
      min_price, max_price, search, sort = 'newest',
      page = 1, limit = 20,
    } = req.query;

    const conditions = ["status = 'listed'"];
    const params = [];

    if (category)  { conditions.push('category = ?'); params.push(category); }
    if (type)      { conditions.push('type = ?'); params.push(type); }
    if (condition) { conditions.push('condition = ?'); params.push(condition); }
    if (currency)  { conditions.push('currency = ?'); params.push(currency); }
    if (min_price) { conditions.push('base_price >= ?'); params.push(parseFloat(min_price)); }
    if (max_price) { conditions.push('base_price <= ?'); params.push(parseFloat(max_price)); }
    if (search)    { conditions.push("(title LIKE ? OR description LIKE ?)"); const s = `%${search}%`; params.push(s, s); }

    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM marketplace_products WHERE ${conditions.join(' AND ')}`
    ).get(...params);

    const sortMap = {
      newest: 'indexed_at DESC',
      price_asc: 'base_price ASC',
      price_desc: 'base_price DESC',
      popular: 'view_count DESC',
    };
    const orderBy = sortMap[sort] || 'indexed_at DESC';

    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
    const products = db.prepare(`
      SELECT * FROM marketplace_products
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit, 10), offset);

    const enriched = products.map(p => {
      const variantCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM marketplace_variants WHERE product_id = ?'
      ).get(p.id);

      return {
        ...p,
        tags: JSON.parse(p.tags || '[]'),
        payment_methods: JSON.parse(p.payment_methods || '["alipay"]'),
        variant_count: variantCount ? variantCount.cnt : 0,
      };
    });

    res.json({
      total: countRow ? countRow.total : 0,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      products: enriched,
    });
  } catch (err) {
    console.error('[Marketplace] Browse error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================================
// GET /marketplace/trending
// ============================================================================
router.get('/marketplace/trending', (req, res) => {
  try {
    const { db } = req.app.locals;
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const products = db.prepare(`
      SELECT * FROM marketplace_products
      WHERE status = 'listed'
      ORDER BY view_count DESC, indexed_at DESC
      LIMIT 12
    `).all();

    const enriched = products.map(p => ({
      ...p,
      tags: JSON.parse(p.tags || '[]'),
      payment_methods: JSON.parse(p.payment_methods || '["alipay"]'),
    }));

    res.json({ products: enriched });
  } catch (err) {
    console.error('[Marketplace] Trending error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================================
// GET /marketplace/by-domain/:domain
// ============================================================================
router.get('/marketplace/by-domain/:domain', (req, res) => {
  try {
    const { db } = req.app.locals;
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const products = db.prepare(`
      SELECT * FROM marketplace_products
      WHERE source_domain = ? AND status = 'listed'
      ORDER BY indexed_at DESC
    `).all(req.params.domain);

    const enriched = products.map(p => ({
      ...p,
      tags: JSON.parse(p.tags || '[]'),
      payment_methods: JSON.parse(p.payment_methods || '["alipay"]'),
    }));

    res.json({ domain: req.params.domain, total: enriched.length, products: enriched });
  } catch (err) {
    console.error('[Marketplace] By-domain error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================================
// GET /marketplace/:id — Product detail
// ============================================================================
router.get('/marketplace/:id', (req, res) => {
  try {
    const { db } = req.app.locals;
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const product = db.prepare('SELECT * FROM marketplace_products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    // Increment view count
    db.prepare('UPDATE marketplace_products SET view_count = view_count + 1 WHERE id = ?')
      .run(req.params.id);

    const variants = db.prepare(
      'SELECT * FROM marketplace_variants WHERE product_id = ?'
    ).all(req.params.id);

    const media = db.prepare(
      'SELECT * FROM marketplace_media WHERE product_id = ? ORDER BY order_index'
    ).all(req.params.id);

    res.json({
      ...product,
      tags: JSON.parse(product.tags || '[]'),
      payment_methods: JSON.parse(product.payment_methods || '["alipay"]'),
      variants: variants.map(v => ({ ...v, attributes: JSON.parse(v.attributes || '{}') })),
      media,
    });
  } catch (err) {
    console.error('[Marketplace] Detail error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================================================
// PUT /marketplace/:id/status
// ============================================================================
router.put('/marketplace/:id/status', (req, res) => {
  try {
    const { db } = req.app.locals;
    if (!db) return res.status(503).json({ error: 'Database not available' });

    const { status } = req.body;
    if (!['listed', 'sold', 'removed'].includes(status))
      return res.status(400).json({ error: "status must be listed|sold|removed" });

    const product = db.prepare('SELECT * FROM marketplace_products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    db.prepare('UPDATE marketplace_products SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), req.params.id);

    res.json({ id: req.params.id, status });
  } catch (err) {
    console.error('[Marketplace] Status error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
