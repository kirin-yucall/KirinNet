// ============================================================================
// KirinNet Platform — Database (DuckDB columnar + FS)
//
// Identity: domain = user. Auth via IM system.
// User profile fetched from DNS TXT/SRV. Local cache optional.
// ============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const duckdb = require('duckdb');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

for (const dir of ['duckdb', 'media']) {
  const p = path.join(DATA_DIR, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const duckPath = path.join(DATA_DIR, 'duckdb', 'kirinnet.db');
const ddb = new duckdb.Database(duckPath);

// ---- Async helpers -----------------------------------------------------------
function duckRun(sql, ...params) {
  return new Promise((resolve, reject) => {
    ddb.run(sql, ...params.flat(Infinity), (err) => { if (err) reject(err); else resolve(); });
  });
}
function duckAll(sql, ...params) {
  return new Promise((resolve, reject) => {
    ddb.all(sql, ...params.flat(Infinity), (err, rows) => { if (err) reject(err); else resolve(rows); });
  });
}
function duckGet(sql, ...params) {
  return new Promise((resolve, reject) => {
    ddb.all(sql, ...params.flat(Infinity), (err, rows) => {
      if (err) reject(err); else resolve(rows.length > 0 ? rows[0] : null);
    });
  });
}
function duckExec(sql) {
  return new Promise((resolve, reject) => {
    ddb.exec(sql, (err) => { if (err) reject(err); else resolve(); });
  });
}

// ---- KV store ----------------------------------------------------------------
const kv = {
  async get(key) {
    const row = await duckGet('SELECT val FROM kv_store WHERE key = ?', key);
    return row ? row.val : null;
  },
  async put(key, val) {
    await duckRun('INSERT OR REPLACE INTO kv_store (key, val) VALUES (?, ?)', key, String(val));
  },
  async del(key) {
    await duckRun('DELETE FROM kv_store WHERE key = ?', key);
  },
};

// ---- Init schema ------------------------------------------------------------
async function init(app) {
  await duckExec(`
    CREATE SEQUENCE IF NOT EXISTS users_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS content_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS refresh_tokens_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS marketplace_products_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS marketplace_variants_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS marketplace_media_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS ingestion_log_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS comments_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS ad_slots_seq START 1;

    -- ==================================================================
    -- Users: domain = identity. Profile data from DNS, local cache.
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY DEFAULT nextval('users_seq'),
      domain       VARCHAR UNIQUE NOT NULL,
      display_name VARCHAR,
      avatar       VARCHAR,
      bio          VARCHAR,
      role         VARCHAR NOT NULL DEFAULT 'creator',
      cached_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ==================================================================
    -- Content: articles / posts / videos
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS content (
      id              INTEGER PRIMARY KEY DEFAULT nextval('content_seq'),
      cid             VARCHAR NOT NULL,
      storage_type    VARCHAR NOT NULL DEFAULT 'ipfs',
      content_type    VARCHAR NOT NULL DEFAULT 'article',
      title           VARCHAR NOT NULL,
      description     VARCHAR,
      category        VARCHAR NOT NULL DEFAULT 'other',
      tags            VARCHAR DEFAULT '[]',
      creator_domain  VARCHAR NOT NULL,
      creator_key     VARCHAR NOT NULL DEFAULT '',
      signature       VARCHAR NOT NULL DEFAULT '',
      thumbnail_cid   VARCHAR,
      allow_comments  BOOLEAN DEFAULT TRUE,
      comment_permission VARCHAR DEFAULT 'all',
      view_count      INTEGER DEFAULT 0,
      is_indexed      BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ==================================================================
    -- Comments: nested replies, per-content allow toggle
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS comments (
      id                INTEGER PRIMARY KEY DEFAULT nextval('comments_seq'),
      content_id        INTEGER NOT NULL,
      author_domain     VARCHAR NOT NULL,
      body              VARCHAR NOT NULL,
      parent_comment_id INTEGER,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      deleted_at        TIMESTAMP
    );

    -- ==================================================================
    -- Auth: refresh tokens (JWT session persistence)
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id         INTEGER PRIMARY KEY DEFAULT nextval('refresh_tokens_seq'),
      user_id    INTEGER NOT NULL,
      token      VARCHAR UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      revoked    BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ==================================================================
    -- Marketplace: products / variants / media (display only, from nodes)
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS marketplace_products (
      id              INTEGER PRIMARY KEY DEFAULT nextval('marketplace_products_seq'),
      source_domain   VARCHAR NOT NULL,
      source_id       VARCHAR NOT NULL,
      type            VARCHAR NOT NULL,
      title           VARCHAR NOT NULL,
      description     VARCHAR,
      category        VARCHAR NOT NULL DEFAULT 'other',
      base_price      DOUBLE NOT NULL DEFAULT 0,
      currency        VARCHAR NOT NULL DEFAULT 'CNY',
      payment_methods VARCHAR NOT NULL DEFAULT '["alipay"]',
      condition       VARCHAR NOT NULL DEFAULT 'used',
      location        VARCHAR,
      tags            VARCHAR NOT NULL DEFAULT '[]',
      cover_cid       VARCHAR,
      status          VARCHAR NOT NULL DEFAULT 'listed',
      view_count      INTEGER DEFAULT 0,
      like_count      INTEGER DEFAULT 0,
      sold_at         TIMESTAMP,
      indexed_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_domain, source_id)
    );

    CREATE TABLE IF NOT EXISTS marketplace_variants (
      id               INTEGER PRIMARY KEY DEFAULT nextval('marketplace_variants_seq'),
      product_id       INTEGER NOT NULL,
      source_variant_id INTEGER,
      sku              VARCHAR NOT NULL,
      attributes       VARCHAR NOT NULL DEFAULT '{}',
      price_modifier   DOUBLE NOT NULL DEFAULT 0,
      stock            INTEGER NOT NULL DEFAULT 1,
      status           VARCHAR NOT NULL DEFAULT 'available',
      UNIQUE(product_id, sku)
    );

    CREATE TABLE IF NOT EXISTS marketplace_media (
      id          INTEGER PRIMARY KEY DEFAULT nextval('marketplace_media_seq'),
      product_id  INTEGER NOT NULL,
      variant_id  INTEGER,
      ipfs_cid    VARCHAR NOT NULL,
      is_cover    BOOLEAN DEFAULT FALSE,
      order_index INTEGER DEFAULT 0
    );

    -- ==================================================================
    -- Ad Slots: publisher domains can register ad positions
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS ad_slots (
      id            INTEGER PRIMARY KEY DEFAULT nextval('ad_slots_seq'),
      domain        VARCHAR NOT NULL,
      slot_name     VARCHAR NOT NULL,
      position      VARCHAR NOT NULL DEFAULT 'sidebar',
      ad_url        VARCHAR,
      ad_title      VARCHAR,
      ad_image_cid  VARCHAR,
      redirect_url  VARCHAR,
      price         DOUBLE DEFAULT 0,
      status        VARCHAR NOT NULL DEFAULT 'available',
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ==================================================================
    -- Ingestion log
    -- ==================================================================
    CREATE TABLE IF NOT EXISTS ingestion_log (
      id          INTEGER PRIMARY KEY DEFAULT nextval('ingestion_log_seq'),
      content_id  INTEGER NOT NULL,
      action      VARCHAR NOT NULL,
      source_node VARCHAR,
      cid         VARCHAR NOT NULL,
      details     VARCHAR,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- KV store
    CREATE TABLE IF NOT EXISTS kv_store (
      key   VARCHAR PRIMARY KEY,
      val   VARCHAR NOT NULL
    );
  `);

  // Expose to routes (BigInt-safe)
  app.locals.db = {
    all: (sql, ...params) => duckAll(sql, ...params).then(fixBigInt),
    get: (sql, ...params) => duckGet(sql, ...params).then(fixBigInt),
    run: duckRun,
    exec: duckExec,
    kv,
  };
  console.log(`[DB] DuckDB ready: ${duckPath}`);
}

// ---- Shutdown ---------------------------------------------------------------
function close() {
  return new Promise((resolve) => ddb.close(() => resolve()));
}

function fixBigInt(val) {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(fixBigInt);
  if (typeof val === 'object' && val.constructor === Object) {
    const o = {};
    for (const [k, v] of Object.entries(val)) o[k] = typeof v === 'bigint' ? Number(v) : v;
    return o;
  }
  return typeof val === 'bigint' ? Number(val) : val;
}

module.exports = {
  init, close,
  duckAll: (sql, ...params) => duckAll(sql, ...params).then(fixBigInt),
  duckGet: (sql, ...params) => duckGet(sql, ...params).then(fixBigInt),
  duckRun, duckExec,
};
