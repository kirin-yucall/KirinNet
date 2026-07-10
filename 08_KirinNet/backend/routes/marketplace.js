// KirinNet — Marketplace API (DuckDB)
const express = require('express');
const router = express.Router();

router.get('/marketplace', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const limit = Math.min(+req.query.limit || 20, 100);
    const offset = Math.max(+req.query.offset || 0, 0);
    const category = req.query.category || null;
    const sort = req.query.sort || 'newest';
    const q = req.query.q || '';

    let where = "WHERE status = 'listed'";
    const params = [];
    if (q) { where += ' AND (title ILIKE ? OR description ILIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    if (category) { where += ' AND category = ?'; params.push(category); }

    let order = 'ORDER BY indexed_at DESC';
    if (sort === 'price_asc') order = 'ORDER BY base_price ASC';
    else if (sort === 'price_desc') order = 'ORDER BY base_price DESC';
    else if (sort === 'popular') order = 'ORDER BY view_count DESC';

    const total = (await db.get(`SELECT COUNT(*) AS total FROM marketplace_products ${where}`, ...params)).total;
    const results = await db.all(
      `SELECT * FROM marketplace_products ${where} ${order} LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );

    const enriched = await Promise.all(results.map(async (p) => {
      const cover = await db.get(
        'SELECT ipfs_cid FROM marketplace_media WHERE product_id = ? AND is_cover = true ORDER BY order_index LIMIT 1', p.id
      );
      return { ...p, cover_cid: cover ? cover.ipfs_cid : null };
    }));

    res.json({ total, limit, offset, results: enriched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/marketplace/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  try {
    const db = req.app.locals.db;
    const product = await db.get("SELECT * FROM marketplace_products WHERE id = ? AND status = 'listed'", req.params.id);
    if (!product) return res.status(404).json({ error: 'not_found' });

    const [variants, media] = await Promise.all([
      db.all('SELECT * FROM marketplace_variants WHERE product_id = ? ORDER BY id', product.id),
      db.all('SELECT * FROM marketplace_media WHERE product_id = ? ORDER BY order_index', product.id)
    ]);

    // Boost view count via kv_store
    const vk = `mp_views:${product.id}`;
    const prev = await db.kv.get(vk).catch(() => '0');
    await db.kv.put(vk, String(+prev + 1));
    await db.run('UPDATE marketplace_products SET view_count = view_count + 1 WHERE id = ?', product.id);

    res.json({ ...product, variants, media });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/marketplace', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { source_domain, source_id, type, title, description, category, base_price, currency, payment_methods, condition, location, tags, xrp_address, alipay_qr, cover_cid, variants, media } = req.body;

    if (!source_domain || !title || !type) {
      return res.status(400).json({ error: 'invalid_request', message: 'source_domain, title, and type are required' });
    }

    const existing = await db.get('SELECT id FROM marketplace_products WHERE source_domain = ? AND source_id = ?', source_domain, source_id || title);
    if (existing) return res.status(409).json({ error: 'duplicate', message: 'Product already exists' });

    const user = await db.get('SELECT id FROM users WHERE domain = ?', source_domain);
    if (!user) return res.status(404).json({ error: 'not_found', message: 'Source domain not registered' });

    const rows = await db.all(
      `INSERT INTO marketplace_products (source_domain, source_id, type, title, description, category, base_price, currency, payment_methods, condition, location, tags, cover_cid)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      source_domain, source_id || title, type, title, description || null,
      category || 'other', base_price || 0, currency || 'CNY',
      JSON.stringify(payment_methods || ['alipay']), condition || 'used', location || null,
      JSON.stringify(tags || []), cover_cid || null
    );
    const id = rows[0].id;

    // Insert variants
    if (variants && variants.length) {
      for (const v of variants) {
        await db.all(
          "INSERT INTO marketplace_variants (product_id, source_variant_id, sku, attributes, price_modifier, stock, status) VALUES (?,?,?,?,?,?,?) RETURNING id",
          id, v.source_variant_id || null, v.sku || `V${Date.now()}_${Math.random().toString(36).slice(2,6)}`, JSON.stringify(v.attributes || {}), v.price_modifier || 0, v.stock || 1, v.status || 'available'
        );
      }
    }

    // Insert media
    if (media && media.length) {
      for (let i = 0; i < media.length; i++) {
        const m = media[i];
        if (m.ipfs_cid) {
          await db.all(
            "INSERT INTO marketplace_media (product_id, ipfs_cid, is_cover, order_index) VALUES (?,?,?,?) RETURNING id",
            id, m.ipfs_cid, m.is_cover || false, i
          );
        }
      }
    }

    const product = await db.get('SELECT * FROM marketplace_products WHERE id = ?', id);
    res.status(201).json({ product_id: String(id), ...product });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/marketplace/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const product = await db.get('SELECT id FROM marketplace_products WHERE id = ?', req.params.id);
    if (!product) return res.status(404).json({ error: 'not_found' });

    const fields = ['title', 'description', 'category', 'base_price', 'currency', 'condition', 'location', 'status'];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        await db.run(`UPDATE marketplace_products SET ${f} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, req.body[f], req.params.id);
      }
    }
    res.json({ message: 'Updated', product_id: req.params.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
