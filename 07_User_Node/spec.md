# KirinNet User Node Specification

**Version:** 1.0  
**Status:** Draft  
**Date:** 2026-07-09

---

The User Node is the foundational building block of the KirinNet federated
ecosystem. It is a self-hosted Docker service where users store their raw
data (videos, articles, media) and manage access permissions. The User Node
serves as the single source of truth for a user's content, while the
Aggregator (see 08_KirinNet) indexes only lightweight metadata for discovery.

---

## 1. Core Philosophy

- **Data Resides on User Node:** All raw files (videos, articles, images,
  audio) and detailed profiles are stored on the user's Docker instance.
- **Aggregator Indexes Only:** The public platform stores only lightweight
  metadata (titles, descriptions, CIDs) for search and recommendation.
- **KirinDNS Discovery:** The User Node's existence and connectivity are
  announced via KirinDNS TXT records, enabling automatic discovery.
- **Permission Control:** The User Node enforces access control (passwords,
  API keys). The Aggregator must respect these rules.
- **Censorship Resistance:** Because raw content lives on the user's own
  infrastructure, the Aggregator can de-index content from discovery but
  cannot delete what users have published.

---

## 2. Architecture Overview

```
+---------------------+          KirinDNS TXT           +----------------+
|     User Node       |  <-- discovery/resolution -->  |   Public DNS   |
|  (Docker Container) |                                +----------------+
|                     |                                 ^
|  +---------------+  |                                 |
|  | Express API   |  |         HTTP/HTTPS              |
|  +---------------+  |         (ADRP port)             |
|          |          |                                 |
|  +-------▼-------+  |                                 |
|  | Static Files  |  |                                 |
|  | (media root)  |  |                                 |
|  +---------------+  |                                 |
|          |          |                                 |
|  +-------▼-------+  |                                 |
|  | SQLite DB     |  |                                 |
|  | (metadata)    |  |                                 |
|  +---------------+  |                                 |
+---------------------+                                 |
                                                        |
+------------------+                                    |
|  Aggregator      |  <-- metadata sync (polling) -->   |
|  (08_KirinNet)    |  + IPFS/Arweave content fetch      |
+------------------+                                    |
```

The User Node is a lightweight, single-container service designed to run on
consumer hardware (a Raspberry Pi, a home server, or a cheap VPS). It requires
no external database or message queue.

---

## 3. Functionality

### 3.1. Storage

The User Node stores all raw files in a mounted volume:

```
/data/
├── media/          # Uploaded media files (videos, images, audio)
├── articles/       # Markdown or HTML articles
├── profile/
│   ├── avatar.jpg  # Profile picture
│   └── cover.jpg   # Cover image
└── db/
    └── auranode.db # SQLite database (metadata, permissions)
```

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `/data` | Root directory for all user data |
| `MAX_FILE_SIZE` | `5368709120` | Max upload size in bytes (5 GB default) |
| `ALLOWED_MIME_TYPES` | See below | Comma-separated list of allowed MIME types |

**Default allowed MIME types:**

- `video/mp4, video/webm, video/ogg`
- `image/jpeg, image/png, image/gif, image/webp`
- `audio/mp3, audio/ogg, audio/wav, audio/flac`
- `text/markdown, text/html, application/pdf`

Files with disallowed MIME types are rejected at upload time with a 415
status code.

### 3.2. RESTful API

All API endpoints are served under the `/aura/` prefix. The User Node also
serves static files directly from `/data/media/` at the root path.

#### 3.2.1. Profile Endpoint

**GET /aura/profile**

Returns the user's public profile metadata.

**Response (200):**

```json
{
  "id": "user-abc123def456",
  "nickname": "Alice",
  "bio": "Decentralized content creator from Seattle",
  "avatar_url": "/profile/avatar.jpg",
  "cover_url": "/profile/cover.jpg",
  "joined_at": "2025-06-01T12:00:00Z",
  "public_key": "0x04abc...",
  "auth_enabled": true,
  "content_count": 42,
  "total_storage_bytes": 1073741824
}
```

**Response (200) — auth disabled:**

