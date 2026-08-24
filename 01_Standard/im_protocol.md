# KirinNet P2P Instant Messaging Protocol

**Version:** 1.2
**Status:** Draft
**Date:** 2026-08-08

---

## 1. Overview

KirinNet P2P IM is a domain-identity-based, Ed25519-signed and
HPKE-encrypted, peer-to-peer instant messaging protocol. Each User Node
is identified by its domain name. Messages are signed by the sender and
encrypted end-to-end between User Nodes. Identity keys are Ed25519;
session encryption uses HPKE (RFC 9180) with Ed25519→X25519 conversion,
providing per-session Perfect Forward Secrecy (PFS) in v1.

---

## 2. Identity

- **Domain name** is the unique identifier (e.g., `alice.kirinnet.org`)
- Each User Node generates a **Long-term Ed25519 Key Pair** (32-byte
  public key) on startup
- The long-term public key is published via `/kirin/profile`
- The long-term private key is stored locally and never transmitted

---

## 3. Key Management

### 3.1. Long-term Key (Identity Key)

- Generated on first startup (or loaded from storage)
- Used to verify identity during friend requests
- Published in `/kirin/profile` as `identity_key`

### 3.2. Session Key (Friendship Key) — PFS in v1

- Generated when a friend relationship is accepted, via X25519 ECDH
  (each side converts its Ed25519 identity key to X25519 and contributes
  an ephemeral X25519 key for forward secrecy)
- One session per friendship (per-friend isolation)
- Session keys are **rotated** on each session (ECDH ratchet) to provide
  **Perfect Forward Secrecy (PFS)** — compromise of a current session key
  does not reveal past messages
- Used to encrypt/decrypt message bodies via HPKE (AES-256-GCM)
- Stored in the local `friends` table

### 3.3. Key Exchange Flow

```
Alice (alice.kirinnet.org)          Bob (bob.kirinnet.org)
     |                                   |
     |--- POST /kirin/friend/request --->|  Contains Alice's identity_key (Ed25519)
     |                                   |  Bob stores request (status: pending)
     |                                   |
     |<-- POST /kirin/friend/accept ------|  Bob accepts, sends his identity_key (Ed25519)
     |                                   |
     |=== Session Key Exchange (X25519 ECDH + HPKE, PFS) ===|
     |                                   |  Each side generates an ephemeral X25519 key,
     |                                   |  derives a shared secret via ECDH
     |                                   |  (Ed25519 identity key → X25519 conversion),
     |                                   |  and uses HPKE (AES-256-GCM) for the session.
     |<-- Session Confirmed --------------|  Both sides hold the session key.
     |                                   |
     |=== Messages signed (Ed25519) + encrypted (HPKE) with session keys ===|
```

---

## 4. Friend Request Protocol

### 4.1. Send Friend Request

**Alice -> Bob:**

```
POST http://bob.kirinnet.org:9090/kirin/friend/request
Content-Type: application/json

{
  "sender_domain": "alice.kirinnet.org",
  "sender_identity_key": "Base64URL(Ed25519 public key, 32 bytes)",
  "message": "Hey, let's chat!"
}
```

**Response (201):**

```json
{
  "status": "pending",
  "friend_id": "friend-abc123"
}
```

### 4.2. Accept Friend Request

**Bob -> Alice:**

```
POST http://alice.kirinnet.org:8080/kirin/friend/accept
Content-Type: application/json

{
  "friend_domain": "alice.kirinnet.org",
  "receiver_identity_key": "Base64URL(Ed25519 public key, 32 bytes)"
}
```

**Response (200):**

```json
{
  "status": "accepted",
  "friend_id": "friend-abc123"
}
```

### 4.3. Block Friend

**DELETE:**

```
DELETE http://bob.kirinnet.org:9090/kirin/friend/block
Content-Type: application/json

{
  "friend_domain": "alice.kirinnet.org"
}
```

**Response (200):**

```json
{
  "status": "blocked",
  "friend_id": "friend-abc123"
}
```

---

## 5. Messaging Protocol

### 5.1. Send Message

**Alice -> Bob:**

