# KirinNet User Node — Storage Architecture

> **Version:** 1.0  
> **Status:** Draft  
> **Design goal:** Lifelong personal node handling massive, multi-modal data under resource constraints (single Docker container, ~1-4 vCPU, ~2-8 GB RAM)

---

## 1. Design Philosophy

KirinNet User Node is not a database server — it is a **personal digital archive**. The storage layer must:

1. **Optimize for writes and time-range scans**, not random OLTP reads.
2. **Compress aggressively** — a user's lifetime of chat messages, media, and metadata should fit in reasonable disk space.
3. **Keep hot data fast, cold data cheap** — recently active chats/groups live in memory-mapped structures; historical data lives in compressed columnar segments.
4. **Be embeddable** — no external service dependencies. Everything runs in-process.

We achieve this with a **three-tier hybrid architecture**:

| Tier | Engine | Role | Data Characteristics |
|------|--------|------|---------------------|
| **Columnar** | DuckDB | Metadata, analytics, time-series | Structured, append-heavy, analytical queries |
| **Key-Value** | RocksDB | Fast identity lookups, routing tables, session state | Small records, point queries, high churn |
| **Object Store** | Local FS (S3-compatible layout) | Raw blobs: media, encrypted message bodies | Large binary, immutable, sequential access |

---

## 2. Columnar Tier — DuckDB

### 2.1 Why DuckDB?

- **Embedded**: single `.duckdb` file, zero config, no daemon.
- **Columnar compression**: timestamp columns compress to ~2-3 bytes/row (vs 8+ in row-store). String arrays (tags) deduplicate automatically.
- **Vectorized execution**: "messages per day per group" aggregations scan 100M+ rows in <1s on a single core.
- **SQL with window functions**: complex queries (unread count, active hours heatmap) are expressible without application code.
- **Append-optimized**: writes are batched into column segments, ideal for chat ingestion.

### 2.2 Schema

```sql
-- ============================================================================
-- Content Index: all published and local content the user owns or caches
-- ============================================================================
CREATE TABLE Content_Index (
    id              UUID        PRIMARY KEY,
    type            VARCHAR     NOT NULL,   -- 'article', 'image', 'video', 'audio', 'file'
    title           VARCHAR,
    description     TEXT,
    mime_type       VARCHAR,
    size_bytes      BIGINT      NOT NULL DEFAULT 0,
    storage_path    VARCHAR     NOT NULL,   -- relative path in Object Store
    ipfs_cid        VARCHAR,                -- IPFS content hash (if published)
    arweave_tx      VARCHAR,                -- Arweave transaction ID
    tags            VARCHAR[],              -- DuckDB native array type
    is_published    BOOLEAN     NOT NULL DEFAULT FALSE,
    is_indexed      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
);

CREATE INDEX idx_content_type   ON Content_Index(type, created_at);
CREATE INDEX idx_content_tags   ON Content_Index(tags);
CREATE INDEX idx_content_pub    ON Content_Index(is_published, is_indexed);

-- ============================================================================
-- Chat Messages: all direct and group messages (encrypted at rest)
-- ============================================================================
CREATE TABLE Chat_Messages (
    id                  UUID        PRIMARY KEY,
    chat_id             VARCHAR     NOT NULL,   -- friend_domain or group_id
    chat_type           VARCHAR     NOT NULL,   -- 'direct' or 'group'
    sender_domain       VARCHAR     NOT NULL,
    content_encrypted   BLOB        NOT NULL,   -- AES-256-GCM encrypted JSON
    content_decrypted   VARCHAR,                -- NULL until first read (decrypt-on-access)
    size_bytes          INTEGER     NOT NULL,
    timestamp           TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_read             BOOLEAN     NOT NULL DEFAULT FALSE,
);

CREATE INDEX idx_msg_chat_time ON Chat_Messages(chat_id, timestamp);
CREATE INDEX idx_msg_unread   ON Chat_Messages(chat_id, is_read) WHERE is_read = FALSE;

-- ============================================================================
-- User Profile: local identity (lives in columnar, cached in KV)
-- ============================================================================
CREATE TABLE User_Profile (
    id              UUID        PRIMARY KEY,
    domain          VARCHAR     NOT NULL UNIQUE,
    nickname        VARCHAR,
    bio             TEXT,
    avatar_path     VARCHAR,                -- path in Object Store
    public_key      TEXT        NOT NULL,   -- Ed25519 (Base64URL)
    private_key     TEXT        NOT NULL,   -- Ed25519 (encrypted at rest)
    created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
);

-- ============================================================================
-- Friends: relationship graph
-- ============================================================================
CREATE TABLE Friends (
    id                  BIGINT      PRIMARY KEY,
    friend_domain       VARCHAR     NOT NULL UNIQUE,
    friend_public_key   TEXT        NOT NULL,   -- Ed25519 (签名+HPKE加密, Ed25519→X25519)
    nickname            VARCHAR,
    status              VARCHAR     NOT NULL DEFAULT 'pending',  -- pending | accepted | blocked
    created_at          TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
);

-- ============================================================================
-- Groups: multi-party chat metadata
-- ============================================================================
CREATE TABLE Groups (
    id              UUID        PRIMARY KEY,
    name            VARCHAR     NOT NULL,
    owner_domain    VARCHAR     NOT NULL,
    aes_key         VARCHAR     NOT NULL,   -- Base64 AES-256 key
    created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
);

CREATE TABLE Group_Members (
    id                  BIGINT      PRIMARY KEY,
    group_id            UUID        NOT NULL REFERENCES Groups(id) ON DELETE CASCADE,
    member_domain       VARCHAR     NOT NULL,
    member_public_key   TEXT        NOT NULL,   -- Ed25519
    UNIQUE(group_id, member_domain)
);

CREATE INDEX idx_gm_group ON Group_Members(group_id);

-- ============================================================================
-- Group_Keys: keys received from other nodes (for joined groups)
-- ============================================================================
CREATE TABLE Group_Keys (
    group_id        UUID        PRIMARY KEY,
    group_name      VARCHAR     NOT NULL,
    owner_domain    VARCHAR     NOT NULL,
    aes_key         VARCHAR     NOT NULL,
    created_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
);

-- ============================================================================
-- DNS Records: cached KirinDNS resolutions (TTL-aware)
-- ============================================================================
CREATE TABLE DNS_Cache (
    domain          VARCHAR     PRIMARY KEY,
    http_port       INTEGER     NOT NULL,
    ws_port         INTEGER     NOT NULL,
    ipfs_cid        VARCHAR,
    public_key      TEXT,                   -- Ed25519
    ttl_seconds     INTEGER     NOT NULL,
    resolved_at     TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at      TIMESTAMP   NOT NULL,
);

CREATE INDEX idx_dns_expires ON DNS_Cache(expires_at);
```