```json
{
  "id": "user-abc123def456",
  "nickname": "Alice",
  "bio": "Decentralized content creator from Seattle",
  "avatar_url": "/profile/avatar.jpg",
  "cover_url": "/profile/cover.jpg",
  "joined_at": "2025-06-01T12:00:00Z",
  "public_key": "0x04abc...",
  "auth_enabled": false,
  "content_count": 42,
  "total_storage_bytes": 1073741824
}
```

The `auth_enabled` field tells the Aggregator whether authentication is
required for API access. If `true`, the Aggregator must include an API key
or Basic Auth credentials in all requests.

#### 3.2.2. Content Endpoint

**GET /aura/content**

Returns a list of all content items that are publicly accessible. De-indexed
or private content is excluded unless the viewer is authenticated.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 20 | Max items to return (max: 100) |
| `offset` | integer | 0 | Pagination offset |
| `category` | string | — | Filter by category: `video`, `article`, `audio`, `image` |
| `sort` | string | `newest` | Sort order: `newest`, `oldest`, `most_viewed` |

**Response (200):**

```json
{
  "total": 42,
  "limit": 20,
  "offset": 0,
  "items": [
    {
      "id": "content_xyz789",
      "title": "My First KirinNet Video",
      "description": "A video about decentralized content platforms",
      "category": "video",
      "file_path": "/media/my_video.mp4",
      "file_size": 157286400,
      "mime_type": "video/mp4",
      "duration_seconds": 300,
      "ipfs_cid": "QmXoypMa2FR5yZiPu3jD7y3jS8YFmR7kXwR2Hq9k1nM3vP",
      "thumbnail_url": "/media/thumbnails/my_video_thumb.jpg",
      "view_count": 1234,
      "created_at": "2025-07-15T10:30:00Z",
      "updated_at": "2025-07-15T10:30:00Z",
      "visibility": "public",
      "tags": ["decentralized", "web3", "kirindns"]
    }
  ]
}
```

**Visibility values:**

| Value | Description |
|-------|-------------|
| `public` | Accessible to anyone, including the Aggregator |
| `restricted` | Accessible only with authentication (API key) |
| `private` | Not returned by `/aura/content`; only accessible via direct file URL with auth |

#### 3.2.3. Content Detail Endpoint

**GET /aura/content/:id**

Returns detailed information about a single content item.

**Response (200):**

```json
{
  "id": "content_xyz789",
  "title": "My First KirinNet Video",
  "description": "A video about decentralized content platforms",
  "category": "video",
  "file_path": "/media/my_video.mp4",
  "file_size": 157286400,
  "mime_type": "video/mp4",
  "duration_seconds": 300,
  "ipfs_cid": "QmXoypMa2FR5yZiPu3jD7y3jS8YFmR7kXwR2Hq9k1nM3vP",
  "thumbnail_url": "/media/thumbnails/my_video_thumb.jpg",
  "view_count": 1234,
  "created_at": "2025-07-15T10:30:00Z",
  "updated_at": "2025-07-15T10:30:00Z",
  "visibility": "public",
  "tags": ["decentralized", "web3", "kirindns"]
}
```

**Response (403) — restricted content without auth:**

```json
{
  "error": "unauthorized",
  "message": "Authentication required to access this content"
}
```

#### 3.2.4. Upload Endpoint

**POST /aura/upload**

Upload a new content item. The file is stored on the local filesystem and
metadata is recorded in the SQLite database.

**Authentication:** Required (see Section 3.5).

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The media file to upload |
| `title` | string | Yes | Content title (max 200 chars) |
| `description` | string | No | Content description (max 5000 chars) |
| `category` | string | Yes | Category: `video`, `article`, `audio`, `image` |
| `visibility` | string | No | Visibility: `public` (default), `restricted`, `private` |
| `tags` | string | No | Comma-separated tags (max 10 tags, 30 chars each) |

**Response (201):**

```json
{
  "id": "content_xyz789",
  "title": "My First KirinNet Video",
  "file_path": "/media/my_video.mp4",
  "file_size": 157286400,
  "mime_type": "video/mp4",
  "visibility": "public",
  "created_at": "2025-07-15T10:30:00Z",
  "url": "http://alice.kirinnet.org:8080/media/my_video.mp4"
}
```

**Response (413) — file too large:**

```json
{
  "error": "file_too_large",
  "message": "File exceeds maximum size of 5368709120 bytes"
}
```