```
POST http://bob.kirinnet.org:9090/kirin/message
Content-Type: application/json

{
  "sender_domain": "alice.kirinnet.org",
  "content": "<HPKE-encrypted with session key (AES-256-GCM)>",
  "signature": "<Ed25519 signature over (content || timestamp || sender_domain), Base64URL>",
  "timestamp": 1234567890
}
```

**Response (201):**

```json
{
  "status": "delivered",
  "message_id": "msg-xyz789"
}
```

### 5.2. Read Messages

**GET:**

```
GET http://localhost:8080/kirin/messages?friend_domain=bob.kirinnet.org
```

**Response (200):**

```json
[
  {
    "id": "msg-xyz789",
    "from": "bob.kirinnet.org",
    "content": "Hello, Alice!",
    "timestamp": 1234567890,
    "read": true
  }
]
```

---

## 6. Data Structures

### 6.1. Friends Table

```sql
CREATE TABLE IF NOT EXISTS friends (
    id              TEXT PRIMARY KEY,
    friend_domain   TEXT NOT NULL UNIQUE,
    friend_identity_key TEXT,          -- Friend's long-term public key
    session_public_key  TEXT,          -- Session public key (for this friendship)
    session_private_key TEXT,          -- Session private key (for this friendship)
    status          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'blocked')),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 6.2. Messages Table

```sql
CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    from_domain   TEXT NOT NULL,
    content       TEXT NOT NULL,       -- Decrypted message content
    timestamp     INTEGER NOT NULL,
    read          BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_domain);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
```

### 6.3. Keys Table

```sql
CREATE TABLE IF NOT EXISTS keys (
    id            TEXT PRIMARY KEY,
    key_type      TEXT NOT NULL,
    private_key   TEXT NOT NULL,
    public_key    TEXT NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 7. Security Model

### 7.1. Why This Is Secure

1. **Only the recipient can decrypt messages:**
   - Messages are encrypted with the recipient's session public key.
   - Only the recipient holds the corresponding session private key.
   - Even if the message is intercepted in transit, the attacker cannot
     decrypt it without the private key.

2. **Identity verification:**
   - Friend requests include the sender's identity key (long-term Ed25519
     public key, published in DNS as `did:dns:pk;kty=ed25519;pk=...`).
   - The recipient can verify the sender's identity by checking the domain
     matches the key published in `/kirin/profile` and the DID-DNS TXT
     record (fingerprint chain, see `did-dns-protocol.md`).

3. **Per-friend key isolation:**
   - Each friendship has its own session key pair.
   - If one session key is compromised, other friendships remain secure.

4. **No central server stores messages:**
   - Messages are stored only on the sender and recipient User Nodes.
   - No aggregator or third party can access message content.

### 7.2. Threat Model

| Threat | Mitigation |
|--------|-----------|
| Eavesdropping | HPKE (AES-256-GCM) encryption ensures only the recipient can decrypt |
| Impersonation | Identity key verification during friend request (Ed25519, DID-DNS fingerprint chain) |
| Message tampering | Ed25519 signature + HPKE integrity — tampering causes signature/decryption failure |
| Key compromise | Per-friend session keys (X25519 ECDH ratchet) limit blast radius |
| Replay attacks | Timestamps and message IDs allow detection; T9 challenge nonce one-time use |

### 7.3. Security Properties and Limitations

- **Perfect Forward Secrecy (PFS) — included in v1 (9.1):** Session keys
  are established via X25519 ECDH with ephemeral keys (Ed25519 identity
  key → X25519 conversion) and ratcheted per session. Compromise of a
  current session key does NOT reveal past messages. (Previously listed
  as a limitation; now resolved per the unified Ed25519 decision.)
- **Authentication of decryption:** If the wrong private key is used,
  HPKE decryption fails (AEAD authentication tag mismatch). The protocol
  relies on the key management service to always use the correct key.
- **Message signing — included in v1 (9.1):** Every message carries an
  Ed25519 signature over `(content || timestamp || sender_domain)`. A
  compromised User Node cannot forge another user's messages without
  their Ed25519 private key.

### 7.4. Signature Challenge-Response (T9 · Final, KNET-CC-011 Signed-off)

