# KirinDNS Resolution Protocol (ADRP) v2.0

Internet-Draft: KirinDNS Resolution Protocol (ADRP)
Category: Standards Track
Expires: 2027-01-31
Authors: KirinNet Working Group


## Abstract

The KirinDNS Resolution Protocol (ADRP) is a lightweight DNS-based
discovery protocol that conveys transport-layer port information via DNS
SRV records and minimal identity metadata via DNS TXT records. It
enables clients to discover non-standard service ports and user identity
for a given domain without user intervention, while remaining fully
backward-compatible with existing DNS infrastructure.

ADRP follows a two-layer architecture:

1. **SRV Layer:** Service port discovery via standard DNS SRV records
   (RFC 2782). For each supported service protocol (HTTP, HTTPS,
   WebSocket), a dedicated SRV record advertises the target host and
   port. This layer provides structured, typed service discovery that
   existing DNS infrastructure already supports.

2. **TXT Layer:** Identity metadata expressed via the `did:dns:`
   three-record model (identity declaration, public key, blacklist)
   defined in the [DID-DNS Protocol](./did-dns-protocol.md). Each record
   is constrained to ≤200 bytes. This layer is designed for fast,
   universal resolution.

This separation ensures that DNS remains fast and minimal — SRV handles
typed service discovery natively, while identity lives in the flexible
TXT space alongside other TXT record uses (SPF, DKIM, DMARC).

ADRP introduces no new DNS record types, no new port numbers, and no
modifications to A/AAAA resolution. It is strictly additive and operates
as an orthogonal discovery layer alongside traditional DNS.


## Table of Contents

    1. Abstract ........................................................ 1
    2. Conventions and Definitions ..................................... 2
    3. Protocol Specification .......................................... 3
       3.1. SRV Records — Service Discovery ............................ 3
       3.2. TXT Record  — Identity Metadata ............................ 4
       3.3. Resolution Process ......................................... 5
    4. Security Considerations ......................................... 6
       4.1. DNS Spoofing and SRV Hijacking ............................. 6
       4.2. DNSSEC Integration ......................................... 7
       4.3. Encrypted DNS Transport (DoT/DoH) .......................... 7
       4.4. Port Exhaustion and Denial-of-Service ...................... 7
    5. Interoperability with Existing Standards ........................ 8
       5.1. DNS (RFC 1035 / RFC 2782) ................................ 8
       5.2. HTTP/HTTPS (RFC 7230 / RFC 9110) .......................... 9
       5.3. QUIC/HTTP3 (RFC 9000 / RFC 9114) .......................... 9
    6. IANA Considerations ............................................. 9
       6.1. SRV Service Names .......................................... 9
       6.2. TXT Record Format .......................................... 10
    7. References ....................................................... 10


## 2. Conventions and Definitions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in [RFC 2119] and [RFC 8174].

### 2.1. KirinDNS Resolution

KirinDNS resolution is the process of querying DNS SRV and TXT records
for a domain to discover: (1) the TCP port on which each KirinNet
service is listening, and (2) the domain owner's identity metadata.

### 2.2. SRV Service Names

ADRP defines three SRV service names for node services under the `_tcp`
protocol, plus one relay capability-announcement name (KNET-CC-013,
2026-08-24):

| Service   | SRV Name             | Description                    |
|-----------|----------------------|--------------------------------|
| HTTP      | `_kirinnet-http._tcp` | HTTP service port              |
| HTTPS     | `_kirinnet-https._tcp`| HTTPS service port             |
| WebSocket | `_kirinnet-ws._tcp`   | WebSocket service port         |
| Relay     | `_kirinnet-relay._tcp`| Relay service discovery — a relay operator announces this SRV under its own domain; defined in the [Relay Protocol §3.1](./relay_protocol.md) |

A Client issues standard SRV queries (RFC 2782) for the relevant service
name under the target domain name.

### 2.3. Identity TXT Records (DID-DNS)

An Identity is expressed via a set of DNS TXT records using the
`did:dns:` prefix, defined in detail in the [DID-DNS Protocol](./did-dns-protocol.md).
Three record types carry the identity metadata:

| Prefix | Record Type | Required |
|--------|-------------|----------|
| `did:dns:v=...` | Identity declaration (version, fingerprint, nickname, gender, timestamps) | Yes |
| `did:dns:pk;...` | Public key (key type + full public key) | Yes |
| `did:dns:black;...` | Blacklist of revoked key fingerprints | No |

