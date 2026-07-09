// ============================================================================
// KirinNet Platform — Database (SQLite dev mode)
//
// Sets db on app.locals so routes can use req.app.locals.db.
// In production, swap to PostgreSQL via DATABASE_URL env var.
// ============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'kirinnet_platform.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---- Marketplace tables ------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS marketplace_products (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_domain   TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('simple', 'goods')),
    title           TEXT NOT NULL,
    description     TEXT,
    category        TEXT NOT NULL DEFAULT 'other'
                    CHECK (category IN ('clothing','electronics','books','home','beauty','sports','other')),
    base_price      REAL NOT NULL DEFAULT 0,
    currency        TEXT NOT NULL DEFAULT 'CNY' CHECK (currency IN ('CNY', 'XRP')),
    payment_methods TEXT NOT NULL DEFAULT '["alipay"]',
    condition       TEXT NOT NULL DEFAULT 'used' CHECK (condition IN ('new', 'used')),
    location        TEXT,
    tags            TEXT NOT NULL DEFAULT '[]',
    xrp_address     TEXT,
    alipay_qr       TEXT,
    cover_cid       TEXT,
    status          TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'sold', 'removed')),
    view_count      INTEGER DEFAULT 0,
    like_count      INTEGER DEFAULT 0,
    indexed_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_domain, source_id)
  );

  CREATE INDEX IF NOT EXISTS idx_mp_category ON marketplace_products(category);
  CREATE INDEX IF NOT EXISTS idx_mp_status ON marketplace_products(status);
  CREATE INDEX IF NOT EXISTS idx_mp_domain ON marketplace_products(source_domain);
  CREATE INDEX IF NOT EXISTS idx_mp_price ON marketplace_products(base_price);
  CREATE INDEX IF NOT EXISTS idx_mp_created ON marketplace_products(indexed_at);

  CREATE TABLE IF NOT EXISTS marketplace_variants (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id       INTEGER NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
    source_variant_id INTEGER,
    sku              TEXT NOT NULL,
    attributes       TEXT NOT NULL DEFAULT '{}',
    price_modifier   REAL NOT NULL DEFAULT 0,
    stock            INTEGER NOT NULL DEFAULT 1,
    status           TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'sold_out')),
    UNIQUE(product_id, sku)
  );

  CREATE INDEX IF NOT EXISTS idx_mpv_product ON marketplace_variants(product_id);

  CREATE TABLE IF NOT EXISTS marketplace_media (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
    variant_id  INTEGER REFERENCES marketplace_variants(id) ON DELETE SET NULL,
    ipfs_cid    TEXT NOT NULL,
    is_cover    INTEGER DEFAULT 0,
    order_index INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_mpm_product ON marketplace_media(product_id);
`);

function init(app) {
  app.locals.db = db;
  console.log(`[DB] SQLite ready: ${DB_PATH}`);
}

module.exports = { init, db };
