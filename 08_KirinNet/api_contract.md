# KirinNet — API Contract

This document defines the RESTful API for the KirinNet Platform.
All APIs are served at `https://api.kirinnet.org/v1`.

---

## Authentication

All write operations (POST/PUT/DELETE) require authentication via a
JWT (JSON Web Token) obtained from the `/auth/login` endpoint.

- **Authorization header:** `Bearer <token>`
- **Token validity:** 24 hours
- **Refresh:** `/auth/refresh`

---

## 1. Auth API

### POST /auth/login

Authenticate a user with their email and password.

**Request:**
```json
{
  "email": "alice@kirinnet.org",
  "password": "hashed_password"
}
```

**Response (200):**
```json
{
  "token": "eyJhbGci...",
  "refresh_token": "dGhpcyBpcyBhIHJlZnJl...",
  "expires_in": 86400
}
```

### POST /auth/refresh

Refresh an expired access token.

**Request:**
```json
{
  "refresh_token": "dGhpcyBpcyBhIHJlZnJl..."
}
```

**Response (200):**
```json
{
  "token": "eyJhbGci...",
  "expires_in": 86400
}
```

### POST /auth/register

Register a new user account.

**Request:**
```json
{
  "email": "alice@kirinnet.org",
  "password": "hashed_password",
  "domain": "alice.kirinnet.org",
  "public_key": "0x04abc..."  -- ECDSA public key
}
```

**Response (201):**
```json
{
  "token": "eyJhbGci...",
  "user_id": "user_abc123",
  "domain": "alice.kirinnet.org"
}
```

---

## 2. Publish API

### POST /v1/publish

Submit content metadata to the KirinNet index. The raw content must
already be on IPFS or Arweave.

**Authentication:** Required

**Request:**
```json
{
  "title": "My First KirinNet Video",
  "description": "A video about decentralized content platforms",
  "cid": "QmXoyp...",
  "storage_type": "ipfs",
  "category": "video",
  "tags": ["decentralized", "web3", "kirindns"],
  "signature": "0x123abc...",
  "thumbnail_cid": "QmThumb..."  -- optional
}
```

**Response (201):**
```json
{
  "content_id": "content_xyz789",
  "title": "My First KirinNet Video",
  "cid": "QmXoyp...",
  "storage_type": "ipfs",
  "creator_domain": "alice.kirinnet.org",
  "created_at": "2025-07-15T10:30:00Z",
  "url": "https://kirinnet.org/content/content_xyz789"
}
```

**Validation rules:**
- `title` required, max 200 characters
- `cid` required, must be a valid IPFS CID or Arweave tx-id
- `storage_type` required, must be `ipfs` or `arweave`
- `category` required, must be one of: `video`, `article`, `audio`, `image`, `other`
- `signature` required, must be a valid ECDSA signature
- `tags` optional, max 10 tags, each max 30 characters

**Signature verification:**

The API verifies the signature before indexing:

```
message = SHA256(title + description + cid + creator_domain + created_at)
verify(ECDSS_Verify(message, signature, creator_public_key))
```

If the signature is invalid, the API returns 400.

**Response (400) — invalid signature:**
```json
{
  "error": "invalid_signature",
  "message": "The metadata signature does not match the creator's public key"
}
```

---

## 3. Search API

### GET /v1/search

Search the KirinNet content index. De-indexed content is excluded from results.

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| q | string | Yes | Search query (full-text) |
| category | string | No | Filter by category |
| tags | string | No | Filter by tags (comma-separated) |
| sort | string | No | Sort order: `relevance`, `newest`, `oldest`, `most_viewed` (default: `relevance`) |
| limit | integer | No | Max results (default: 20, max: 100) |
| offset | integer | No | Pagination offset (default: 0) |

**Response (200):**
```json
{
  "total": 142,
  "limit": 20,
  "offset": 0,
  "results": [
    {
      "content_id": "content_xyz789",
      "title": "My First KirinNet Video",
      "description": "A video about decentralized content platforms",
      "cid": "QmXoyp...",
      "storage_type": "ipfs",
      "category": "video",
      "tags": ["decentralized", "web3", "kirindns"],
      "creator_domain": "alice.kirinnet.org",
      "creator_name": "Alice",
      "view_count": 1234,
      "created_at": "2025-07-15T10:30:00Z",
      "thumbnail_url": "https://gateway.kirinnet.org/ipfs/QmThumb..."
    }
  ]
}
```

### GET /v1/search/trending

Get trending content (top 50 by view count in the last 24 hours).

**Response (200):**
```json
{
  "period": "24h",
  "results": [
    {
      "content_id": "content_xyz789",
      "title": "Trending Video",
      "view_count": 5678,
      "creator_domain": "bob.kirinnet.org",
      "category": "video"
    }
  ]
}
```

---

## 4. Profile API

### GET /v1/profile/:domain

