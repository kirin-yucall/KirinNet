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

2. **TXT Layer:** Minimal identity metadata (UUID/DID, public key,
   nickname) encoded as a semicolon-separated key=value string in a DNS
   TXT record. This layer is constrained by the TXT record size limit
   and is designed for fast, universal resolution.

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

ADRP defines three SRV service names under the `_tcp` protocol:

| Service   | SRV Name             | Description                    |
|-----------|----------------------|--------------------------------|
| HTTP      | `_kirinnet-http._tcp` | HTTP service port              |
| HTTPS     | `_kirinnet-https._tcp`| HTTPS service port             |
| WebSocket | `_kirinnet-ws._tcp`   | WebSocket service port         |

A Client issues standard SRV queries (RFC 2782) for the relevant service
name under the target domain name.

### 2.3. Identity TXT Record

An Identity TXT Record is a DNS TXT record encoded as a semicolon-
separated key=value string containing minimal identity metadata.

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

#### 3.2.1. Format

The identity TXT record uses a semicolon-separated key=value format:

```
id=<uuid>;key=<hex_public_key>;nick=<nickname>[;ipfs=<bool>]
```

**Fields:**

| Key     | Required | Description                                          |
|---------|----------|------------------------------------------------------|
| `id`    | REQUIRED | Unique identifier (UUID v4 or DID format)             |
| `key`   | REQUIRED | Hex-encoded long-term public key (e.g., secp256k1)   |
| `nick`  | OPTIONAL | Human-readable display name                          |
| `ipfs`  | OPTIONAL | Boolean (`true`/`false`) indicating IPFS gateway     |

**Constraints:**

- All values MUST be percent-encoded if they contain semicolons or
  equals signs. Values SHOULD avoid these characters when possible.
- `id` MUST be unique across the KirinNet network.
- `key` MUST be the hex-encoded uncompressed public key without a `0x`
  prefix. The RECOMMENDED key type is secp256k1 (65 bytes → 130 hex chars).
- `nick` SHOULD be at most 64 characters.
- Fields MAY appear in any order.
- Unknown keys are silently ignored by the Client.

**Examples:**

```
; Full identity record
id=550e8400-e29b-41d4-a716-446655440000;key=04a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6;nick=Alice;ipfs=false

; Minimal record (only required fields)
id=660e8400-e29b-41d4-a716-446655440001;key=04b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7
```

#### 3.2.2. Coexistence with Other TXT Records

The identity TXT record is placed alongside other TXT records (SPF,
DKIM, DMARC). The Client MUST identify the KirinDNS identity record by
scanning TXT records for the `id=` and `key=` prefixes. The first TXT
record whose value starts with `id=` and contains at least the `key=`
field is the identity record.

A domain MAY have at most ONE identity TXT record. If multiple TXT
records match the identity format, the Client SHOULD use the first one
encountered.

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
an encrypted DNS transport.

**Step 2 — Scan for Identity Record**

The Client iterates through all returned TXT records. For each record,
it checks whether the value begins with `id=` and contains a `key=`
field. The first such record is the identity record.

**Step 3 — Parse Identity**

The Client splits the record value on semicolons (`;`) and parses each
segment as `key=value`. Recognized keys are extracted into an identity
object. Unknown keys are silently ignored.

If no identity TXT record is found, the Client proceeds with a null
identity (no peer verification via KirinDNS identity).


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

### 4.2. DNSSEC Integration

ADRP SRV and TXT records SHOULD be signed under DNSSEC. When a Client
supports DNSSEC validation, it SHOULD reject ADRP responses that fail
DNSSEC validation. If DNSSEC validation fails, the Client has two
options:

1. **Fallback mode (RECOMMENDED):** Treat the ADRP records as invalid
   and fall back to the standard port. This preserves connectivity.
2. **Strict mode (OPTIONAL):** Abort the connection entirely and report
   an error. Appropriate for high-security contexts.

### 4.3. Encrypted DNS Transport (DoT/DoH)

ADRP SRV and TXT queries MUST be sent over an encrypted DNS transport:
DNS-over-TLS (DoT) as defined in [RFC 7858], or DNS-over-HTTPS (DoH) as
defined in [RFC 8484]. Unencrypted DNS (UDP/TCP port 53) MUST NOT be
used for ADRP queries.

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

### 6.2. TXT Record Format

No new IANA registries are required. The identity TXT record format is
defined within this specification only.


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