> **Status: Final — signed off by Node PM (KNET-CC-011, 2026-08-08
> conditional approval, conditions fulfilled and closed).**
> Basis: `DECISIONS.md` §9.3 (P-ARCH technical specification) and
> `security_model_v1.md` §7.2.1.

Beyond per-message Ed25519 signatures, identity verification between
nodes uses a signature challenge-response flow (T9):

- **Challenge code:** `c = <nonce>:<timestamp>:<hmac>`, where
  `hmac = Base64URL(HMAC-SHA256(secret, "<domain>:<timestamp>:<nonce>")[0:12])`.
  TTL is **60 seconds**; nonce is one-time (replay rejected).
- **Signature coverage (Ed25519 private key signs the canonical
  serialization of):**
  1. The challenge code `c` (plaintext) — anti-tamper + anti-replay.
  2. The verifier's domain (request origin) — anti cross-domain replay.
  3. The prover's domain (identity subject) — binds `did:dns:v=1`.
  4. The flood `forward_chain` (P-FLOOD T1 draft) — anti forward-chain
     tampering/injection.
  5. The T3 trust-weight field (`trust_weight`, int8 -127~100, P-FLOOD T3 draft)
     — anti weight tampering.
- **MUST NOT cover:** transport-layer metadata (HTTP headers, TLS certs,
  IPs) — these are guaranteed by the transport layer.
- **DNS record freshness:** the `iat` of `did:dns:v=1` MUST be within
  ±5 minutes of the current time.

> **P-FLOOD reference:** T1 (flood message format) `forward_chain` and T3
> (trust weight) `trust_weight` (int8 -127~100) fields MUST reference this signature coverage
> (§9.3.2), not redefine it. P-FLOOD drafts must mark "references T9 —
> final, KNET-CC-011 signed-off". **Sign-off record:** T9 signed off by
> Node PM (KNET-CC-011, 2026-08-08 conditional approval, conditions
> fulfilled and closed).

---

> **KirinNet IM Protocol** — Domain-based P2P messaging with Ed25519
> signatures, HPKE encryption, and Perfect Forward Secrecy (PFS) in v1.
> Built on [KirinDNS](spec_v1.md) for seamless node discovery.

---

## 8. 变更记录

| 版本 | 日期 | 变更 | 依据 |
|---|---|---|---|
| 1.0 | 2026-07-09 | 首版（Domain-based P2P IM，RSA 加密草案） | — |
| 1.1 | 2026-08-08 | **C-2（9.4）端点品牌迁移**：全文 10 处旧端点前缀 → `/kirin/*`（friend/profile/message/messages/block）；门禁品牌残留巡检零命中 | 9.4 · C-2 · 波0 |
| 1.2 | 2026-08-08 | **9.1 统一 Ed25519 + PFS 纳入 v1 + T9 签名覆盖（草案）**：§1/§2 密钥 RSA→Ed25519（32 字节）；§3.2/§3.3 session key 改 X25519 ECDH + HPKE + PFS；§4/§5 body 公钥格式与加密改 Ed25519/HPKE + 签名；§7.1/§7.2 威胁表 Ed25519+HPKE；§7.3 PFS/签名从「无」改为「v1 已纳入」；§7.4 新增 T9 签名质询覆盖范围（**草案·待 KNET-CC 会签**） | 9.1 · T9（草案）· KNET-CC-005/006 · 波0 |
| 1.3 | 2026-08-09 | **T9 字段名钉死 `trust_weight`（§7.4）**：§7.4 签名覆盖范围第 5 项信任权重字段 `weight`/`trust_score` → `trust_weight`（int8 -127~100）；P-FLOOD 引用说明 `weight` → `trust_weight`。与 `DECISIONS.md` §9.3.2/§9.3.4/§9.3.5（P-ARCH d1fd221）及节点 02 篇基线一致。**变更说明：**依据 KNET-CC-011 节点 PM 附条件通过（2026-08-08 23:45）+ d1fd221 字段名钉死（2026-08-09），本修订为条件履约；签名覆盖范围是跨实现强一致契约（JCS 规范化签名，字段名须固定），消除 `weight`/`trust_score` 歧义 | T9 · KNET-CC-011（节点 PM 附条件履约）· d1fd221 · 波0 |