**Response (415) — unsupported type:**

```json
{
  "error": "unsupported_type",
  "message": "MIME type application/x-msdownload is not allowed"
}
```

#### 3.2.5. Delete Endpoint

**DELETE /aura/content/:id**

Delete a content item. Removes the file from the filesystem and the metadata
from the database.

**Authentication:** Required (owner only).

**Response (204):** No content (deletion successful).

**Response (403):**

```json
{
  "error": "forbidden",
  "message": "Only the content owner can delete this content"
}
```

#### 3.2.6. Update Endpoint

**PUT /aura/content/:id**

Update content metadata (title, description, visibility, tags). Does not
modify the file itself.

**Authentication:** Required (owner only).

**Request:**

```json
{
  "title": "Updated Title",
  "description": "Updated description",
  "visibility": "restricted",
  "tags": ["decentralized", "web3", "updated"]
}
```

**Response (200):**

```json
{
  "id": "content_xyz789",
  "title": "Updated Title",
  "description": "Updated description",
  "visibility": "restricted",
  "updated_at": "2025-07-15T12:00:00Z"
}
```

#### 3.2.7. IPFS Pin Endpoint

**POST /aura/content/:id/pin**

Upload the local file to IPFS and store the resulting CID in the database.
This enables decentralized content distribution.

**Authentication:** Required (owner only).

**Request:**

```json
{
  "pin_service": "pinata",
  "api_key": "***",
  "secret_key": "***"
}
```

**Response (200):**

```json
{
  "id": "content_xyz789",
  "ipfs_cid": "QmXoypMa2FR5yZiPu3jD7y3jS8YFmR7kXwR2Hq9k1nM3vP",
  "pin_service": "pinata",
  "pinned_at": "2025-07-15T10:35:00Z",
  "gateway_url": "https://gateway.pinata.cloud/ipfs/QmXoyp..."
}
```

**Response (503) — pin service unavailable:**

```json
{
  "error": "pin_failed",
  "message": "IPFS pinning service returned 503 Service Unavailable"
}
```

#### 3.2.8. Health Endpoint

**GET /aura/health**

Returns the current health status of the User Node.

**Response (200):**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime_seconds": 86400,
  "storage_used_bytes": 1073741824,
  "storage_total_bytes": 107374182400,
  "content_count": 42,
  "timestamp": "2025-07-16T10:30:00Z"
}
```

### 3.3. Static File Serving

The User Node serves static files directly from the `/data/media/` directory:

```
http://alice.kirinnet.org:8080/media/my_video.mp4
http://alice.kirinnet.org:8080/media/thumbnails/my_video_thumb.jpg
http://alice.kirinnet.org:8080/profile/avatar.jpg
```

Static file serving respects the visibility setting:

- **public:** Served to anyone without authentication.
- **restricted:** Requires the `Authorization` header with a valid API key.
- **private:** Requires the `Authorization` header with a valid API key.

If a file is not found, the User Node returns 404.

### 3.4. Aggregator Sync Protocol

The User Node supports two modes of synchronization with the Aggregator:

#### 3.4.1. Push Mode (Webhook)

The User Node sends a webhook notification to the Aggregator whenever
content is created, updated, or deleted.

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_URL` | — | Aggregator webhook endpoint (blank = disabled) |
| `WEBHOOK_SECRET` | — | HMAC secret for signing webhook payloads |

**Webhook payload:**

```json
{
  "event": "content.created",
  "timestamp": "2025-07-15T10:30:00Z",
  "node_id": "user-abc123def456",
  "domain": "alice.kirinnet.org",
  "payload": {
    "id": "content_xyz789",
    "title": "My First KirinNet Video",
    "cid": "QmXoyp...",
    "category": "video",
    "visibility": "public"
  }
}
```

**Event types:**

| Event | Description |
|-------|-------------|
| `content.created` | New content uploaded |
| `content.updated` | Content metadata updated |
| `content.deleted` | Content deleted |
| `profile.updated` | Profile information changed |

**HMAC signing:** The `X-Aura-Signature` header contains an HMAC-SHA256
signature of the raw request body, using the `WEBHOOK_SECRET` as the key.

#### 3.4.2. Pull Mode (Polling)

