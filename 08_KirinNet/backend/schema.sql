-- ============================================================================
-- KirinNet Database Schema
-- PostgreSQL
--
-- Matches architecture.md Section 3.2 and api_contract.md.
-- ============================================================================

-- Users table (identity + auth)
CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    domain        TEXT NOT NULL UNIQUE,
    public_key    TEXT NOT NULL,
    display_name  TEXT,
    bio           TEXT,
    avatar_cid    TEXT,                     -- IPFS CID for avatar image
    role          TEXT NOT NULL DEFAULT 'creator',  -- 'creator', 'moderator', 'admin'
    created_at    TIMESTAMP DEFAULT NOW(),
    updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_domain ON users(domain);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- Content table
CREATE TABLE IF NOT EXISTS content (
    id               BIGSERIAL PRIMARY KEY,
    cid              TEXT NOT NULL,           -- IPFS CID or Arweave tx-id
    storage_type     TEXT NOT NULL,           -- 'ipfs' or 'arweave'
    title            TEXT NOT NULL,
    description      TEXT,
    category         TEXT NOT NULL CHECK (category IN ('post', 'video', 'article', 'audio', 'image', 'other')),
    tags             TEXT[],                  -- Array of tags (max 10)
    creator_domain   TEXT NOT NULL REFERENCES users(domain),
    creator_key      TEXT NOT NULL,           -- Public key of creator at publish time
    signature        TEXT NOT NULL,           -- ECDSA signature of metadata
    thumbnail_cid    TEXT,                    -- Optional thumbnail CID
    view_count       INTEGER DEFAULT 0,
    is_indexed       BOOLEAN DEFAULT TRUE,    -- false when de-indexed by moderation
    de_indexed_reason TEXT,                   -- Reason for de-indexing
    de_indexed_by    TEXT,                    -- Moderator who de-indexed
    de_indexed_at    TIMESTAMP,
    created_at       TIMESTAMP DEFAULT NOW(),
    updated_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_content_is_indexed ON content(is_indexed);
CREATE INDEX idx_content_category ON content(category);
CREATE INDEX idx_content_creator ON content(creator_domain);
CREATE INDEX idx_content_tags ON content USING gin(tags);
CREATE INDEX idx_content_storage_type ON content(storage_type);
CREATE INDEX idx_content_view_count ON content(view_count DESC);
CREATE INDEX idx_content_search ON content USING gin(
    to_tsvector('english', title || ' ' || COALESCE(description, ''))
);

-- Refresh tokens for JWT auth
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token         TEXT NOT NULL UNIQUE,
    expires_at    TIMESTAMP NOT NULL,
    revoked       BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- Moderation reports
CREATE TABLE IF NOT EXISTS moderation_reports (
    id            BIGSERIAL PRIMARY KEY,
    content_id    BIGINT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    reported_by   BIGINT NOT NULL REFERENCES users(id),
    reason        TEXT NOT NULL CHECK (reason IN (
                    'violence', 'hate_speech', 'spam',
                    'copyright', 'adult_content', 'misinformation', 'other'
                  )),
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'resolved', 'dismissed')),
    resolved_by   BIGINT REFERENCES users(id),
    resolved_at   TIMESTAMP,
    created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_reports_status ON moderation_reports(status);
CREATE INDEX idx_reports_content ON moderation_reports(content_id);

-- View analytics (daily aggregates)
CREATE TABLE IF NOT EXISTS view_analytics (
    id            BIGSERIAL PRIMARY KEY,
    content_id    BIGINT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    date          DATE NOT NULL,
    views         INTEGER DEFAULT 0,
    UNIQUE(content_id, date)
);

CREATE INDEX idx_analytics_content ON view_analytics(content_id);
CREATE INDEX idx_analytics_date ON view_analytics(date);

-- ============================================================================
-- Ingestion Log — audit trail for content indexing
-- ============================================================================

