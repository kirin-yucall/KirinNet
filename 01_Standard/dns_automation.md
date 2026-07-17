# KirinDNS Automation Standard

> **Version:** 2.1
> **Status:** Draft
> **Scope:** How KirinNet nodes programmatically manage DNS records for service discovery (SRV) and identity/authentication (DID-DNS TXT).

---

## 1. DNS Record Architecture

KirinNet nodes publish three DNS record types:

| Record | Purpose | Example |
|--------|---------|---------|
| **A / AAAA** | IP address of the node | Standard DNS resolution |
| **SRV** | Service ports (WebSocket, HTTP, HTTPS) | `_kirinnet-ws._tcp.alice.kirinnet.org. 300 IN SRV 0 0 8082 alice.kirinnet.org.` |
|| **TXT** | Identity & authentication (DID-DNS protocol) | `mydomain.example. 300 IN TXT "did:dns:v=1;fp=...;n=...;iat=...;exp=..."` |

Separation of concerns: SRV handles **where** (port), TXT handles **who** (identity), A/AAAA handles **which IP**.

### 1.1 Why SRV, not TXT for ports?

- SRV is a standard DNS record type for service discovery. Every DNS library natively parses it.
- No custom semicolon-delimited parser needed.
- Resolvers can use `getSRV(domain)` instead of `getTXT(domain)` + string parsing.
- Multiple services can be advertised under different SRV names.

---

## 2. SRV Record Definitions

### 2.1 Service Names

| Service | SRV Name | Example Target | Description |
|---------|----------|----------------|-------------|
| WebSocket | `_kirinnet-ws._tcp` | `alice.kirinnet.org:8082` | Real-time messaging |
| HTTP API | `_kirinnet-http._tcp` | `alice.kirinnet.org:8080` | REST API |
| HTTPS API | `_kirinnet-https._tcp` | `alice.kirinnet.org:8443` | TLS REST API (optional) |

### 2.2 SRV Format

```
_kirinnet-ws._tcp.<domain>.   <TTL>  IN  SRV  <priority> <weight> <port> <target>
```

| Field | Value | Notes |
|-------|-------|-------|
| priority | 0 | Single-node deployment. For multi-node, use non-zero for failover order. |
| weight | 0 | Single-node. For load-balancing, distribute across multiple SRV records. |
| port | dynamic | The actual port the service listens on (e.g., 8080, 8082, 8443). |
| target | same domain | Points to the same FQDN (A/AAAA resolves the IP). |

### 2.3 Example Zone File

```
; A record — IP address
alice.kirinnet.org.      300  IN  A     203.0.113.10
alice.kirinnet.org.      300  IN  AAAA  2001:db8::1

; SRV records — service discovery
_kirinnet-ws._tcp.alice.kirinnet.org.   300  IN  SRV  0 0 8082 alice.kirinnet.org.
_kirinnet-http._tcp.alice.kirinnet.org. 300  IN  SRV  0 0 8080 alice.kirinnet.org.
_kirinnet-https._tcp.alice.kirinnet.org. 300  IN  SRV  0 0 8443 alice.kirinnet.org.

; TXT records — identity & authentication (DID-DNS protocol)
alice.kirinnet.org.      300  IN  TXT  "did:dns:v=1;fp=AbCdEf1234aaaa;n=QWxpY2U;g=F;iat=1712345678;exp=1712432078"
alice.kirinnet.org.      300  IN  TXT  "did:dns:pk;kty=ed25519;pk=MCowBQYDK2VwAyEA..."
```

---

## 3. TXT Record Format (DID-DNS Protocol)

TXT records use the `did:dns:` prefix defined in the [DID-DNS Protocol](./did-dns-protocol.md).

### 3.1 Record Types

| Record | Prefix | Required | Description |
|--------|--------|----------|-------------|
| Identity | `did:dns:v=...` | Yes | Version, key fingerprint, nickname, gender, timestamps |
| Public Key | `did:dns:pk;...` | Yes | Key type + full public key (Ed25519, Base64URL) |
| Blacklist | `did:dns:black;...` | No | Revoked key fingerprints |

### 3.2 Examples

Identity declaration:
```
did:dns:v=1;fp=AbCdEf1234aaaa;n=QWxpY2U;g=F;iat=1712345678;exp=1712432078
```

Public key:
```
did:dns:pk;kty=ed25519;pk=MCowBQYDK2VwAyEA...
```

Blacklist (optional):
```
did:dns:black;fp=Compromised1,Compromised2
```

### 3.3 Key Design

- **Identity and public key are separate records** — avoids exceeding 255-byte TXT RDATA limit
- **Fingerprint (fp)** links identity to public key: `fp = Base64URL(SHA-256(full_public_key)[0:12])`
- **DNSSEC required** — prevents DNS spoofing attacks that could substitute a fake public key
- **iat/exp window** — freshness check prevents replay of stale records
- **Blacklist** — enables key revocation when a private key is compromised