> **Migration note (C-1, 9.2/9.3, 2026-08-08):** The legacy single-record
> format `id=<uuid>;key=<hex>;nick=<name>[;ipfs=<bool>]` is **deprecated**.
> Identity is now carried by the DID-DNS three-record model. See
> [DID-DNS Protocol §2](./did-dns-protocol.md) for the authoritative field
> definitions and `DECISIONS.md` §9.2 for the migration mapping.

### 2.4. Client

A Client is an application (typically a web browser, HTTP client library,
or KirinNet User Node) that performs KirinDNS resolution. The Client
issues SRV and TXT queries for the target domain and uses the resulting
port and identity data to establish connections and verify peers.

### 2.5. Fallback Behavior

If an SRV query returns NXDOMAIN or NOERROR with an empty answer section,
the Client MUST fall back to the well-known default port for the
requested protocol: port 80 for HTTP, port 443 for HTTPS. Fallback
Behavior ensures that ADRP is strictly backward-compatible: domains
without KirinDNS SRV records continue to function as before.


## 3. Protocol Specification

### 3.1. SRV Records — Service Discovery

#### 3.1.1. Record Format

Each KirinNet service publishes one SRV record per protocol:

```
_kirinnet-http._tcp.<domain>.  IN  SRV  <priority> <weight> <port> <target>.
_kirinnet-https._tcp.<domain>. IN  SRV  <priority> <weight> <port> <target>.
_kirinnet-ws._tcp.<domain>.    IN  SRV  <priority> <weight> <port> <target>.
```

**Constraints:**

- `<priority>` and `<weight>` MUST be valid SRV priority/weight values
  (0-65535). The RECOMMENDED value for both is 0 (no load balancing).
- `<port>` MUST be a valid TCP port number in the range 1-65535.
- `<target>` MUST be a valid domain name, typically the same as the
  queried domain. It MUST resolve to a valid A/AAAA record.
- Wildcard SRV records (`*.<domain>`) are NOT RECOMMENDED. Each domain
  SHOULD publish explicit SRV records.

**Examples:**

```
; Single-node setup, all services on the same host
_kirinnet-http._tcp.alice.kirinnet.org.  IN  SRV  0 0 8080 alice.kirinnet.org.
_kirinnet-https._tcp.alice.kirinnet.org. IN  SRV  0 0 8443 alice.kirinnet.org.
_kirinnet-ws._tcp.alice.kirinnet.org.    IN  SRV  0 0 8082 alice.kirinnet.org.

; Multi-node setup, services on different hosts
_kirinnet-http._tcp.example.com.  IN  SRV  0 0 3000 node1.example.com.
_kirinnet-https._tcp.example.com. IN  SRV  0 0 3443 node1.example.com.
_kirinnet-ws._tcp.example.com.    IN  SRV  0 0 8082 node2.example.com.
```

#### 3.1.2. Service Not Present

A domain MAY publish SRV records for a subset of services. For example,
a domain that only exposes HTTPS may omit the `_kirinnet-http._tcp` and
`_kirinnet-ws._tcp` records. If a Client queries for a service not
present, it MUST fall back to the standard port (see Section 3.3).

### 3.2. TXT Record — Identity Metadata

### 3.2.1. Format

> **Rewritten per C-1 decision (9.2/9.3, 2026-08-08).** The legacy
> single-record format is deprecated. The authoritative definition lives
> in the [DID-DNS Protocol §2](./did-dns-protocol.md); this section mirrors
> it for protocol completeness.

The identity metadata is carried by three TXT record types, distinguished
by their `did:dns:` prefix:

```
did:dns:v=1;fp=<fingerprint>;n=<nickname>;g=<gender>;iat=<issued>;exp=<expires>
did:dns:pk;kty=ed25519;pk=<public-key>
did:dns:black;fp=<fingerprint1>,<fingerprint2>,...
```

**Identity declaration record (`did:dns:v=1;...`) — required:**

| Key | Required | Description |
|-----|----------|-------------|
| `v` | REQUIRED | Protocol version, fixed `1` |
| `fp` | REQUIRED | Public key fingerprint: `Base64URL(SHA-256(full public key)[0:12])`, 16 chars |
| `n` | OPTIONAL | Nickname, `Base64URL(UTF-8)` encoded |
| `g` | OPTIONAL | Gender, single letter: `M` / `F` / `O` / `X` |
| `iat` | REQUIRED | Issued time, Unix seconds (integer) — for freshness check |
| `exp` | REQUIRED | Expiry time, Unix seconds (integer) |