The Aggregator polls the User Node's `/aura/content` endpoint on a
schedule. The User Node supports the `Since` header for incremental
fetching:

```
GET /aura/content?limit=100
Since: 2025-07-15T10:00:00Z
```

The User Node returns only items created or updated after the specified
timestamp. If no `Since` header is provided, all items are returned.

**ETag support:** The User Node includes an `ETag` header in responses.
If the Aggregator sends `If-None-Match: <etag>`, the User Node returns
304 Not Modified if the content has not changed.

### 3.5. Authentication

The User Node supports two authentication methods:

#### 3.5.1. API Key

The User Node generates an API key during initialization (or the user can
set one via environment variable).

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | auto-generated UUID | The API key for authentication |
| `AUTH_ENABLED` | `false` | Whether authentication is required |

**Usage:** Include the API key in the `Authorization` header:

```
Authorization: Bearer <api_key>
```

#### 3.5.2. Basic Auth

For human users accessing the User Node via browser, Basic Auth is supported.

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `BASIC_AUTH_USER` | — | Username for Basic Auth (blank = disabled) |
| `BASIC_AUTH_PASS` | — | Password for Basic Auth |

When Basic Auth is configured, the User Node returns a 401 Unauthorized
with a `WWW-Authenticate: Basic` header for protected endpoints.

#### 3.5.3. Authentication Flow

1. **No auth configured (`AUTH_ENABLED=false`):** All endpoints are open.
2. **API key only:** Write endpoints (POST/PUT/DELETE) require the API key.
   Read endpoints (GET) are open unless the content visibility is
   `restricted` or `private`.
3. **Basic Auth only:** All endpoints require Basic Auth credentials.
4. **Both configured:** Either method works. Write endpoints prefer API
   key; if Basic Auth is used for write operations, the password must match.

#### 3.5.4. Rate Limiting

To protect against abuse, the User Node implements simple rate limiting:

| Endpoint | Rate Limit |
|----------|-----------|
| All GET | 100 requests/minute per IP |
| All POST/PUT/DELETE | 20 requests/minute per API key |
| `/aura/upload` | 10 requests/minute per API key |

Rate limit headers are included in all responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1721064000
```

When the rate limit is exceeded, the User Node returns 429 Too Many Requests:

```json
{
  "error": "rate_limited",
  "message": "Too many requests. Please retry after 30 seconds",
  "retry_after": 30
}
```

---

## 4. Docker Image

### 4.1. Dockerfile

```
# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production && cp -R node_modules /tmp/node_modules

# Build the application
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine

# Install sqlite3 binaries
RUN apk add --no-cache tini sqlite-libs

WORKDIR /app

# Copy built application and node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /tmp/node_modules ./node_modules

# Create data directory with proper permissions
RUN mkdir -p /data/media /data/articles /data/profile /data/db && \
    chmod -R 755 /data

# Create non-root user
RUN addgroup -g 1001 -S auranode && \
    adduser -u 1001 -S auranode -G auranode

USER auranode

# Set environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=8080

# Expose port (will be resolved via KirinDNS)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/aura/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server.js"]
```

### 4.2. docker-compose.yml

```
yaml
version: "3.9"

services:
  auranode:
    image: kirinnet/user-node:latest
    container_name: auranode
    restart: unless-stopped
    ports:
      - "8080:8080"  # Port must match KirinDNS TXT record
    volumes:
      - ./data:/data  # Persist user data
    environment:
      - NODE_ENV=production
      - PORT=8080
      - DATA_DIR=/data
      - AUTH_ENABLED=true
      - API_KEY=${API_KEY:-}
      - BASIC_AUTH_USER=${BASIC_AUTH_USER:-}
      - BASIC_AUTH_PASS=${BASIC_AUTH_PASS:-}
      - MAX_FILE_SIZE=5368709120
      - WEBHOOK_URL=${WEBHOOK_URL:-}
      - WEBHOOK_SECRET=${WEBHOOK_SECRET:-}
      - IPFS_GATEWAY=https://ipfs.infura.io:5001
