// ============================================================================
// KirinNet User Node — Database (DuckDB + FS)
//
// DuckDB: node identity, content, comments, IM groups, temp keys, addresses
// FS:     /app/data/media for uploaded files
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

const duckPath = path.join(DATA_DIR, 'duckdb', 'kirinnet_user_node.db');
const ddb = new duckdb.Database(duckPath);

// ---- Async wrappers ----------------------------------------------------------
function duckRun(sql, ...params) {
  return new Promise((resolve, reject) => {
    const flat = params.flat(Infinity);
    ddb.run(sql, ...flat, (err) => { if (err) reject(err); else resolve(); });
  });
}

function duckAll(sql, ...params) {
  return new Promise((resolve, reject) => {
    const flat = params.flat(Infinity);
    ddb.all(sql, ...flat, (err, rows) => { if (err) reject(err); else resolve(rows); });
  });
}

function duckGet(sql, ...params) {
  return new Promise((resolve, reject) => {
    const flat = params.flat(Infinity);
    ddb.all(sql, ...flat, (err, rows) => {
      if (err) reject(err);
      else resolve(rows.length > 0 ? rows[0] : null);
    });
  });
}

function duckExec(sql) {
  return new Promise((resolve, reject) => {
    ddb.exec(sql, (err) => { if (err) reject(err); else resolve(); });
  });
}