**Public key record (`did:dns:pk;...`) — required:**

| Key | Required | Description |
|-----|----------|-------------|
| `kty` | REQUIRED | Key type, MUST be `ed25519` |
| `pk` | REQUIRED | Full public key, Base64URL encoded (32 bytes → ~43 chars) |

**Blacklist record (`did:dns:black;...`) — optional:**

| Key | Required | Description |
|-----|----------|-------------|
| `fp` | OPTIONAL | Comma-separated list of revoked key fingerprints |

**Constraints:**

- The fingerprint `fp` in the identity declaration MUST equal
  `Base64URL(SHA-256(pk)[0:12])` computed over the full public key in the
  `pk` record. This forms a tamper-evident chain binding the identity
  declaration to the public key.
- The public key type `kty` MUST be `ed25519` (Ed25519, 32 bytes). Other
  key types (e.g., RSA, secp256k1) are **deprecated** and MUST NOT be
  newly introduced. (C-3 / 9.1 — see `DECISIONS.md` §9.2.3.)
- The `iat` value MUST be within ±5 minutes of the current time at
  resolution (freshness check, anti-replay of stale records).
- Each TXT record MUST be at most 200 bytes to avoid DNS UDP
  fragmentation (see `DECISIONS.md` §9.2.4 for measured sizes:
  declaration 73B / public key 69B / blacklist 44B).
- Records MAY appear in any order; the Client classifies them by prefix.
- Unknown sub-keys within a record are silently ignored by the Client.
- **Record location (KNET-CC-016, countersigned & finalized 2026-08-28 — see
  [DID-DNS Protocol §2.4](./did-dns-protocol.md)):** the three identity
  TXT records are owned by the name `_kirinnet.did.<domain>.` (canonical
  location); a Client SHOULD query that name first over DoH/DoT and fall
  back to the apex TXT set if it yields no `did:dns:` records. SRV owner
  names (`_kirinnet-*._tcp/_udp.<domain>`) are unaffected.

**Examples:**

```
; Identity declaration (73 bytes)
did:dns:v=1;fp=AbCdEf1234aaaa;n=QWxpY2U;g=F;iat=1712345678;exp=1712432078

; Public key — Ed25519 (69 bytes)
did:dns:pk;kty=ed25519;pk=MCowBQYDK2VwAyEA...

; Blacklist — revoked fingerprints (44 bytes, 2 fingerprints)
did:dns:black;fp=OldKeyFp1aaaa,OldKeyFp2aaaa
```

> **Migration mapping (legacy → new):** `id=<uuid>` → identity anchor now
> carried by domain + fingerprint chain (UUID deprecated); `key=<hex>`
> (secp256k1, 130 hex) → `did:dns:pk;kty=ed25519;pk=<Base64URL>`
> (Ed25519); `nick=<plaintext>` → `n=<Base64URL(UTF-8)>`;
> `ipfs=<bool>` → **deprecated** (no DID-DNS equivalent; IPFS gateway, if
> needed, uses SRV extension `_kirinnet-ipfs._tcp`). New fields: `fp`
> (fingerprint chain), `g` (gender), `iat`/`exp` (time window),
> `did:dns:black` (revocation). Full mapping in `DECISIONS.md` §9.2.2.

#### 3.2.2. Coexistence with Other TXT Records

The identity TXT records are placed alongside other TXT records (SPF,
DKIM, DMARC). The Client MUST identify the KirinDNS identity records by
scanning TXT records for the `did:dns:` prefix and classifying them by
the three sub-types (`v=`, `pk;`, `black;`), consistent with the
[DID-DNS Protocol §6](./did-dns-protocol.md) and [DNS Automation §3](./dns_automation.md).

- A TXT record starting with `did:dns:v=` is the identity declaration.
- A TXT record starting with `did:dns:pk;` is the public key record.
- A TXT record starting with `did:dns:black;` is the blacklist record.
- Any other TXT record (SPF/DKIM/DMARC/etc.) is ignored for identity
  purposes but left intact for its original consumer.

> **Migration note (C-1, 9.2):** The legacy "scan for `id=` + `key=`
> prefixes" logic is **deprecated**. Identity records are now identified
> by the `did:dns:` prefix.