```

### 4.3. Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port the User Node listens on |
| `DATA_DIR` | `/data` | Root data directory |
| `AUTH_ENABLED` | `false` | Enable authentication |
| `API_KEY` | auto-generated | API key for programmatic access |
| `BASIC_AUTH_USER` | — | Username for Basic Auth |
| `BASIC_AUTH_PASS` | — | Password for Basic Auth |
| `MAX_FILE_SIZE` | `5368709120` | Maximum upload size in bytes (5 GB) |
| `ALLOWED_MIME_TYPES` | See 3.1 | Comma-separated MIME types |
| `WEBHOOK_URL` | — | Aggregator webhook endpoint |
| `WEBHOOK_SECRET` | — | HMAC secret for webhook signing |
| `IPFS_GATEWAY` | — | IPFS gateway URL for pinning |
| `RATE_LIMIT_WINDOW` | `60` | Rate limit window in seconds |
| `RATE_LIMIT_REQUESTS` | `100` | Max requests per window (GET) |

### 4.4. Resource Requirements

| Metric | Minimum | Recommended |
|--------|---------|-------------|
| CPU | 1 core | 2 cores |
| RAM | 256 MB | 512 MB |
| Disk | 10 GB | 100 GB+ |
| Network | 10 Mbps uplink | 100 Mbps uplink |

The User Node is designed to run on minimal hardware. A Raspberry Pi 4 with
2 GB RAM is sufficient for basic operation.

---

## 5. KirinDNS Registration

### 5.1. DNS TXT Record Configuration

To make the User Node discoverable, the user configures a DNS TXT record
on their domain:

```
aura.alice.kirinnet.org.  300  IN  TXT  "{\"http\": 8080, \"id\": \"user-abc123def456\", \"nickname\": \"Alice\"}"
```

Or more readably, the TXT record contains:

```json
{"http": 8080, "id": "user-abc123def456", "nickname": "Alice"}
```

**JSON Schema:**

```json
{
  "http":    { "type": "integer", "required": true,  "description": "HTTP port" },
  "https":   { "type": "integer", "required": false, "description": "HTTPS port (if TLS is configured)" },
  "id":      { "type": "string",  "required": true,  "description": "Unique user node UUID" },
  "nickname": { "type": "string",  "required": true,  "description": "Display name (max 30 chars)" },
  "auth":    { "type": "boolean", "required": false, "description": "Whether API key is required (default: false)" },
  "webhook": { "type": "boolean", "required": false, "description": "Whether push sync is configured (default: false)" }
}
```

**Complete example with all fields:**

```json
{"http": 8080, "https": 8443, "id": "user-abc123def456", "nickname": "Alice", "auth": true, "webhook": true}
```

### 5.2. Registration Steps

1. **Deploy the User Node** (see Section 4).
2. **Note the port** the User Node is listening on (default: 8080).
3. **Generate a UUID** for your node if you don't have one (the User Node
   generates one on first startup and stores it in `/data/db/auranode.db`).
4. **Configure your DNS TXT record** with the ADRP JSON payload.
5. **Verify resolution** using the KirinDNS client library:

   ```bash
   node -e "const {resolve_aura_dns} = require('aura-dns'); resolve_aura_dns('alice.kirinnet.org').then(r => console.log(JSON.stringify(r)))"
   # => {"http": 8080}
   ```

6. **Test the User Node** from the public internet:

   ```bash
   curl http://alice.kirinnet.org:8080/aura/health
   # => {"status": "ok", "version": "1.0.0", ...}
   ```

### 5.3. DNS TXT Record Size Constraints

The ADRP TXT record is subject to the 255-octet DNS TXT record size limit.
The full ADRP JSON payload must fit within this constraint.

**Maximum payload example (245 octets):**

```json
{"http":8080,"https":8443,"id":"user-abc123def456","nickname":"Alice","auth":true,"webhook":true}
```

This is well within the 255-octet limit. However, if future extensions
add longer fields (e.g., a `public_key` field), the TXT record may approach
the limit. In that case, the User Node specification supports a two-layer
approach:

1. **DNS layer (ADRP TXT):** Minimal discovery data — port + id + nickname.
2. **Application layer:** The Aggregator queries `/aura/profile` on the
   discovered port to fetch detailed profile data.

### 5.4. Aggregator Discovery Process

When the Aggregator crawls the network for new User Nodes:

1. **DNS Resolution:** Query the KirinDNS TXT record for the domain.
2. **Port Discovery:** Extract the `http` (or `https`) port from the TXT
   record.
3. **Connectivity Check:** Send a GET request to `/aura/health` on the
   discovered port.
4. **Profile Fetch:** Send a GET request to `/aura/profile` to retrieve
   the user's full profile.
5. **Content Sync:** Poll `/aura/content` or set up webhook-based push.

If any step fails, the Aggregator marks the node as `unreachable` and
retries after an exponential backoff (1m, 5m, 30m, 2h, 12h).

---

## 6. SQLite Schema

The User Node uses SQLite as its embedded database. The schema is stored in
`/data/db/auranode.db`.

```sql
-- User Node SQLite Schema

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Node identity
CREATE TABLE IF NOT EXISTS node (
    id          TEXT PRIMARY KEY,
    nickname    TEXT NOT NULL,
    bio         TEXT,
    public_key  TEXT,
    auth_enabled BOOLEAN DEFAULT FALSE,
    api_key     TEXT,
    webhook_url TEXT,
    webhook_secret TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Content items
CREATE TABLE IF NOT EXISTS content (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    description   TEXT,
    category      TEXT NOT NULL CHECK (category IN ('video', 'article', 'audio', 'image')),
    file_path     TEXT NOT NULL,
    file_size     INTEGER NOT NULL,
    mime_type     TEXT NOT NULL,
    duration_seconds INTEGER,
    ipfs_cid      TEXT,
    thumbnail_path TEXT,
    visibility    TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'restricted', 'private')),
    view_count    INTEGER DEFAULT 0,
    tags          TEXT,  -- JSON array stored as text
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_content_category ON content(category);
CREATE INDEX IF NOT EXISTS idx_content_visibility ON content(visibility);
CREATE INDEX IF NOT EXISTS idx_content_created ON content(created_at);
CREATE INDEX IF NOT EXISTS idx_content_ipfs_cid ON content(ipfs_cid);
```

---

## 7. Security Considerations

### 7.1. TLS Termination

The User Node can operate with or without TLS:

- **Without TLS (port 8080):** Suitable for LAN or behind a reverse proxy.
- **With TLS (port 8443):** The User Node supports self-signed certificates
  or user-provided certificates.

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `TLS_ENABLED` | `false` | Enable TLS |
| `TLS_CERT_PATH` | — | Path to TLS certificate |
| `TLS_KEY_PATH` | — | Path to TLS private key |

### 7.2. API Key Security

- The API key is stored hashed (SHA-256) in the SQLite database.
- The API key is logged to stdout on first startup for the user to capture.
- If `API_KEY` is set via environment variable, that value takes precedence.
- The API key can be rotated via the `/aura/admin/rotate-key` endpoint
  (requires Basic Auth).

### 7.3. File Path Traversal Prevention

All file path operations use `path.resolve()` with the `DATA_DIR` as the
base, and the User Node validates that the resolved path is within the
`DATA_DIR` tree. Any attempt to access files outside `DATA_DIR` returns 403.

### 7.4. CORS

The User Node serves the `Access-Control-Allow-Origin` header for all
responses. By default, it allows all origins. To restrict CORS:

| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_ORIGIN` | `*` | Allowed CORS origin (use `*` for all) |