// ---- Init schema -------------------------------------------------------------
async function init() {
  await duckExec(`
    CREATE SEQUENCE IF NOT EXISTS comments_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS im_groups_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS im_temp_keys_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS addresses_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS followers_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS encrypted_pushes_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS points_tx_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS vip_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS ad_slot_products_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS ad_slot_bids_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS cart_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS favorites_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS history_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS drafts_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS orders_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS coupons_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS payment_methods_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS contacts_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS notifications_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS im_messages_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS content_segments_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS explore_directions_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS explore_results_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS explore_blacklist_seq START 1;

    -- Node identity
    CREATE TABLE IF NOT EXISTS node (
      id         VARCHAR PRIMARY KEY,
      nickname   VARCHAR NOT NULL DEFAULT 'User',
      bio        VARCHAR DEFAULT '',
      avatar     VARCHAR DEFAULT '',
      password   VARCHAR DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Runtime settings (owner toggles via API, survives restarts)
    CREATE TABLE IF NOT EXISTS settings (
      key    VARCHAR PRIMARY KEY,
      value  VARCHAR NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Default settings (initial values)
    INSERT OR IGNORE INTO settings (key, value) VALUES ('public_indexing', 'true');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('ad_slots_per_page', '2');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('ad_reserve_days', '7');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('ad_max_duration_days', '30');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('node_port', '8080');

    -- Push blacklist: domains blocked from pushing content to this indexer
    CREATE TABLE IF NOT EXISTS push_blacklist (
      domain     VARCHAR PRIMARY KEY,
      reason     VARCHAR DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Content (articles, videos, posts, etc.)
    CREATE TABLE IF NOT EXISTS content (
      id              VARCHAR PRIMARY KEY,
      title           VARCHAR NOT NULL,
      description     VARCHAR DEFAULT '',
      content_type    VARCHAR NOT NULL DEFAULT 'article',
      url             VARCHAR NOT NULL,
      thumbnail       VARCHAR DEFAULT '',
      file_size       BIGINT DEFAULT 0,
      mime_type       VARCHAR DEFAULT '',
      visibility      VARCHAR DEFAULT 'public',
      allow_comments  BOOLEAN DEFAULT TRUE,
      comment_permission VARCHAR DEFAULT 'all',
      required_points INTEGER DEFAULT 0,
      required_vip    VARCHAR DEFAULT '',
      tags            VARCHAR DEFAULT '[]',
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      deleted_at      TIMESTAMP
    );

    -- Comments on this node's content
    CREATE TABLE IF NOT EXISTS comments (
      id                 INTEGER PRIMARY KEY DEFAULT nextval('comments_seq'),
      content_id         VARCHAR NOT NULL,
      author_domain      VARCHAR NOT NULL,
      body               TEXT NOT NULL,
      parent_comment_id  INTEGER,
      created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      deleted_at         TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_node_comments_content ON comments(content_id);

    -- ================================================================
    -- IM Groups: friend / trade / custom (managed by node owner)
    -- ================================================================
    CREATE TABLE IF NOT EXISTS im_groups (
      id               INTEGER PRIMARY KEY DEFAULT nextval('im_groups_seq'),
      group_name       VARCHAR NOT NULL,
      group_type       VARCHAR NOT NULL DEFAULT 'custom',
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS im_group_members (
      group_id   INTEGER NOT NULL,
      domain     VARCHAR NOT NULL,
      joined_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, domain)
    );

    -- ================================================================
    -- IM Temporary Keys: for trade, 90-day expiry
    -- ================================================================
    CREATE TABLE IF NOT EXISTS im_temp_keys (
      id              INTEGER PRIMARY KEY DEFAULT nextval('im_temp_keys_seq'),
      from_domain     VARCHAR NOT NULL,
      to_domain       VARCHAR NOT NULL,
      temp_public_key VARCHAR NOT NULL,
      purpose         VARCHAR NOT NULL DEFAULT 'trade',
      status          VARCHAR NOT NULL DEFAULT 'pending',
      expires_at      TIMESTAMP NOT NULL,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      accepted_at     TIMESTAMP
    );

    -- ================================================================
    -- Marketplace Addresses (shipping/payment addresses)
    -- ================================================================
    CREATE TABLE IF NOT EXISTS marketplace_addresses (
      id          INTEGER PRIMARY KEY DEFAULT nextval('addresses_seq'),
      label       VARCHAR NOT NULL DEFAULT 'default',
      recipient   VARCHAR NOT NULL,
      phone       VARCHAR,
      address     VARCHAR NOT NULL,
      city        VARCHAR,
      state       VARCHAR,
      postal_code VARCHAR,
      country     VARCHAR DEFAULT 'CN',
      is_default  BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ================================================================
    -- Ad Slot Products: auctionable ad positions (2 per page, numbered)
    -- Bookable 7d in advance, 1-30 day slots. Revenue → platform owner.
    -- ================================================================
    CREATE TABLE IF NOT EXISTS ad_slot_products (
      id             INTEGER PRIMARY KEY DEFAULT nextval('ad_slot_products_seq'),
      slot_number    INTEGER NOT NULL,
      slot_start_date DATE NOT NULL,
      slot_end_date   DATE NOT NULL,
      base_price     DOUBLE NOT NULL DEFAULT 0,
      current_bid    DOUBLE NOT NULL DEFAULT 0,
      bidder_domain  VARCHAR,
      bid_count      INTEGER DEFAULT 0,
      status         VARCHAR NOT NULL DEFAULT 'open',
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slot_number, slot_start_date)
    );

    CREATE TABLE IF NOT EXISTS ad_slot_bids (
      id            INTEGER PRIMARY KEY DEFAULT nextval('ad_slot_bids_seq'),
      product_id    INTEGER NOT NULL,
      bidder_domain VARCHAR NOT NULL,
      amount        DOUBLE NOT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bids_product ON ad_slot_bids(product_id);

    -- ================================================================
    -- Followers (continued): one-way subscription, follower submits public key
    -- Node auto-encrypts public content for followers on publish
    -- ================================================================
    CREATE TABLE IF NOT EXISTS followers (
      id              INTEGER PRIMARY KEY DEFAULT nextval('followers_seq'),
      follower_domain VARCHAR NOT NULL UNIQUE,
      public_key      VARCHAR NOT NULL,
      subscribed_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ================================================================
    -- Encrypted pushes: per-follower encrypted content keys
    -- ================================================================
    CREATE TABLE IF NOT EXISTS encrypted_pushes (
      id            INTEGER PRIMARY KEY DEFAULT nextval('encrypted_pushes_seq'),
      content_id    VARCHAR NOT NULL,
      follower_domain VARCHAR NOT NULL,
      encrypted_key VARCHAR NOT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(content_id, follower_domain)
    );
    CREATE INDEX IF NOT EXISTS idx_ep_follower ON encrypted_pushes(follower_domain, content_id);

    -- ================================================================
    -- Points: other users can buy/earn points, spend on content
    -- ================================================================
    CREATE TABLE IF NOT EXISTS points_accounts (
      domain      VARCHAR PRIMARY KEY,
      balance     INTEGER NOT NULL DEFAULT 0,
      total_earned INTEGER NOT NULL DEFAULT 0,
      total_spent  INTEGER NOT NULL DEFAULT 0,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS points_transactions (
      id          INTEGER PRIMARY KEY DEFAULT nextval('points_tx_seq'),
      domain      VARCHAR NOT NULL,
      amount      INTEGER NOT NULL,
      reason      VARCHAR NOT NULL,
      ref_id      VARCHAR,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ================================================================
    -- VIP: subscription tiers with expiry
    -- ================================================================
    CREATE TABLE IF NOT EXISTS vip_accounts (
      id          INTEGER PRIMARY KEY DEFAULT nextval('vip_seq'),
      domain      VARCHAR NOT NULL UNIQUE,
      level       VARCHAR NOT NULL DEFAULT 'basic',
      expires_at  TIMESTAMP,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ================================================================
    -- Shopping Cart
    -- ================================================================
    CREATE TABLE IF NOT EXISTS cart (
      id          INTEGER PRIMARY KEY DEFAULT nextval('cart_seq'),
      content_id  VARCHAR NOT NULL,
      domain      VARCHAR NOT NULL,
      qty         INTEGER DEFAULT 1,
      added_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(content_id, domain)
    );

    -- ================================================================
    -- Favorites / Bookmarks
    -- ================================================================
    CREATE TABLE IF NOT EXISTS favorites (
      id          INTEGER PRIMARY KEY DEFAULT nextval('favorites_seq'),
      content_id  VARCHAR NOT NULL,
      domain      VARCHAR NOT NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(content_id, domain)
    );

    -- ================================================================
    -- Browsing History / 足迹
    -- ================================================================
    CREATE TABLE IF NOT EXISTS history (
      id          INTEGER PRIMARY KEY DEFAULT nextval('history_seq'),
      content_id  VARCHAR NOT NULL,
      domain      VARCHAR NOT NULL,
      viewed_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_history_domain ON history(domain, viewed_at);

    -- ================================================================
    -- Content Drafts / 草稿
    -- ================================================================
    CREATE TABLE IF NOT EXISTS drafts (
      id              INTEGER PRIMARY KEY DEFAULT nextval('drafts_seq'),
      content_type    VARCHAR NOT NULL DEFAULT 'article',
      title           VARCHAR DEFAULT '',
      body            TEXT DEFAULT '',
      description     VARCHAR DEFAULT '',
      thumbnail       VARCHAR DEFAULT '',
      comment_permission VARCHAR DEFAULT 'all',
      required_points INTEGER DEFAULT 0,
      required_vip    VARCHAR DEFAULT '',
      saved_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ================================================================
    -- Orders: buy/sell transactions
    -- ================================================================
    CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY DEFAULT nextval('orders_seq'),
      order_type  VARCHAR NOT NULL DEFAULT 'buy',
      buyer       VARCHAR NOT NULL,
      seller      VARCHAR NOT NULL,
      items       VARCHAR NOT NULL DEFAULT '[]',
      total       DOUBLE NOT NULL DEFAULT 0,
      currency    VARCHAR DEFAULT 'CNY',
      status      VARCHAR NOT NULL DEFAULT 'pending',
      note        VARCHAR DEFAULT '',
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer);
    CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller);

    -- ================================================================
    -- Coupons / 优惠卡券
    -- ================================================================
    CREATE TABLE IF NOT EXISTS coupons (
      id          INTEGER PRIMARY KEY DEFAULT nextval('coupons_seq'),
      code        VARCHAR NOT NULL UNIQUE,
      coupon_type VARCHAR NOT NULL DEFAULT 'discount',
      value       DOUBLE NOT NULL DEFAULT 0,
      min_order   DOUBLE DEFAULT 0,
      max_discount DOUBLE,
      expires_at  TIMESTAMP,
      used        BOOLEAN DEFAULT FALSE,
      used_by     VARCHAR,
      used_at     TIMESTAMP,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ================================================================
    -- Payment Methods / 支付收款设置
    -- ================================================================
    CREATE TABLE IF NOT EXISTS payment_methods (
      id          INTEGER PRIMARY KEY DEFAULT nextval('payment_methods_seq'),
      method_type VARCHAR NOT NULL,
      label       VARCHAR NOT NULL,
      account     VARCHAR NOT NULL,
      qr_code     VARCHAR DEFAULT '',
      is_default  BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ================================================================
    -- Contacts: nickname, note, block list
    -- ================================================================
    CREATE TABLE IF NOT EXISTS contacts (
      id          INTEGER PRIMARY KEY DEFAULT nextval('contacts_seq'),
      domain      VARCHAR NOT NULL UNIQUE,
      nickname    VARCHAR DEFAULT '',
      note        VARCHAR DEFAULT '',
      is_blocked  BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ================================================================
    -- Notifications: follow, subscribe, system
    -- ================================================================
    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY DEFAULT nextval('notifications_seq'),
      notify_type VARCHAR NOT NULL DEFAULT 'system',
      title       VARCHAR NOT NULL,
      body        TEXT DEFAULT '',
      from_domain VARCHAR DEFAULT '',
      is_read     BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notify_read ON notifications(is_read, created_at);

    -- ================================================================
    -- IM Messages: group chat + private chat
    -- ================================================================
    CREATE TABLE IF NOT EXISTS im_messages (
      id          INTEGER PRIMARY KEY DEFAULT nextval('im_messages_seq'),
      group_id    INTEGER,
      from_domain VARCHAR NOT NULL,
      to_domain   VARCHAR DEFAULT '',
      body        TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_immsg_group ON im_messages(group_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_immsg_private ON im_messages(from_domain, to_domain, created_at);

    -- ================================================================
    -- Content Segments: chunked content for explore/vector embedding
    -- ================================================================
    CREATE TABLE IF NOT EXISTS content_segments (
      id              INTEGER PRIMARY KEY DEFAULT nextval('content_segments_seq'),
      content_id      VARCHAR NOT NULL,
      segment_index   INTEGER NOT NULL,
      segment_hash    VARCHAR NOT NULL,
      body_sample     VARCHAR DEFAULT '',
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(content_id, segment_index)
    );
    CREATE INDEX IF NOT EXISTS idx_seg_hash ON content_segments(segment_hash);
    CREATE INDEX IF NOT EXISTS idx_seg_content ON content_segments(content_id);

    -- ================================================================
    -- Explore Directions: preset + user-defined exploration topics
    -- ================================================================
    CREATE TABLE IF NOT EXISTS explore_directions (
      id              INTEGER PRIMARY KEY DEFAULT nextval('explore_directions_seq'),
      direction_name  VARCHAR NOT NULL UNIQUE,
      keywords        VARCHAR DEFAULT '',
      icon            VARCHAR DEFAULT '🔍',
      is_preset       BOOLEAN DEFAULT FALSE,
      is_active       BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- ================================================================
    -- Explore Results: collected content per explore direction
    -- ================================================================
    CREATE TABLE IF NOT EXISTS explore_results (
      id              INTEGER PRIMARY KEY DEFAULT nextval('explore_results_seq'),
      direction_id    INTEGER NOT NULL,
      content_hash    VARCHAR NOT NULL,
      title           VARCHAR NOT NULL,
      url             VARCHAR DEFAULT '',
      summary         TEXT DEFAULT '',
      source_domain   VARCHAR DEFAULT '',
      tags            VARCHAR DEFAULT '[]',
      similarity_pct  DOUBLE DEFAULT 100,
      is_saved        BOOLEAN DEFAULT FALSE,
      collected_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_er_hash ON explore_results(content_hash);
    CREATE INDEX IF NOT EXISTS idx_er_dir ON explore_results(direction_id, collected_at);

    -- ================================================================
    -- Explore Blacklist: pattern-based content filtering
    -- ================================================================
    CREATE TABLE IF NOT EXISTS explore_blacklist (
      id              INTEGER PRIMARY KEY DEFAULT nextval('explore_blacklist_seq'),
      pattern         VARCHAR NOT NULL UNIQUE,
      reason          VARCHAR DEFAULT '',
      is_active       BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Preset explore directions
    INSERT INTO explore_directions (direction_name, keywords, icon, is_preset)
    VALUES ('励志', '励志 人生感悟 成长 心灵鸡汤 正能量', '🌟', TRUE)
    ON CONFLICT(direction_name) DO NOTHING;
    INSERT INTO explore_directions (direction_name, keywords, icon, is_preset)
    VALUES ('中考', '中考 初中 考试技巧 复习方法 学习资料', '📚', TRUE)
    ON CONFLICT(direction_name) DO NOTHING;
    INSERT INTO explore_directions (direction_name, keywords, icon, is_preset)
    VALUES ('高考', '高考 高中 考试技巧 志愿填报 学习方法', '🎓', TRUE)
    ON CONFLICT(direction_name) DO NOTHING;
    INSERT INTO explore_directions (direction_name, keywords, icon, is_preset)
    VALUES ('考研', '考研 研究生 复试 调剂 英语政治', '📖', TRUE)
    ON CONFLICT(direction_name) DO NOTHING;
    INSERT INTO explore_directions (direction_name, keywords, icon, is_preset)
    VALUES ('编程', '编程 代码 Python JavaScript Rust 开源', '💻', TRUE)
    ON CONFLICT(direction_name) DO NOTHING;
    INSERT INTO explore_directions (direction_name, keywords, icon, is_preset)
    VALUES ('修理', '修理 DIY 家电维修 汽车修理 工具', '🔧', TRUE)
    ON CONFLICT(direction_name) DO NOTHING;
    INSERT INTO explore_directions (direction_name, keywords, icon, is_preset)
    VALUES ('电路', '电路 电子 单片机 Arduino 嵌入式 硬件', '⚡', TRUE)
    ON CONFLICT(direction_name) DO NOTHING;
    INSERT INTO explore_directions (direction_name, keywords, icon, is_preset)
    VALUES ('音乐', '音乐 乐器 钢琴 吉他 乐理 作曲', '🎵', TRUE)
    ON CONFLICT(direction_name) DO NOTHING;
    INSERT INTO explore_directions (direction_name, keywords, icon, is_preset)
    VALUES ('冥想', '冥想 正念 呼吸 修行 禅修 静心', '🧘', TRUE)
    ON CONFLICT(direction_name) DO NOTHING;

    -- Preset explore blacklist
    INSERT INTO explore_blacklist (pattern, reason, is_active)
    VALUES ('恐怖', '恐怖内容过滤', TRUE)
    ON CONFLICT(pattern) DO NOTHING;
    INSERT INTO explore_blacklist (pattern, reason, is_active)
    VALUES ('血腥', '血腥内容过滤', TRUE)
    ON CONFLICT(pattern) DO NOTHING;
    INSERT INTO explore_blacklist (pattern, reason, is_active)
    VALUES ('暴力', '暴力内容过滤', TRUE)
    ON CONFLICT(pattern) DO NOTHING;
    INSERT INTO explore_blacklist (pattern, reason, is_active)
    VALUES ('犯罪', '犯罪内容过滤', TRUE)
    ON CONFLICT(pattern) DO NOTHING;
    INSERT INTO explore_blacklist (pattern, reason, is_active)
    VALUES ('色情', '色情内容过滤', TRUE)
    ON CONFLICT(pattern) DO NOTHING;
    INSERT INTO explore_blacklist (pattern, reason, is_active)
    VALUES ('赌博', '赌博内容过滤', TRUE)
    ON CONFLICT(pattern) DO NOTHING;

    -- Default IM groups
    INSERT OR IGNORE INTO im_groups (id, group_name, group_type) VALUES (0, '好友', 'friend');
    INSERT OR IGNORE INTO im_groups (id, group_name, group_type) VALUES (-1, '交易', 'trade');
    INSERT OR IGNORE INTO im_groups (id, group_name, group_type) VALUES (-2, '临时联系人', 'temp');
  `);

  // Ensure a node identity row exists
  const existing = await duckGet('SELECT * FROM node LIMIT 1');
  if (!existing) {
    const { v4: uuidv4 } = require('uuid');
    const nodeId = uuidv4();
    await duckRun("INSERT INTO node (id, nickname) VALUES (?, ?)", nodeId, 'User');
    console.log(`[DB] User Node initialized. ID: ${nodeId}`);
    return { id: nodeId, nickname: 'User', bio: '', avatar: '', password: '' };
  }
  console.log(`[DB] DuckDB ready: ${duckPath}`);
  return existing;
}

function close() {
  return new Promise((resolve) => ddb.close(() => resolve()));
}

const DataBase = {
  DATA_DIR,
  init, close,
  all: async (sql, ...params) => duckAll(sql, ...params).then(fixBigInt),
  get: async (sql, ...params) => duckGet(sql, ...params).then(fixBigInt),
  run: duckRun,
  exec: duckExec,

  // Settings API
  async getSetting(key) {
    const row = await duckGet('SELECT value FROM settings WHERE key = ?', key);
    return row ? row.value : null;
  },
  async setSetting(key, value) {
    const row = await duckGet('SELECT key FROM settings WHERE key = ?', key);
    if (row) {
      await duckRun("UPDATE settings SET value = ?, updated_at = now() WHERE key = ?", String(value), key);
    } else {
      await duckRun("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, now())", key, String(value));
    }
  },
  async getSettings() {
    const rows = await duckAll('SELECT key, value, updated_at FROM settings');
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }
};

function fixBigInt(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(fixBigInt);
  if (typeof value === 'object' && value.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    return out;
  }
  return typeof value === 'bigint' ? Number(value) : value;
}

module.exports = DataBase;
