-- KirinNet User Node — IM Schema
-- End-to-end encrypted messaging: RSA for key exchange, AES-256-GCM for message body

-- ============================================================
-- Users: Local user identity and RSA key pair
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,          -- Local user UUID
  private_key TEXT NOT NULL,            -- RSA-2048 Private Key (PEM)
  public_key TEXT NOT NULL              -- RSA-2048 Public Key (PEM)
);

-- ============================================================
-- Friends: One-to-one relationship with RSA public key storage
-- ============================================================
CREATE TABLE IF NOT EXISTS friends (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  friend_domain   TEXT NOT NULL UNIQUE, -- e.g., bob.kirinnet.org
  friend_public_key TEXT NOT NULL,      -- Bob's RSA Public Key (PEM)
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Groups: Group chat with shared AES-256 key
-- ============================================================
CREATE TABLE IF NOT EXISTS groups (
  id            TEXT PRIMARY KEY,       -- Group UUID
  name          TEXT NOT NULL,
  owner_domain  TEXT NOT NULL,
  aes_key       TEXT NOT NULL,          -- AES-256 key (Base64)
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Group_Members: Many-to-many between groups and users
-- ============================================================
CREATE TABLE IF NOT EXISTS group_members (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_domain     TEXT NOT NULL,
  member_public_key TEXT NOT NULL,      -- For encrypting the group AES key
  UNIQUE(group_id, member_domain)
);

-- ============================================================
-- Messages: Encrypted message store
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,   -- Message UUID
  chat_id           TEXT NOT NULL,      -- friend_domain (direct) or group_id (group)
  type              TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  sender_domain     TEXT NOT NULL,
  content_encrypted TEXT NOT NULL,      -- Encrypted message body
  content_decrypted TEXT,               -- Decrypted message body (local viewing only)
  timestamp         DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Indexes for fast lookups
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_domain ON group_members(member_domain);