### 7.5. Backup and Recovery

The User Node supports automated backups of the SQLite database and media
files:

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKUP_ENABLED` | `false` | Enable automatic backups |
| `BACKUP_SCHEDULE` | `0 3 * * *` | Cron schedule for backups |
| `BACKUP_DEST` | `/data/backups` | Backup destination directory |
| `BACKUP_RETENTION` | `7` | Number of backups to retain |

The backup process:
1. Creates a WAL checkpoint of the SQLite database.
2. Compresses the database and media files into a tarball.
3. Stores the tarball in `BACKUP_DEST` with a timestamp.
4. Deletes backups older than `BACKUP_RETENTION` count.

---

## 8. Deployment Examples

### 8.1. Home Server (Quick Start)

```bash
# Create data directory
mkdir -p ~/auranode/data

# Generate .env file
cat > ~/auranode/.env << 'EOF'
AUTH_ENABLED=true
API_KEY=my-super-secret-api-key-change-me
WEBHOOK_URL=https://api.kirinnet.org/v1/webhooks/auranode
WEBHOOK_SECRET=my-webhook-secret
EOF

# Start the container
docker run -d \
  --name auranode \
  --restart unless-stopped \
  -p 8080:8080 \
  -v ~/auranode/data:/data \
  --env-file ~/auranode/.env \
  kirinnet/user-node:latest