Fetch a user's profile metadata. The API resolves the KirinDNS TXT record
for the domain and combines it with the indexed content.

**URL:** `GET /v1/profile/alice.kirinnet.org`

**Response (200):**
```json
{
  "domain": "alice.kirinnet.org",
  "name": "Alice",
  "bio": "Decentralized content creator",
  "public_key": "0x04abc...",
  "aura_dns": {
    "http": 8080,
    "ipfs_cid": "QmProfile..."
  },
  "content_count": 42,
  "total_views": 123456,
  "content": [
    {
      "content_id": "content_xyz789",
      "title": "My First KirinNet Video",
      "category": "video",
      "view_count": 1234,
      "created_at": "2025-07-15T10:30:00Z",
      "de_indexed": false
    }
  ]
}
```

**KirinDNS resolution flow:**

1. The API queries the KirinDNS TXT record for `alice.kirinnet.org` via DoH.
2. Parses the JSON to extract port and CID information.
3. Combines with the user's indexed content from the database.
4. Returns the combined profile.

**Response (404) — domain not found:**
```json
{
  "error": "profile_not_found",
  "message": "No KirinDNS TXT record found for alice.kirinnet.org"
}
```

### GET /v1/profile/:domain/content

Fetch all content published by a specific user. Includes de-indexed content
if the viewer is authenticated as the creator.

**URL:** `GET /v1/profile/alice.kirinnet.org/content?limit=20&offset=0`

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| limit | integer | No | Max results (default: 20, max: 100) |
| offset | integer | No | Pagination offset (default: 0) |
| include_de_indexed | boolean | No | Include de-indexed content (default: false) |

**Response (200):**
```json
{
  "total": 42,
  "limit": 20,
  "offset": 0,
  "results": [
    {
      "content_id": "content_xyz789",
      "title": "My First KirinNet Video",
      "cid": "QmXoyp...",
      "storage_type": "ipfs",
      "category": "video",
      "view_count": 1234,
      "de_indexed": false,
      "created_at": "2025-07-15T10:30:00Z"
    }
  ]
}
```

---

## 5. Content API

### GET /v1/content/:content_id

Fetch a single content item by ID.

**URL:** `GET /v1/content/content_xyz789`

**Response (200):**
```json
{
  "content_id": "content_xyz789",
  "title": "My First KirinNet Video",
  "description": "A video about decentralized content platforms",
  "cid": "QmXoyp...",
  "storage_type": "ipfs",
  "category": "video",
  "tags": ["decentralized", "web3", "kirindns"],
  "creator_domain": "alice.kirinnet.org",
  "creator_name": "Alice",
  "view_count": 1234,
  "de_indexed": false,
  "created_at": "2025-07-15T10:30:00Z",
  "updated_at": "2025-07-15T10:30:00Z",
  "direct_url": "https://gateway.kirinnet.org/ipfs/QmXoyp...",
  "kirindns_url": "http://alice.kirinnet.org:8080"
}
```

The response includes two URLs:
- `direct_url`: The KirinNet Gateway proxy URL (works without KirinDNS extension).
- `kirindns_url`: The direct ADRP-resolved URL (requires KirinDNS extension).

### PUT /v1/content/:content_id

Update content metadata. Only the creator can update their own content.

**Authentication:** Required

**Request:**
```json
{
  "title": "Updated Title",
  "description": "Updated description",
  "tags": ["decentralized", "web3", "kirindns", "updated"],
  "signature": "0x456def..."
}
```

**Response (200):**
```json
{
  "content_id": "content_xyz789",
  "title": "Updated Title",
  "description": "Updated description",
  "updated_at": "2025-07-15T12:00:00Z"
}
```

**Response (403) — not the creator:**
```json
{
  "error": "forbidden",
  "message": "Only the creator can update this content"
}
```

### DELETE /v1/content/:content_id

Remove content from the KirinNet index. The raw content on IPFS/Arweave
is NOT deleted.

**Authentication:** Required (creator only)

**Response (204):** No content (deletion successful)

**Response (403):**
```json
{
  "error": "forbidden",
  "message": "Only the creator can delete this content"
}
```

---

## 6. Moderation API

### POST /v1/moderate

Flag content for moderator review.

**Authentication:** Required

**Request:**
```json
{
  "content_id": "content_xyz789",
  "reason": "violence",
  "description": "This content contains graphic violence"
}
```

**Valid reasons:** `violence`, `hate_speech`, `spam`, `copyright`,
`adult_content`, `misinformation`, `other`

**Response (201):**
```json
{
  "report_id": "report_abc123",
  "content_id": "content_xyz789",
  "reason": "violence",
  "status": "pending",
  "created_at": "2025-07-15T14:00:00Z"
}
```

### GET /v1/moderate/reports

Get moderation reports. Only moderators and admins can access.

**Authentication:** Required (moderator role)

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| status | string | No | Filter by status: `pending`, `resolved`, `dismissed` |
| limit | integer | No | Max results (default: 20) |
| offset | integer | No | Pagination offset |