Full specification including the challenge-response verification flow is in [did-dns-protocol.md](./did-dns-protocol.md).

---

## 4. API: DNS Update Endpoint

### 4.1 Endpoint

```
POST https://dns.kirinnet.org/api/v2/update
```

(V1 used TXT-only; V2 adds SRV support.)

### 4.2 Authentication

Same as V1:

| Header | Required | Description |
|--------|----------|-------------|
| `X-DNS-Token` | Yes | API key issued at domain registration. |
| `X-Domain` | Yes | FQDN being updated. Must match token's authorized domain. |

### 4.3 Request Payload

```json
{
  "srv_records": [
    {
      "service": "_kirinnet-ws._tcp",
      "port": 8082,
      "priority": 0,
      "weight": 0
    },
    {
      "service": "_kirinnet-http._tcp",
      "port": 8080,
      "priority": 0,
      "weight": 0
    }
  ],
  "did_dns_records": {
    "identity": "did:dns:v=1;fp=AbCdEf1234aaaa;n=QWxpY2U;g=F;iat=1712345678;exp=1712432078",
    "public_key": "did:dns:pk;kty=ed25519;pk=MCowBQYDK2VwAyEA...",
    "blacklist": "did:dns:black;fp=OldFp1,OldFp2"
  },
  "ttl": 300
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `srv_records[]` | array | Yes | One entry per service. At minimum: ws and http. |
| `srv_records[].service` | string | Yes | SRV name (e.g., `_kirinnet-ws._tcp`) |
| `srv_records[].port` | integer | Yes | Listening port |
| `srv_records[].priority` | integer | No | Default: 0 |
| `srv_records[].weight` | integer | No | Default: 0 |
| `did_dns_records.identity` | string | Yes | Full identity declaration TXT value |
| `did_dns_records.public_key` | string | Yes | Full public key TXT value |
| `did_dns_records.blacklist` | string | No | Full blacklist TXT value (omit if no revoked keys) |
| `ttl` | integer | No | DNS TTL in seconds (default: 300, min: 60, max: 86400) |

### 4.4 Responses

**Success (200):**
```json
{
  "status": "ok",
  "domain": "alice.kirinnet.org",
  "srv_records": [
    {"service": "_kirinnet-ws._tcp", "port": 8082},
    {"service": "_kirinnet-http._tcp", "port": 8080}
  ],
  "txt_values": [
    "did:dns:v=1;fp=AbCdEf1234aaaa;n=QWxpY2U;g=F;iat=1712345678;exp=1712432078",
    "did:dns:pk;kty=ed25519;pk=MCowBQYDK2VwAyEA..."
  ],
  "ttl": 300,
  "updated_at": "2024-07-09T12:00:00Z",
  "propagation_estimate_sec": 30
}
```

**Errors:** Same codes as V1 (`UNAUTHORIZED` 401, `FORBIDDEN` 403, `RATE_LIMITED` 429).

---

## 5. DNS Resolution (Client Side)

### 5.1 Resolution Flow

```
Client wants to connect to alice.kirinnet.org
  │
  ├─ 1. Query SRV _kirinnet-ws._tcp.alice.kirinnet.org
  │     → get target + port (e.g., alice.kirinnet.org:8082)
  │
  ├─ 2. Query A/AAAA alice.kirinnet.org (if not cached)
  │     → get IP address
  │
  ├─ 3. Query TXT alice.kirinnet.org (for identity)
  │     → get DID-DNS identity + public key + blacklist
  │
  └─ 4. Connect WebSocket to <IP>:<SRV port>
       Verify node identity via DID-DNS fingerprint chain
```

### 5.2 Node.js SRV Resolution

```javascript
const dns = require('dns').promises;

async function resolveKirinNetNode(domain) {
  // 1. Resolve SRV for WebSocket
  const srvRecords = await dns.resolveSrv(`_kirinnet-ws._tcp.${domain}`);
  if (srvRecords.length === 0) throw new Error(`No SRV record for ${domain}`);

  const srv = srvRecords[0]; // Pick first (priority=0)
  const port = srv.port;
  const target = srv.name;

  // 2. Resolve A/AAAA
  const addresses = await dns.resolve4(target);

  // 3. Resolve TXT for DID-DNS identity
  let identity = null;
  try {
    const txtRecords = await dns.resolveTxt(domain);
    if (txtRecords.length > 0) {
      const allText = txtRecords.map(r => r.join('')).join('\n');
      identity = parseDidDnsRecords(allText);
    }
  } catch { /* Optional: node has no TXT record */ }

  return { addresses, port, identity };
}

function parseDidDnsRecords(raw) {
  const result = { identity: null, publicKey: null, blacklist: [] };
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.startsWith('did:dns:v=')) {
      result.identity = parseIdentityRecord(line);
    } else if (line.startsWith('did:dns:pk;')) {
      result.publicKey = parsePublicKeyRecord(line);
    } else if (line.startsWith('did:dns:black;')) {
      result.blacklist = parseBlacklistRecord(line);
    }
  }
  return result;
}