A domain SHOULD have exactly ONE identity declaration record and ONE
public key record. The blacklist record is optional. If multiple records
of the same sub-type are encountered, the Client SHOULD use the first
one of each and log a warning.

### 3.3. Resolution Process

The ADRP resolution process is executed by the Client as follows.

#### 3.3.1. Service Port Resolution (SRV)

**Step 1 — Issue SRV Query**

The Client issues a standard DNS SRV query (RFC 2782) for the relevant
service name under the target domain, using an encrypted DNS transport
(DoT or DoH; see Section 4.3).

Example: to discover the WebSocket port for `alice.kirinnet.org`, query:
`_kirinnet-ws._tcp.alice.kirinnet.org.  IN  SRV`

**Step 2 — Parse SRV Response**

If the query returns a valid SRV record set, the Client extracts the
target hostname and port from the record with the lowest priority (and
within that priority, the highest weight) as defined in RFC 2782.

If the query returns NXDOMAIN or NOERROR with an empty answer section,
the Client proceeds to Step 4 (Fallback).

**Step 3 — Extract Port**

The Client uses the port from the resolved SRV record. The target
hostname MAY differ from the queried domain; if it does, the Client MUST
resolve the target hostname via A/AAAA before connecting.

**Step 4 — Fallback**

If no SRV record is found for the requested service, the Client falls
back to the standard port for that service:

| Service      | Fallback Port |
|--------------|---------------|
| HTTP         | 80            |
| HTTPS        | 443           |
| WebSocket    | 80            |
| WSS          | 443           |

**Step 5 — Establish Connection**

The Client resolves the A/AAAA record for the target hostname (SRV
target or original domain) and establishes a TCP connection to the
resolved IP address and port.

#### 3.3.2. Identity Resolution (TXT)

**Step 1 — Issue TXT Query**

The Client issues a standard DNS TXT query for the target domain using
an encrypted DNS transport. Per [DID-DNS Protocol §2.4](./did-dns-protocol.md)
(KNET-CC-016, countersigned & finalized 2026-08-28), the query name is
`_kirinnet.did.<target domain>` (canonical record location); if that name
returns NXDOMAIN or contains no `did:dns:` records, the Client SHOULD
fall back to a TXT query on the apex `<target domain>` (compatibility
fallback). Both queries MUST use encrypted DNS transport (DoH/DoT).

**Step 2 — Classify Records by Prefix**

The Client iterates through all returned TXT records and classifies
those beginning with `did:dns:` into three buckets by sub-type
(consistent with [DID-DNS Protocol §6](./did-dns-protocol.md)):

- `did:dns:v=...` → identity declaration (parse `v/fp/n/g/iat/exp`)
- `did:dns:pk;...` → public key (parse `kty/pk`)
- `did:dns:black;...` → blacklist (parse the `fp` list)

Non-`did:dns:` TXT records are ignored for identity purposes.

**Step 3 — Verify Fingerprint Chain**

The Client verifies the tamper-evident binding between the identity
declaration and the public key:

1. Recompute the fingerprint from the public key record:
   `fp' = Base64URL(SHA-256(full public key bytes)[0:12])`.
2. Compare `fp'` against the `fp` field in the identity declaration.
   They MUST match exactly; otherwise the records are treated as invalid.
3. Check freshness: `iat` MUST be within ±5 minutes of the current time
   (anti-replay of stale records); `exp` MUST be in the future.
4. Check revocation: the `fp` value MUST NOT appear in the `black` list.
5. The public key type `kty` MUST be `ed25519`; any other type is
   rejected.

If no `did:dns:` identity records are found, the Client proceeds with a
null identity (no peer verification via KirinDNS identity).

> **Migration note (C-1, 9.2):** The legacy "split on `;` and parse
> `id=`/`key=`/`nick=`/`ipfs=`" logic is **deprecated**, replaced by the
> prefix-classification + fingerprint-chain verification above.


## 4. Security Considerations

### 4.1. DNS Spoofing and SRV Hijacking

An attacker who can inject or modify the SRV record for a domain can
redirect the Client to an arbitrary port and target host. This is
analogous to DNS cache poisoning for A records but potentially more
dangerous because it can fully redirect both host and port.

**Mitigations:**

1. **DNSSEC (Section 4.2):** The primary defense. ADRP SRV and TXT
   records MUST be covered by DNSSEC signatures.