### 2.3 Query Patterns (Why Columnar Wins)

**Pattern 1: "Show me chat activity over the last 30 days, grouped by day"**
```sql
SELECT date_trunc('day', timestamp) AS day,
       count(*) AS msg_count,
       count(DISTINCT chat_id) AS active_chats
FROM Chat_Messages
WHERE timestamp > CURRENT_TIMESTAMP - INTERVAL '30 days'
GROUP BY day ORDER BY day;
```
Columnar scan on `timestamp` only (~40 bytes for 10M rows after compression).

**Pattern 2: "Find all images tagged 'vacation' from 2023"**
```sql
SELECT * FROM Content_Index
WHERE type = 'image'
  AND list_contains(tags, 'vacation')
  AND created_at BETWEEN '2023-01-01' AND '2023-12-31';
```
`list_contains` on DuckDB array type is vectorized; no JOIN needed.

**Pattern 3: "Get unread count per chat"**
```sql
SELECT chat_id, count(*) AS unread
FROM Chat_Messages
WHERE is_read = FALSE
GROUP BY chat_id;
```
Partial index `WHERE is_read = FALSE` makes this a tiny scan.

---

## 3. Key-Value Tier — RocksDB

### 3.1 Why RocksDB?

- **LSM-tree**: write-optimized, ideal for session state that churns rapidly.
- **Sub-millisecond point lookups**: `friends:alice.kirinnet.org` resolves in ~10μs.
- **Prefix scans**: `groups:*` iterates all group metadata in one seek.
- **Embedded**: single static library, no network overhead.
- **Compression**: Snappy/ZSTD built-in.

### 3.2 Key Space Design

