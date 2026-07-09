# KirinNet — Architecture Specification

KirinNet is a decentralized content platform that combines:
- **KirinDNS** for domain-to-content resolution
- **IPFS/Arweave** for censorship-resistant content storage
- **Centralized metadata index** for search, recommendation, and discovery

The core philosophy: *Users own their content. The platform facilitates discovery but cannot delete what users have published.*

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        KirinNet Platform                            │
│                                                                   │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌────────────────┐  │
│  │  Web App  │──▶│ API      │──▶│ Metadata │──▶│ Recommendation│  │
│  │  (React)  │   │ Gateway  │   │ Index    │   │ Engine        │  │
│  └──────────┘   └──────────┘   └──────────┘   └────────────────┘  │
│                            │                                       │
│                    ┌───────▼───────┐                               │
│                    │   Moderation   │                               │
│                    │   Service      │                               │
│                    └───────────────┘                               │
└─────────────────────────────────────────────────────────────────────┘
        │                                       │
        │ KirinDNS TXT Resolution                │ Content Fetch (IPFS/Arweave)
        ▼                                       ▼
┌──────────────┐                      ┌──────────────────────┐
│  KirinDNS     │                      │  IPFS / Arweave      │
│  Resolution  │                      │  Content Storage     │
│  (DoH + TXT) │                      └──────────────────────┘
└──────────────┘
```

---

## 2. Data Flow

### 2.1 Upload Flow

1. **User creates content** (video, article, audio) on their local machine.
2. **Content is uploaded to IPFS or Arweave:**
   - **IPFS**: For dynamic, frequently updated, or less critical content.
     - Uses a pinning service (e.g., Pinata, Infura) to ensure persistence.
   - **Arweave**: For permanent, immutable content (e.g., videos, major articles).
     - One-time payment for permanent storage.
3. **Upload returns a Content ID (CID):**
   - IPFS: `QmXoyp...` (CIDv0) or `bafy...` (CIDv1)
   - Arweave: `tx-id` (transaction ID)
4. **User publishes metadata to KirinNet:**
   - Title, description, category, tags, CID, creator domain.
   - Metadata is signed with the user's private key to prove ownership.
5. **KirinDNS TXT record is updated** (automatically or manually):
   ```json
   {"http": 8080, "ipfs_cid": "QmXoyp...", "arweave_tx": "abc123..."}
   ```
   This TXT record lives on the user's domain (e.g., `alice.kirinnet.org`).

### 2.2 Resolution Flow

1. **Viewer navigates to `alice.kirinnet.org`** in their browser.
2. **KirinDNS resolution occurs:**
   - With KirinDNS extension: The extension queries DoH for the TXT record,
     discovers the port (8080) and the CID (`QmXoyp...`), redirects to the
     correct port, and fetches the content directly from IPFS.
   - Without extension: The request falls back to the KirinNet Gateway (on
     the standard port), which proxies the IPFS content.
3. **Content is rendered** in the viewer's browser.

### 2.3 Consumption Flow (Detailed)

```
┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Viewer  │    │  KirinDNS     │    │  IPFS/       │    │  KirinNet     │
│  Browser │    │  Resolution  │    │  Arweave     │    │  Gateway     │
└────┬─────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
     │                 │                    │                   │
     │ 1. Navigate to  │                    │                   │
     │  alice.kirinnet.org                        │                   │
     │─────────────────▶│                    │                   │
     │                 │ 2. Query TXT       │                   │
     │                 │  via DoH           │                   │
     │                 │────────────────────▶│                   │
     │                 │                    │                   │
     │                 │ 3. Returns:        │                   │
     │                 │  {"http": 8080,    │                   │
     │                 │   "ipfs_cid": "Qm"}│                   │
     │                 │◀───────────────────│                   │
     │                 │                    │                   │
     │ 4. Redirect to  │                    │                   │
     │  :8080 + fetch  │                    │                   │
     │  CID from IPFS  │                    │                   │
     │──────────────────────────────────────▶│                   │
     │                 │                    │                   │
     │                 │ 5. Content         │                   │
     │                 │  returned          │                   │
     │                 │◀───────────────────│                   │
     │                 │                    │                   │
     │                 │  If no extension:  │                   │
     │                 │  fallback via      │                   │
     │                 │  KirinNet Gateway   │                   │
     │                 │────────────────────────────────────────▶│
     │                 │                    │                   │