2. **Encrypted DNS transport (Section 4.3):** DoT or DoH prevents
   on-path adversaries from reading or modifying the query/response.
3. **Certificate validation:** For HTTPS connections, the Client MUST
   validate the TLS certificate regardless of the SRV-discovered port
   or target hostname. The certificate's Subject Alternative Name (SAN)
   MUST match the original domain, NOT the SRV target.

> **Relay-scenario note (KNET-CC-013, 2026-08-24):** The rule in
> mitigation 3 applies verbatim to **direct** connections. When the
> path traverses a relay (SRV target = relay endpoint), certificate
> validation is layered instead: transport-layer TLS validates the
> **relay endpoint domain** (SNI/SAN vs. the SRV target), while node
> identity is verified at the application layer (did:dns TXT + T9
> signature challenge) over the tunnel. Direct-mode semantics are
> unchanged. See [Relay Protocol §9.2](./relay_protocol.md).

### 4.2. DNSSEC Integration

ADRP SRV and TXT records SHOULD be signed under DNSSEC. When a Client
supports DNSSEC validation, it SHOULD reject ADRP responses that fail
DNSSEC validation. If DNSSEC validation fails, the Client has two
options:

1. **Fallback mode (RECOMMENDED):** Treat the ADRP records as invalid
   and fall back to the standard port. This preserves connectivity.
   Note: for **identity records** (`did:dns:`), fallback means proceeding
   with a null identity (no peer verification), not silently accepting
   unvalidated identity records.
2. **Strict mode (OPTIONAL):** Abort the connection entirely and report
   an error. Appropriate for high-security contexts.

> **Fail-closed default (9.1 / R6):** When DNSSEC validation fails for
> identity records, the safe default is fail-closed (reject / null
> identity + warning). Any exception that silently accepts unvalidated
> identity records MUST be justified and approved via a KNET-CC change
> control. Connectivity fallback for SRV port records remains RECOMMENDED.

### 4.3. Encrypted DNS Transport (DoT/DoH)

ADRP SRV and TXT queries MUST be sent over an encrypted DNS transport:
DNS-over-TLS (DoT) as defined in [RFC 7858], or DNS-over-HTTPS (DoH) as
defined in [RFC 8484]. Unencrypted DNS (UDP/TCP port 53) MUST NOT be
used for ADRP queries.

**Fail-closed handling of plaintext DNS (9.2 / R6):** If an identity
record (`did:dns:`) is observed returning via plaintext DNS (UDP/TCP
53), the Client MUST treat it as untrusted — either reject it outright
or raise a downgrade warning to the user. The Client MUST NOT silently
accept plaintext-resolved identity records. This is consistent with
[security_model_v1.md §7.3](./security_model_v1.md) (DNS poisoning threat
and fail-closed requirement).

### 4.4. Port Exhaustion and Denial-of-Service

An attacker who controls a domain's DNS could set the SRV port to a
rapidly changing value, forcing Clients to attempt connections to random
ports. Mitigations:

1. **Rate limiting:** The Client SHOULD implement rate limiting on SRV
   queries (e.g., 10 queries per domain per 60 seconds).
2. **Connection timeout:** RECOMMENDED: 10 seconds. On failure, fall
   back to standard port.
3. **Caching:** ADRP SRV responses SHOULD be cached for the SRV
   record's TTL.


## 5. Interoperability with Existing Standards

### 5.1. DNS (RFC 1035 / RFC 2782)

ADRP uses standard SRV records [RFC 2782] for service discovery and TXT
records [RFC 1035] for identity metadata. No new DNS record types,
opcodes, or response codes are required. Existing authoritative
nameservers and recursive resolvers require no modifications.

### 5.2. HTTP/HTTPS (RFC 7230 / RFC 9110)

ADRP only influences the initial connection setup — specifically, which
TCP port and target host the Client connects to. Once the connection is
established, the application-layer protocol operates normally. The
`Host` header in HTTP requests MUST carry the original domain, not the
SRV target hostname.

### 5.3. QUIC/HTTP3 (RFC 9000 / RFC 9114)

ADRP does not define a dedicated SRV service name for QUIC. Clients
MUST use the standard QUIC port (UDP 443) or attempt QUIC on the
HTTPS SRV-discovered port. A future extension may add a
`_kirinnet-quic._udp` SRV service name.


## 6. IANA Considerations

### 6.1. SRV Service Names

IANA is requested to register the following SRV service names under the
`_tcp` protocol:

| Service Name          | Transport | Description              | Reference     |
|-----------------------|-----------|--------------------------|---------------|
| `_kirinnet-http`      | TCP       | KirinNet HTTP service     | [this document]|
| `_kirinnet-https`     | TCP       | KirinNet HTTPS service    | [this document]|
| `_kirinnet-ws`        | TCP       | KirinNet WebSocket service| [this document]|
| `_kirinnet-relay`     | TCP       | KirinNet relay service discovery | [Relay Protocol](./relay_protocol.md) (KNET-CC-013, 2026-08-24) |

### 6.2. TXT Record Format

No new IANA registries are required. The identity TXT record format
(`did:dns:` three-record model) is defined in the
[DID-DNS Protocol §2](./did-dns-protocol.md); this specification references
it (see §3.2.1) rather than redefining it. The SRV service names in §6.1
remain the IANA-facing registry managed by this specification.


## 7. References

### Normative References

[RFC 1034] Mockapetris, P., "DOMAIN NAMES - CONCEPTS AND FACILITIES",
           STD 13, RFC 1034, DOI 10.17487/RFC1034, November 1987.

[RFC 1035] Mockapetris, P., "DOMAIN NAMES - IMPLEMENTATION AND SPECIFICATION",
           STD 13, RFC 1035, DOI 10.17487/RFC1035, November 1987.

[RFC 2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement
           Levels", BCP 14, RFC 2119, DOI 10.17487/RFC2119, March 1997.

[RFC 2782] Gulbrandsen, A., Vixie, P., and L. Esibov, "A DNS RR for
           specifying the location of services (DNS SRV)", RFC 2782,
           DOI 10.17487/RFC2782, February 2000.

[RFC 7858] Hu, Z., et al., "Specification for DNS over Transport Layer
           Security (TLS)", RFC 7858, DOI 10.17487/RFC7858, April 2016.

[RFC 8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119
           Key Words", BCP 14, RFC 8174, DOI 10.17487/RFC8174, May 2017.

[RFC 8484] Hu, Z., Palombini, C., Weiler, S., and S. Bellovin, "DNS Queries
           over HTTPS (DoH)", RFC 8484, DOI 10.17487/RFC8484, October 2018.

[RFC 9000] Iyengar, J. and M. Thomson, "QUIC: A UDP-Based Multiplexed and
           Secure Transport", RFC 9000, DOI 10.17489/RFC9000, May 2021.

[RFC 9110] Fielding, R. and M. Hadley, "HTTP Semantics", RFC 9110,
           DOI 10.17489/RFC9110, June 2022.


## 8. Revision History

| Version | Date | Change | Reference |
|---|---|---|---|
| 2.0 | 2026-07-09 | Initial ADRP v2.0: SRV (RFC 2782) service discovery + TXT identity metadata | — |
| 2.1 | 2026-08-08 | **C-1 migration (9.2/9.3):** §2.3 / §3.2.1 / §3.2.2 / §3.3.2 migrated to the DID-DNS three-record model (`did:dns:v`/`pk`/`black`) with Ed25519 + fingerprint chain; legacy `id=;key=;nick=;ipfs=` single-record format deprecated. §4.3 strengthened with fail-closed plaintext-DNS handling; §4.2 fail-closed DNSSEC default added; §6.2 references did-dns-protocol.md for the authoritative TXT format. Per `DECISIONS.md` §9.2 (P-ARCH ruling). | C-1 · 9.2 · 9.3 · 波0 |
| 2.2 | 2026-08-28 | **Record location reference (KNET-CC-016, countersigned & finalized — 2026-08-28 node-PM countersign + protocol-PM merge master 4b81db4, jointly closed):** §3.2.1 Constraints adds one bullet referencing DID-DNS §2.4 — identity TXT records are owned by `_kirinnet.did.<domain>.` (canonical), Client SHOULD query that name first with apex fallback (RECOMMENDED), SRV owner names unaffected; §3.3.2 Step 1 extended with the same query-name semantics (additive sentences, no existing clause text altered). Background: Wave-2 contract-consistency audit finding CC-3 — the protocol set never defined the DNS name location of did:dns TXT records; apex-only clients cannot discover node-published records. | KNET-CC-016 (countersigned & closed 2026-08-28, master 4b81db4) · 波2 audit CC-3 · 协议PM ruling (2026-08-28 10:50) · 波2 |