# Configure your DNS TXT record:
# {"http": 8080, "id": "<node-id>", "nickname": "YourName"}
```

### 8.2. With Nginx Reverse Proxy and TLS

```nginx
server {
    listen 443 ssl;
    server_name alice.kirinnet.org;

    ssl_certificate     /etc/ssl/certs/alice.kirinnet.org.pem;
    ssl_certificate_key /etc/ssl/private/alice.kirinnet.org.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Increase upload size limit
    client_max_body_size 5G;
}
```

With this setup, the KirinDNS TXT record would be:

```json
{"http": 80, "https": 443, "id": "user-abc123def456", "nickname": "Alice", "auth": true}
```

### 8.3. Raspberry Pi

```bash
# Install Docker on Raspberry Pi
sudo apt update && sudo apt install -y docker.io
sudo systemctl enable --now docker

# Create directories
sudo mkdir -p /opt/auranode/data
sudo chown -R 1000:1000 /opt/auranode

# Start the container
docker run -d \
  --name auranode \
  --restart unless-stopped \
  -p 8080:8080 \
  -v /opt/auranode/data:/data \
  -e AUTH_ENABLED=true \
  -e API_KEY=my-rpi-api-key \
  kirinnet/user-node:latest

# Check logs
docker logs -f auranode
```

---

## 9. Error Response Format

All error responses from the User Node follow a consistent format:

```json
{
  "error": "error_code",
  "message": "Human-readable error description",
  "details": {}  // Optional additional context
}
```

**Error codes:**

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 400 | `bad_request` | Invalid request parameters |
| 401 | `unauthorized` | Authentication required or invalid |
| 403 | `forbidden` | Insufficient permissions |
| 404 | `not_found` | Resource not found |
| 405 | `method_not_allowed` | HTTP method not supported |
| 409 | `conflict` | Content ID already exists |
| 413 | `file_too_large` | File exceeds maximum size |
| 415 | `unsupported_type` | MIME type not allowed |
| 429 | `rate_limited` | Rate limit exceeded |
| 500 | `internal_error` | Server error |
| 503 | `service_unavailable` | Service temporarily unavailable |

---

## 10. Future Extensions

### 10.1. P2P Content Distribution

The User Node may support direct P2P content sharing via libp2p in future
versions, allowing users to stream content directly from each other's nodes
without going through IPFS gateways.

### 10.2. Encrypted Content

End-to-end encrypted content support, where the User Node stores encrypted
blobs and the decryption key is shared only with authorized viewers.

### 10.3. Multi-Node Clustering

A user may run multiple User Nodes (e.g., for geographic distribution) and
synchronize them via a CRDT-based replication protocol.

### 10.4. Monetization

Integrated payment processing for content creators, supporting both
on-chain (crypto) and off-chain (Stripe, PayPal) payments.

---

## Appendix A: Quick Reference — API Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/aura/health` | No | Health check |
| GET | `/aura/profile` | No | User profile |
| GET | `/aura/content` | No* | List content |
| GET | `/aura/content/:id` | No* | Content detail |
| POST | `/aura/upload` | Yes | Upload content |
| PUT | `/aura/content/:id` | Yes | Update content |
| DELETE | `/aura/content/:id` | Yes | Delete content |
| POST | `/aura/content/:id/pin` | Yes | Pin to IPFS |
| GET | `/media/*` | No* | Static file serving |

*Auth required for `restricted` or `private` visibility content.

---

## Appendix B: KirinDNS TXT Record Quick Reference

```json
{"http": 8080, "id": "user-uuid", "nickname": "Display Name"}
```

Minimum required fields: `http`, `id`, `nickname`.
Optional fields: `https`, `auth`, `webhook`.

---

> **KirinNet User Node** — Your data, your server, your rules.
> Built on [KirinDNS](../01_Standard/spec_v1.md) for seamless federated discovery.