```

---

## 3. Storage Strategy

### 3.1 Raw Content

| Content Type | Storage | Rationale |
|--------------|---------|-----------|
| Videos | Arweave | Permanent, immutable, one-time payment |
| Articles (long-form) | Arweave | Permanent record |
| Articles (short-form/updates) | IPFS + Pinning | Ephemeral, can be unpinned |
| Images | IPFS + Pinning | Dynamic, frequently updated |
| Audio | Arweave | Permanent |

### 3.2 Metadata

Metadata is stored in a centralized PostgreSQL database on the KirinNet Platform.
This enables:

- **Fast search**: Full-text search across titles, descriptions, tags.
- **Recommendation engine**: Collaborative filtering, content-based filtering.
- **Moderation**: De-indexing without deleting content.
- **Analytics**: View counts, engagement metrics.

**Metadata schema:**

```sql
CREATE TABLE content (
    id            BIGSERIAL PRIMARY KEY,
    cid           TEXT NOT NULL,           -- IPFS CID or Arweave tx-id
    storage_type  TEXT NOT NULL,           -- 'ipfs' or 'arweave'
    title         TEXT NOT NULL,
    description   TEXT,
    category      TEXT NOT NULL,
    tags          TEXT[],                  -- Array of tags
    creator_domain TEXT NOT NULL,          -- e.g., 'alice.kirinnet.org'
    creator_key   TEXT NOT NULL,           -- Public key of creator
    signature     TEXT NOT NULL,           -- Signature of metadata
    created_at    TIMESTAMP DEFAULT NOW(),
    updated_at    TIMESTAMP DEFAULT NOW(),
    view_count    INTEGER DEFAULT 0,
    de_indexed    BOOLEAN DEFAULT FALSE,  -- Moderation flag
    de_indexed_reason TEXT,                -- Reason for de-indexing
    de_indexed_by  TEXT,                   -- Moderator ID
    de_indexed_at  TIMESTAMP
);

CREATE INDEX idx_content_creator ON content(creator_domain);
CREATE INDEX idx_content_category ON content(category);
CREATE INDEX idx_content_search ON content USING gin(to_tsvector('english', title || ' ' || description));
CREATE INDEX idx_content_de_indexed ON content(de_indexed);
```

### 3.3 Metadata Signing

When a user publishes content, the metadata is signed with their private key:

```
message = SHA256(title + description + cid + creator_domain + created_at)
signature = ECDSA_Sign(message, user_private_key)
```

The KirinNet Platform verifies the signature before indexing the content.
This ensures:
- The metadata was not tampered with after creation.
- The creator cannot deny having published the content (non-repudiation).

---

## 4. URL Structure

### 4.1 With KirinDNS Extension

The user's domain resolves to their IPFS gateway port via ADRP:

```
http://alice.kirinnet.org:8080
```

The KirinDNS TXT record for `alice.kirinnet.org`:
```json
{"http": 8080, "ipfs_cid": "QmXoyp..."}
```

The extension:
1. Queries the TXT record via DoH.
2. Discovers port 8080 and CID `QmXoyp...`.
3. Redirects to `http://alice.kirinnet.org:8080`.
4. The local IPFS gateway on port 8080 fetches the content from IPFS.

### 4.2 Without KirinDNS Extension (Fallback)

The request falls back to the KirinNet Gateway, which proxies IPFS content:

```
https://gateway.kirinnet.org/ipfs/QmXoyp...
```

The KirinNet Gateway:
1. Resolves the KirinDNS TXT record for the user's domain.
2. Extracts the CID.
3. Fetches the content from IPFS/Arweave.
4. Proxies it to the viewer.

### 4.3 Direct IPFS Access

If the user knows the CID directly:

```
https://gateway.ipfs.io/ipfs/QmXoyp...
```

This bypasses KirinDNS entirely and goes straight to the IPFS network.

### 4.4 URL Comparison

| Access Method | URL | Requires Extension? | Speed |
|---------------|-----|--------------------|-------|
| KirinDNS + IPFS | `http://alice.kirinnet.org:8080` | Yes | Fast (direct) |
| KirinNet Gateway | `https://gateway.kirinnet.org/ipfs/QmXoyp...` | No | Medium (proxied) |
| Public IPFS Gateway | `https://gateway.ipfs.io/ipfs/QmXoyp...` | No | Variable |

---

## 5. Moderation Model

### 5.1 De-Indexing (Not Deletion)

When content violates community guidelines:

1. A moderator flags the content via the moderation API.
2. The content's `de_indexed` flag is set to `TRUE` in the database.
3. The content is **removed from:**
   - Search results.
   - Recommendation feeds.
   - Category listings.
   - Creator's public profile (on the KirinNet Platform).
4. The content is **NOT removed from:**
   - IPFS/Arweave (the raw content remains accessible).
   - The KirinDNS TXT record (the domain still resolves).

### 5.2 Direct Access After De-Indexing

Users who know the KirinDNS domain or IPFS CID can still access the content:

- **Via KirinDNS**: `http://alice.kirinnet.org:8080` — the extension
  resolves the TXT record and fetches the content.
- **Via IPFS CID**: `https://gateway.ipfs.io/ipfs/QmXoyp...` — direct
  IPFS access.
- **Via Arweave tx-id**: `https://arweave.net/tx-id` — direct Arweave
  access.

This is **censorship resistance by design**: the platform controls discovery,
not availability.

### 5.3 Moderation Tiers

| Tier | Action | Description |
|------|--------|-------------|
| 1 | Warning | Creator receives a warning; content remains indexed. |
| 2 | De-indexing | Content is removed from search/recommendations. |
| 3 | Domain suspension | Creator's domain is flagged; their content is de-indexed. |
| 4 | Legal action | For illegal content, the platform cooperates with authorities. |

---

## 6. Security Considerations

### 6.1 DNSSEC and DoH

All KirinDNS queries MUST use DoH (or DoT) to prevent DNS spoofing.
Domain operators SHOULD sign their zones with DNSSEC.

### 6.2 Metadata Integrity

Metadata is signed by the creator's private key. The KirinNet Platform
verifies signatures before indexing. This prevents:
- Third parties from claiming ownership of content.
- Tampering with metadata after publication.

### 6.3 Content Authenticity

The CID serves as a cryptographic hash of the content. If the content is
modified, the CID changes. This ensures that:
- The content a viewer receives is exactly what the creator published.
- De-indexed content cannot be replaced with different content while
  keeping the same CID.

### 6.4 Sybil Resistance

To prevent a single entity from creating thousands of fake domains:
- Domain registration requires a small deposit (e.g., 0.01 ETH or equivalent).
- The deposit is refundable if the domain is deleted.
- This is a soft economic barrier, not a hard requirement.

---

## 7. Scalability

### 7.1 Content Delivery

- **IPFS Pinning**: Pin content on multiple pinning providers (Pinata,
  Infura, self-hosted) for redundancy.
- **CDN Caching**: The KirinNet Gateway can cache frequently accessed
  content on a CDN (Cloudflare, AWS CloudFront) for faster delivery.
- **Arweave Endpoints**: Use multiple Arweave gateway endpoints for
  redundancy.

### 7.2 Metadata Index

- **PostgreSQL with read replicas**: Write to the primary, read from
  replicas for search and recommendation queries.
- **Elasticsearch**: For full-text search, index metadata in Elasticsearch
  for fast, relevance-ranked search.
- **Redis**: For caching hot content (view counts, trending items).

### 7.3 Recommendation Engine

- **Collaborative filtering**: Based on user viewing patterns.
- **Content-based filtering**: Based on tags, categories, and metadata.
- **Hybrid approach**: Combine collaborative and content-based signals.
- **Real-time updates**: Recommendations are updated incrementally as new
  content is published and viewed.

---

## 8. Deployment Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Cloud (AWS/GCP)                         │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │  React   │  │  API     │  │  Postgre │  │  Elastic-  │  │
│  │  Web App │  │  Gateway │  │  SQL     │  │  search    │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
│       │               │              │               │      │
│       │               │              │               │      │
│  ┌────▼────────────────▼──────────────▼────────────────▼────┐│
│  │                   Cloudflare CDN                         ││
│  │  (Caches IPFS/Arweave content at the edge)              ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
        │                              │
        │ KirinDNS DoH Query            │ Content Fetch
        ▼                              ▼
┌──────────────┐              ┌──────────────────┐
│  Cloudflare  │              │  IPFS Network    │
│  DoH (1.1.1.1│              │  + Arweave       │
│  /dns-query) │              └──────────────────┘
└──────────────┘
```

The KirinNet Platform runs on standard cloud infrastructure. The only
"decentralized" components are the content storage (IPFS/Arweave) and the
resolution mechanism (KirinDNS). This hybrid approach balances decentralization
with practical performance and searchability.