**Response (200):**
```json
{
  "total": 15,
  "reports": [
    {
      "report_id": "report_abc123",
      "content_id": "content_xyz789",
      "title": "My First KirinNet Video",
      "reason": "violence",
      "description": "This content contains graphic violence",
      "reported_by": "user_def456",
      "status": "pending",
      "created_at": "2025-07-15T14:00:00Z"
    }
  ]
}
```

### PUT /v1/moderate/reports/:report_id

Resolve a moderation report. Only moderators can resolve reports.

**Authentication:** Required (moderator role)

**Request:**
```json
{
  "action": "de_index",
  "reason": "Content violates community guidelines (violence)"
}
```

**Valid actions:**

| Action | Description |
|--------|-------------|
| `de_index` | De-index the content from search/recommendations |
| `dismiss` | Dismiss the report; content remains indexed |
| `warning` | Issue a warning to the creator; content remains indexed |

**Response (200):**
```json
{
  "report_id": "report_abc123",
  "action": "de_index",
  "status": "resolved",
  "resolved_by": "moderator_ghi789",
  "resolved_at": "2025-07-15T15:00:00Z"
}
```

---

## 7. Analytics API

### GET /v1/analytics/:content_id

Get view analytics for a content item. Only the creator or moderators can access.

**Authentication:** Required

**Query parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| period | string | No | Time period: `24h`, `7d`, `30d`, `all` (default: `all`) |

**Response (200):**
```json
{
  "content_id": "content_xyz789",
  "total_views": 1234,
  "period": "all",
  "daily_views": [
    {"date": "2025-07-15", "views": 45},
    {"date": "2025-07-16", "views": 123},
    {"date": "2025-07-17", "views": 89}
  ]
}
```

---

## 8. Error Response Format

All errors return a consistent JSON format:

```json
{
  "error": "error_code",
  "message": "Human-readable error message",
  "details": {}  -- optional, additional context
}
```

**Common error codes:**

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 400 | `invalid_request` | Malformed request body |
| 400 | `invalid_signature` | Metadata signature verification failed |
| 400 | `invalid_cid` | CID is not a valid IPFS CID or Arweave tx-id |
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 404 | `not_found` | Resource not found |
| 404 | `profile_not_found` | No KirinDNS TXT record for the domain |
| 429 | `rate_limited` | Too many requests |
| 500 | `internal_error` | Internal server error |

---

## 9. Rate Limiting

| Endpoint | Rate Limit |
|----------|------------|
| /auth/login | 10 requests per minute per IP |
| /v1/publish | 30 requests per minute per user |
| /v1/search | 100 requests per minute per IP |
| /v1/profile | 60 requests per minute per IP |
| /v1/moderate | 20 requests per minute per user |

Rate limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1721064000
```

---

## 10. Example: Full Publish and Search Flow

### Step 1: Upload content to IPFS

```bash
curl -X POST "https://ipfs.infura.io:5001/api/v0/add" \
  --data-binary @video.mp4
# Response: {"Hash": "QmXoyp...", "Size": "12345"}
```

### Step 2: Sign the metadata

```bash
# On the user's device:
message = SHA256("My Video" + "Description" + "QmXoyp..." + "alice.kirinnet.org" + "2025-07-15T10:30:00Z")
signature = ECDSA_Sign(message, alice_private_key)
```

### Step 3: Publish to KirinNet

```bash
curl -X POST "https://api.kirinnet.org/v1/publish" \
  -H "Authorization: Bearer eyJhbGci..." \
  -H "Content-Type: application/json" \
  -d '{
    "title": "My Video",
    "description": "A video about decentralized content",
    "cid": "QmXoyp...",
    "storage_type": "ipfs",
    "category": "video",
    "tags": ["decentralized", "web3"],
    "signature": "0x123abc..."
  }'
# Response: 201 Created
```

### Step 4: Update KirinDNS TXT record

```bash
# Via Cloudflare API or DNS provider:
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/.../dns_records/..." \
  -H "Authorization: Bearer {api_token}" \
  -d '{"type":"TXT","name":"alice.kirinnet.org","content":"{\"http\":8080,\"ipfs_cid\":\"QmXoyp...\"}"}'
```

### Step 5: Search for the content

```bash
curl "https://api.kirinnet.org/v1/search?q=decentralized&category=video"
# Response: includes "My Video" in results
```

### Step 6: View the content

- **With KirinDNS extension:** Navigate to `alice.kirinnet.org` — extension
  resolves the TXT record, discovers port 8080 and CID, fetches from IPFS.
- **Without extension:** Navigate to `https://gateway.kirinnet.org/ipfs/QmXoyp...`
  — KirinNet Gateway proxies the IPFS content.
- **Direct IPFS:** Navigate to `https://gateway.ipfs.io/ipfs/QmXoyp...`
  — public IPFS gateway.