```
Namespace:  friends
  Key:      friends:{domain}
  Value:    {"status":"accepted","public_key":"... (Ed25519)","nickname":"Alice","last_seen":"..."}

Namespace:  groups
  Key:      groups:{group_id}
  Value:    {"name":"Tech Chat","owner":"bob.kirinnet.org","member_count":5}

Namespace:  sessions
  Key:      sessions:{websocket_id}
  Value:    {"domain":"alice.kirinnet.org","connected_at":"...","last_ping":"..."}

Namespace:  routing
  Key:      routing:{domain}
  Value:    {"http_port":8080,"ws_port":8082,"last_resolved":"...","ttl":300}

Namespace:  state
  Key:      state:crawl_cursor:{domain}
  Value:    "2024-07-09T12:00:00Z"

Namespace:  config
  Key:      config:{key}
  Value:    arbitrary string
```

### 3.3 What Lives Where (Tier Boundary)

| Data | Columnar (DuckDB) | KV (RocksDB) | Reason |
|------|:---:|:---:|--------|
| Message history | ✅ | - | Analytical queries, time-range scans |
| Friend list | ✅ | ✅ | DB for query/analytics, KV for fast auth lookups |
| Active WS sessions | - | ✅ | Ephemeral, high churn, point queries only |
| DNS resolution cache | ✅ | ✅ | DB for TTL management, KV for sub-ms routing |
| Content index | ✅ | - | Full-text search, tag aggregation |
| Group metadata | ✅ | ✅ | DB for persistence, KV for WS relay path |
| Crawl state cursors | - | ✅ | Tiny, frequent updates, no analytical need |

---

## 4. Object Store — Local FS

### 4.1 Layout

```
/data/
├── media/
│   ├── images/
│   │   └── {yyyy}/{mm}/{uuid}.{ext}
│   ├── videos/
│   │   └── {yyyy}/{mm}/{uuid}.{ext}
│   └── audio/
│       └── {yyyy}/{mm}/{uuid}.{ext}
├── chats/
│   └── {chat_id}/
│       └── attachments/
│           └── {yyyy}/{mm}/{uuid}.{ext}
├── profile/
│   └── avatar.{ext}
├── backups/
│   └── {yyyy}-{mm}-{dd}/
│       ├── metadata.duckdb
│       └── kv_backup/
└── cache/
    └── ipfs_pins/          # Locally pinned IPFS blocks
```

### 4.2 Design Rationale

- **S3-compatible layout**: `/{bucket}/{prefix}/{key}` pattern. Can be swapped for MinIO or cloud object storage by changing the base path.
- **Content-addressed within type/year/month**: avoids giant flat directories. 10M images spread across 120 months = ~83K files/month = manageable.
- **Immutable blobs**: once written, never modified. Simplifies backup (rsync --ignore-existing).
- **User_Profile.avatar_path** and **Content_Index.storage_path** point here.

---

## 5. Migration Path from SQLite

The current `07_User_Node/models/schema.sql` uses SQLite. Migration strategy:

### Phase 1: Dual-write (current state)
- Keep SQLite for Friends/Groups/Messages (existing code).
- Deploy DuckDB as read-only analytics mirror.

### Phase 2: Cutover
- Run `sqlite3 → DuckDB` export tool (one-time).
- Replace `better-sqlite3` with `duckdb` Node.js binding in `models/database.js`.
- SQL syntax is 95% compatible; only minor adjustments (UUID type, ARRAY type, BLOB handling).

### Phase 3: KV extraction
- Move `Friends` (for auth), `DNS_Cache` (for routing), and session state to RocksDB.
- Keep DuckDB for historical/analytical queries.

---

## 6. Resource Budget

For a typical user node (Docker container, 2 vCPU, 4 GB RAM):

| Component | Memory | Disk (year 1) | Disk (year 5) |
|-----------|--------|---------------|---------------|
| DuckDB (in-memory working set) | 256 MB | - | - |
| DuckDB (persistent file) | - | ~500 MB | ~2 GB |
| RocksDB | 128 MB | ~100 MB | ~500 MB |
| Object Store (media) | - | ~20 GB | ~100 GB |
| OS + runtime overhead | 512 MB | - | - |
| **Total** | **~900 MB** | **~21 GB** | **~103 GB** |

Well within a single Docker volume on consumer hardware.

---

## 7. Open Questions

1. **Encryption at rest for DuckDB/RocksDB?** DuckDB supports encryption via custom VFS. RocksDB has built-in encryption support. Worth enabling for production.
2. **Backup strategy?** Object store + KV snapshot to `/data/backups/` on cron. DuckDB file can be copied while open (WAL mode).
3. **Message retention policy?** Keep all by default (lifelong archive). Optional user-configurable auto-delete for media attachments > N months.
4. **Multi-device sync?** Not in scope for v1. This is a single-node architecture.
