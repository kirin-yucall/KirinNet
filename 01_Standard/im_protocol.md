# KirinNet P2P Instant Messaging Protocol

**Version:** 1.0
**Status:** Draft
**Date:** 2026-07-09

---

## 1. Overview

KirinNet P2P IM is a domain-identity-based, RSA-encrypted, peer-to-peer
instant messaging protocol. Each User Node is identified by its domain
name. Messages are encrypted end-to-end between User Nodes.

---

## 2. Identity

- **Domain name** is the unique identifier (e.g., `alice.kirinnet.org`)
- Each User Node generates a **Long-term RSA Key Pair** (4096-bit) on startup
- The long-term public key is published via `/aura/profile`
- The long-term private key is stored locally and never transmitted

---

## 3. Key Management

### 3.1. Long-term Key (Identity Key)

- Generated on first startup (or loaded from storage)
- Used to verify identity during friend requests
- Published in `/aura/profile` as `identity_key`

### 3.2. Session Key (Friendship Key)

- Generated when a friend relationship is accepted
- One key pair per friendship (per-friend isolation)
- Used to encrypt/decrypt messages between the two friends
- Stored in the local `friends` table

### 3.3. Key Exchange Flow

```
Alice (alice.kirinnet.org)          Bob (bob.kirinnet.org)
     |                                   |
     |--- POST /aura/friend/request --->|  Contains Alice's identity_key
     |                                   |  Bob stores request (status: pending)
     |                                   |
     |<-- POST /aura/friend/accept ------|  Bob accepts, sends his identity_key
     |                                   |
     |=== Session Key Exchange ===|  Alice generates session key pair,
     |                                   |  encrypts session public key with
     |                                   |  Bob's identity public key, sends it
     |<-- Session Key Confirmed ---------|  Bob decrypts with his identity private key
     |                                   |
     |=== Messages encrypted with session keys ===|
```

---

## 4. Friend Request Protocol

### 4.1. Send Friend Request

**Alice -> Bob:**

```
POST http://bob.kirinnet.org:9090/aura/friend/request
Content-Type: application/json

{
  "sender_domain": "alice.kirinnet.org",
  "sender_identity_key": "-----BEGIN RSA PUBLIC KEY-----\n...",
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
POST http://alice.kirinnet.org:8080/aura/friend/accept
Content-Type: application/json

{
  "friend_domain": "alice.kirinnet.org",
  "receiver_identity_key": "-----BEGIN RSA PUBLIC KEY-----\n..."
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
DELETE http://bob.kirinnet.org:9090/aura/friend/block
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
POST http://bob.kirinnet.org:9090/aura/message
Content-Type: application/json

{
  "sender_domain": "alice.kirinnet.org",
  "content": "<RSA-OAEP encrypted with Bob's session public key>",
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
GET http://localhost:8080/aura/messages?friend_domain=bob.kirinnet.org
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
   - Friend requests include the sender's identity key (long-term RSA public key).
   - The recipient can verify the sender's identity by checking the domain
     matches the key published in `/aura/profile`.

3. **Per-friend key isolation:**
   - Each friendship has its own session key pair.
   - If one session key is compromised, other friendships remain secure.

4. **No central server stores messages:**
   - Messages are stored only on the sender and recipient User Nodes.
   - No aggregator or third party can access message content.

### 7.2. Threat Model

| Threat | Mitigation |
|--------|-----------|
| Eavesdropping | RSA encryption ensures only the recipient can decrypt |
| Impersonation | Identity key verification during friend request |
| Message tampering | RSA encryption integrity — tampering causes decryption failure |
| Key compromise | Per-friend session keys limit blast radius |
| Replay attacks | Timestamps and message IDs allow detection |

### 7.3. Limitations

- **No perfect forward secrecy:** If a session private key is compromised,
  all past messages encrypted with that key can be decrypted.
  For PFS, ECDH key exchange would be needed (future enhancement).
- **No authentication of decryption:** If the wrong private key is used,
  decryption fails silently (random bytes). The protocol relies on the
  key management service to always use the correct key.
- **No message signing:** Messages are encrypted but not signed. A
  compromised User Node could forge messages. (Future: add ECDSA signing.)

---

> **KirinNet IM Protocol** — Domain-based P2P messaging with RSA encryption.
> Built on [KirinDNS](spec_v1.md) for seamless node discovery.