CREATE TABLE IF NOT EXISTS ingestion_log (
    id              BIGSERIAL PRIMARY KEY,
    content_id      BIGINT NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    action          TEXT NOT NULL CHECK (action IN ('indexed', 'updated', 'de_indexed', 're_indexed')),
    source_node     TEXT,                                        -- Domain of the node that submitted the content
    cid             TEXT NOT NULL,                               -- CID at time of action
    details         JSONB,                                       -- Extra context (e.g., tags changed, reason)
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_content ON ingestion_log(content_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_action ON ingestion_log(action);
CREATE INDEX IF NOT EXISTS idx_ingestion_created ON ingestion_log(created_at DESC);

-- ============================================================================
-- Marketplace — Product indexing & trading
-- Mirrors user-node Products/Variants for search and discovery.
-- ============================================================================

CREATE TABLE IF NOT EXISTS marketplace_products (
    id              BIGSERIAL PRIMARY KEY,
    source_domain   TEXT NOT NULL,                              -- Domain of the node that owns this listing
    source_id       TEXT NOT NULL,                              -- Product UUID on the source node
    type            TEXT NOT NULL CHECK (type IN ('simple', 'goods')),
    title           TEXT NOT NULL,
    description     TEXT,
    category        TEXT NOT NULL DEFAULT 'other'
                    CHECK (category IN ('clothing','electronics','books','home','beauty','sports','other')),
    base_price      REAL NOT NULL DEFAULT 0,
    currency        TEXT NOT NULL DEFAULT 'CNY' CHECK (currency IN ('CNY', 'XRP')),
    payment_methods TEXT[] NOT NULL DEFAULT ARRAY['alipay'],
    condition       TEXT NOT NULL DEFAULT 'used' CHECK (condition IN ('new', 'used')),
    location        TEXT,
    tags            TEXT[],
    xrp_address     TEXT,
    alipay_qr       TEXT,
    cover_cid       TEXT,                                      -- IPFS CID of cover image
    status          TEXT NOT NULL DEFAULT 'listed'             -- listed | sold | removed
                    CHECK (status IN ('listed', 'sold', 'removed')),
    view_count      INTEGER DEFAULT 0,
    like_count      INTEGER DEFAULT 0,
    indexed_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(source_domain, source_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_products_category ON marketplace_products(category);
CREATE INDEX IF NOT EXISTS idx_mp_products_status ON marketplace_products(status);
CREATE INDEX IF NOT EXISTS idx_mp_products_domain ON marketplace_products(source_domain);
CREATE INDEX IF NOT EXISTS idx_mp_products_price ON marketplace_products(base_price);
CREATE INDEX IF NOT EXISTS idx_mp_products_tags ON marketplace_products USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_mp_products_search ON marketplace_products USING gin(
    to_tsvector('simple', title || ' ' || COALESCE(description, ''))
);
CREATE INDEX IF NOT EXISTS idx_mp_products_created ON marketplace_products(indexed_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_variants (
    id              BIGSERIAL PRIMARY KEY,
    product_id      BIGINT NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
    source_variant_id INTEGER,                                  -- Variant row ID on source node
    sku             TEXT NOT NULL,
    attributes      JSONB NOT NULL DEFAULT '{}',
    price_modifier  REAL NOT NULL DEFAULT 0,
    stock           INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'sold_out')),
    UNIQUE(product_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_mp_variants_product ON marketplace_variants(product_id);

CREATE TABLE IF NOT EXISTS marketplace_media (
    id              BIGSERIAL PRIMARY KEY,
    product_id      BIGINT NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
    variant_id      BIGINT REFERENCES marketplace_variants(id) ON DELETE SET NULL,
    ipfs_cid        TEXT NOT NULL,
    is_cover        BOOLEAN DEFAULT FALSE,
    order_index     INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mp_media_product ON marketplace_media(product_id);
CREATE INDEX IF NOT EXISTS idx_mp_media_cover ON marketplace_media(product_id, is_cover);