function parseIdentityRecord(raw) {
  const fields = {};
  raw.split(';').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    fields[pair.substring(0, eq)] = pair.substring(eq + 1);
  });
  return fields;
}

function parsePublicKeyRecord(raw) {
  // Strip prefix: "did:dns:pk;"
  const body = raw.substring('did:dns:pk;'.length);
  const fields = {};
  body.split(';').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    fields[pair.substring(0, eq)] = pair.substring(eq + 1);
  });
  return fields;
}

function parseBlacklistRecord(raw) {
  const body = raw.substring('did:dns:black;'.length);
  const fpPart = body.split(';').find(p => p.startsWith('fp='));
  if (!fpPart) return [];
  return fpPart.substring(3).split(',').filter(Boolean);
}
```

### 5.3 Resolution Cache

Resolution results should be cached locally:
- SRV + A/AAAA: cached per TTL
- On cache miss, fall back to last-known values (stale data > no data)

---

## 6. Node-Side Implementation

### 6.1 Update Loop

Same pattern as V1:

```javascript
class DNSAutoUpdater {
  constructor(domain, token) {
    this.domain = domain;
    this.token = token;
    this.intervalMs = TTL * 0.8 * 1000; // 80% of TTL
  }

  async update() {
    const identity = this.buildDidDnsIdentity();
    const publicKey = this.buildDidDnsPublicKey();
    const blacklist = this.buildDidDnsBlacklist();

    const payload = {
      srv_records: [
        { service: '_kirinnet-ws._tcp',   port: this.getWsPort() },
        { service: '_kirinnet-http._tcp',  port: this.getHttpPort() },
        { service: '_kirinnet-https._tcp', port: this.getHttpsPort() }, // optional
      ].filter(r => r.port > 0),
      did_dns_records: {
        identity: identity,
        public_key: publicKey,
        blacklist: blacklist || undefined,
      },
      ttl: 300,
    };

    await fetch('https://dns.kirinnet.org/api/v2/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNS-Token': this.token,
        'X-Domain': this.domain,
      },
      body: JSON.stringify(payload),
    });
  }

  buildDidDnsIdentity() {
    const fp = this.computeFingerprint(); // Base64URL(SHA-256(pubKey)[0:12])
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 86400; // 24h expiry
    return `did:dns:v=1;fp=${fp};n=${this.base64Encode(this.getNickname())};g=${this.getGender()};iat=${now};exp=${exp}`;
  }

  buildDidDnsPublicKey() {
    const pk = this.getEd25519PublicKeyBase64URL();
    return `did:dns:pk;kty=ed25519;pk=${pk}`;
  }

  buildDidDnsBlacklist() {
    const revoked = this.getRevokedFingerprints();
    if (!revoked || revoked.length === 0) return null;
    return `did:dns:black;fp=${revoked.join(',')}`;
  }
}
```

### 6.2 Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Update at 80% of TTL | 300s TTL → 240s interval. 60s buffer before expiration. |
| No exponential backoff | DNS is eventually consistent. Missed update = stale data, not broken connection. |
| HTTPS SRV optional | Many nodes run behind reverse proxies; HTTPS is only included if explicitly configured. |
| DID-DNS: identity + key split | Separate TXT records avoid 255-byte RDATA limit; fingerprint chain ensures integrity. |
| Ed25519 keys | 32-byte keys produce compact Base64URL (~43 chars), ideal for DNS TXT records. |
| DNSSEC required | Prevents DNS spoofing that could substitute a fake public key in the identity chain. |

---

## 7. Security Considerations

| Threat | Mitigation |
|--------|-----------|
| Token leaked in logs | Token in env var, never logged |
| Replay attack | HTTPS. Idempotent API makes replays harmless |
| Malicious node hijacks domain | Token is per-domain; compromise requires stealing the specific token |
| DNS spoofing | DNSSEC on `kirinnet.org` zone (future) |
| SRV hijacking | DNSSEC. Resolver verifies target domain matches expected FQDN |

---

## 8. Self-Hosted DNS

For fully decentralized deployments, nodes can run their own DNS server (CoreDNS with a custom plugin). The API endpoint becomes:

```
POST https://{self-hosted-dns}/api/v2/update
```

Same API contract. Authentication via mTLS or localhost-only access.

---

## 9. Open Questions

1. **Multi-node SRV?** A single domain may have multiple nodes behind it (load-balanced). SRV natively supports this via multiple records with different priorities/weights. Implementation TBD.
2. **IPv6-only nodes?** AAAA record handles this. SRV format is IP-agnostic.
3. **Mobile node TTL?** Nodes on cellular may need TTL as low as 60s. The minimum TTL of 60s balances freshness against DNS query load.
4. **Service discovery beyond KirinNet?** The `_kirinnet-*` namespace is reserved. Extensions (IPFS gateway, STUN, TURN) use `_kirinnet-ipfs._tcp`, `_kirinnet-stun._udp`, etc.
