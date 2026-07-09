# KirinDNS Resolution Protocol (ADRP)

Internet-Draft: KirinDNS Resolution Protocol (ADRP)
Category: Standards Track
Expires: 2025-12-31
Authors: KirinDNS Working Group


## Abstract

The KirinDNS Resolution Protocol (ADRP) is a lightweight DNS-based discovery
protocol that conveys transport-layer port information and minimal identity
metadata via DNS TXT records. It enables clients to discover non-standard
service ports and a user's unique identifier/nickname for a given domain
without user intervention, while remaining fully backward-compatible with
existing DNS infrastructure.

ADRP follows a two-layer architecture:

1. **DNS Layer (ADRP TXT record):** Contains ONLY minimal discovery data —
   port numbers and a short identity (UUID/DID + nickname). This layer is
   constrained by the 255-octet TXT record size limit and is designed for
   fast, universal resolution.

2. **Application Layer (Profile Service):** Detailed profile data (bios,
   avatars, social links, content catalogs) are hosted on a per-user
   Profile Service — a simple JSON API or static page served on the
   ADRP-discovered port. Third-party applications fetch the TXT record,
   resolve the port, then GET `/profile.json` from the Profile Service.

This separation ensures that DNS remains fast and minimal while rich
application data lives where it belongs: on the user's own server.

ADRP introduces no new DNS record types, no new port numbers, and no
modifications to A/AAAA resolution. It is strictly additive and operates
as an orthogonal discovery layer alongside traditional DNS.


## Table of Contents

    1. Abstract ........................................................ 1
    2. Conventions and Definitions ..................................... 2
    3. Protocol Specification .......................................... 3
       3.1. Syntax ..................................................... 3
       3.2. Resolution Process ......................................... 4
    4. Security Considerations ......................................... 5
       4.1. DNS Spoofing and Port Hijacking ............................ 5
       4.2. DNSSEC Integration ......................................... 6
       4.3. Encrypted DNS Transport (DoT/DoH) .......................... 6
       4.4. Port Exhaustion and Denial-of-Service ...................... 7
       4.5. Mixed-Content Scenarios .................................... 7
    5. Interoperability with Existing Standards ........................ 8
       5.1. DNS (RFC 1035 / RFC 1034) ................................ 8
       5.2. HTTP/HTTPS (RFC 7230 / RFC 9110) .......................... 8
       5.3. QUIC/HTTP3 (RFC 9000 / RFC 9114) .......................... 9
    6. IANA Considerations ............................................. 9
       6.1. DNS Record Types ........................................... 9
       6.2. Port Numbers ............................................... 9
       6.3. KirinDNS JSON Keys Registry ................................. 9
    7. References ....................................................... 10


## 2. Conventions and Definitions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in [RFC 2119] and [RFC 8174].

### 2.1. KirinDNS Record

An KirinDNS Record is a DNS TXT record whose RDATA contains a JSON object
conforming to the ADRP schema defined in Section 3.1. An KirinDNS Record is
associated with a single domain name (e.g., `example.com`).

### 2.2. Resolver

A Resolver is a DNS server that can process ADRP queries. The Resolver
returns the TXT record(s) for the queried domain. The Resolver MAY be the
authoritative nameserver for the domain or an upstream recursive resolver.
ADRP imposes no requirements on Resolver implementation beyond standard TXT
record handling as defined in [RFC 1035].

### 2.3. Client

A Client is an application (typically a web browser or HTTP client library)
that performs ADRP resolution. The Client issues a TXT query for the target
domain, parses the resulting KirinDNS Record, and uses the extracted port
information to establish the network connection. The Client is responsible
for implementing the resolution algorithm defined in Section 3.2.

### 2.4. Fallback Behavior

Fallback Behavior refers to the Client's action when an KirinDNS Record is
missing, malformed, or does not contain the protocol key requested by the
Client. In this case, the Client MUST fall back to the well-known default
port for the requested protocol: port 80 for HTTP, port 443 for HTTPS, port
80 for WS, and port 443 for WSS. Fallback Behavior ensures that ADRP is
strictly backward-compatible: domains without an KirinDNS Record continue to
function as before.

### 2.5. Non-Modification of A/AAAA Records

ADRP does NOT modify, intercept, or alter A or AAAA record resolution in any
way. The Client resolves the IP address of the target domain through standard
A/AAAA queries as defined in [RFC 1035]. ADRP only influences the TCP/UDP
port used for the subsequent connection. A/AAAA records and ADRP TXT records
are entirely independent and may be served by different authoritative nameservers.


## 3. Protocol Specification

### 3.1. Syntax

#### 3.1.1. JSON Schema

An KirinDNS Record contains a single JSON object with the following schema:

```json
{
  "http":  <port>,   // OPTIONAL - TCP port for HTTP
  "https": <port>,   // OPTIONAL - TCP port for HTTPS
  "ws":    <port>,   // OPTIONAL - TCP port for WebSocket (unencrypted)
  "wss":   <port>    // OPTIONAL - TCP port for WebSocket (encrypted)
}
```

**Constraints:**

- Each key's value MUST be an integer representing a valid TCP port number
  in the range 1-65535 (inclusive).
- Keys MUST be strings. The recognized key names are: `http`, `https`, `ws`,
  `wss`. Any key not in this set is treated as unknown and ignored.
- At least one key MUST be present for the record to be considered valid.
- Duplicate keys MUST NOT appear; if a Client encounters duplicate keys, it
  MUST treat the entire record as invalid and fall back (see Section 3.2).
- The JSON MUST be valid UTF-8.
- The JSON object MUST be the sole content of the TXT record's character
  string. No additional text, whitespace, or comments may precede or follow
  the JSON object within the same TXT string.

**Examples:**

```json
// Standard case: non-standard HTTP and HTTPS ports
{"http": 8080, "https": 8443}

// HTTPS only
{"https": 8443}

// All four protocols
{"http": 8080, "https": 8443, "ws": 8080, "wss": 8443}
```

#### 3.1.2. Multiple TXT Records

A domain MAY have multiple TXT records. ADRP defines the following aggregation
strategy:

1. The Client MUST retrieve ALL TXT records for the queried domain.
2. The Client MUST attempt to parse each TXT record as a JSON object
   independently, starting with the first record in the response set.
3. The first TXT record that parses as valid JSON and conforms to the ADRP
   schema is used as the ADRP response. Subsequent TXT records are ignored
   for ADRP purposes.
4. If no TXT record in the response set is a valid ADRP record, the Client
   MUST fall back to the default port (see Section 3.2).

This "first valid" strategy ensures that a domain can coexist with other TXT
record uses (e.g., SPF, DKIM, DMARC) without ADRP misinterpreting those
records. SPF records, for example, begin with `v=spf1` and will fail JSON
parsing, so they will be skipped.

### 3.2. Resolution Process

The ADRP resolution process is executed by the Client as follows:

**Step 1 — Issue TXT Query**

The Client issues a DNS TXT query for the target domain (e.g., `example.com`)
using an encrypted DNS transport (DoT or DoH; see Section 4.3). The query is
a standard DNS TXT query as defined in [RFC 1035].

**Step 2 — Retrieve TXT Records**

The Resolver returns zero or more TXT records. If the query returns NXDOMAIN
or NOERROR with an empty answer section, the Client proceeds to Step 5
(Fallback).

**Step 3 — Aggregate and Parse**

The Client applies the aggregation strategy from Section 3.1.2:
- Iterates through TXT records in order.
- Attempts to parse each as JSON.
- Selects the first valid ADRP record.
- If no valid record is found, proceeds to Step 5 (Fallback).

**Step 4 — Extract Port**

From the selected ADRP record, the Client extracts the port value corresponding
to the requested protocol key:

- If the Client is establishing an HTTP connection, it looks for the `http` key.
- If the Client is establishing an HTTPS connection, it looks for the `https` key.
- If the Client is establishing a WS connection, it looks for the `ws` key.
- If the Client is establishing a WSS connection, it looks for the `wss` key.

If the key is present and the value is a valid port (integer, 1-65535), the
Client uses that port. If the key is absent, the Client proceeds to Step 5.

**Step 5 — Fallback**

If the key is absent, the JSON is invalid, or no TXT record was found, the
Client falls back to the standard port:

| Protocol | Fallback Port |
|----------|---------------|
| HTTP     | 80            |
| HTTPS    | 443           |
| WS       | 80            |
| WSS      | 443           |

**Step 6 — Establish Connection**

The Client resolves the A/AAAA record for the target domain (standard DNS
resolution) and establishes a TCP/UDP connection to the resolved IP address
and port (from Step 4 or Step 5).


## 4. Security Considerations

### 4.1. DNS Spoofing and Port Hijacking

ADRP introduces a new attack surface: if an attacker can inject or modify the
TXT record for a domain, they can redirect the Client to an arbitrary port.
This is analogous to DNS cache poisoning for A records, but with a narrower
impact (port redirection rather than full IP redirection).

**Attack scenario:** An attacker performs a DNS spoofing attack, injecting a
fake TXT record for `bank.example.com` with `{"https": 9999}`. The Client,
believing the ADRP record, connects to port 9999 on the legitimate server IP
(addressed via A/AAAA). If the attacker also controls port 9999 on a
compromised machine at the same IP, or if the attacker can influence routing,
this could lead to a man-in-the-middle attack.

**Mitigations:**

1. **DNSSEC (Section 4.2):** The primary defense. ADRP TXT records MUST be
   covered by DNSSEC signatures. The Client SHOULD validate DNSSEC signatures
   on ADRP responses before trusting the port information.
2. **Encrypted DNS transport (Section 4.3):** DoT or DoH prevents on-path
   adversaries from reading or modifying the query/response.
3. **Certificate validation:** For HTTPS and WSS, the Client MUST validate
   the TLS certificate regardless of the port. A port change does not relax
   certificate requirements.

### 4.2. DNSSEC Integration

ADRP TXT records SHOULD be signed under DNSSEC. The domain owner MUST include
the KirinDNS TXT record in the zone's RRSIG coverage.

When a Client supports DNSSEC validation (via DoT with DNSSEC support, or
DoH with DNSSEC support), it SHOULD reject ADRP responses that fail DNSSEC
validation. If DNSSEC validation fails for the ADRP record, the Client has
two options:

1. **Fallback mode (RECOMMENDED):** Treat the ADRP record as invalid and
   fall back to the standard port. This preserves connectivity while
   avoiding unverified port redirection.
2. **Strict mode (OPTIONAL):** Abort the connection entirely and report an
   error to the user. This is appropriate for high-security contexts (e.g.,
   banking, healthcare).

A Client MAY allow the domain operator to signal the preferred mode via a
future extension to the ADRP schema (e.g., an `adrp-strict` flag).

### 4.3. Encrypted DNS Transport (DoT/DoH)

ADRP TXT queries MUST be sent over an encrypted DNS transport:

- **DNS-over-TLS (DoT)** as defined in [RFC 7858], or
- **DNS-over-HTTPS (DoH)** as defined in [RFC 8484]

Unencrypted DNS (UDP/TCP port 53) MUST NOT be used for ADRP queries, as it
allows trivial interception and modification of port information.

A Client that can only perform unencrypted DNS queries SHOULD fall back to
the standard port rather than attempt ADRP resolution. This ensures that a
lack of encrypted DNS support does not expose the Client to port hijacking.

### 4.4. Port Exhaustion and Denial-of-Service

An attacker who controls (or compromises) a domain's DNS could set the ADRP
port to a rapidly changing value, forcing Clients to attempt connections to
random ports. This could:

- Cause connection timeouts, consuming Client resources.
- Flood the server with connection attempts on random ports if the Client
  retries.

**Mitigations:**

1. **Rate limiting:** The Client SHOULD implement rate limiting on ADRP
   queries. If the same domain is queried more than N times per time window
   (e.g., 10 times per 60 seconds), the Client SHOULD cache the previous
   ADRP response for the duration of the window rather than issuing new
   queries.
2. **Connection timeout:** The Client MUST apply a reasonable connection
   timeout (RECOMMENDED: 10 seconds) when connecting to ADRP-discovered
   ports. If the connection fails, the Client SHOULD fall back to the
   standard port rather than retrying the ADRP-discovered port.
3. **Caching:** ADRP responses SHOULD be cached for the duration of the TXT
   record's TTL. Clients MUST respect the TTL value.

### 4.5. Mixed-Content Scenarios

A domain may publish an ADRP record where the `http` port and `https` port
differ. For example:

```json
{"http": 8080, "https": 8443}
```

A Client navigating to `https://example.com` will connect to port 8443.
If the page loaded from port 8443 makes a subresource request to
`http://example.com/resource.js`, the Client will resolve the ADRP record
again and connect to port 8080 for that subresource.

**Security implications:**

- A page loaded over HTTPS (port 8443) that loads resources over HTTP
  (port 8080) creates a classic mixed-content vulnerability. The Client
  SHOULD handle this according to standard mixed-content policies as defined
  in [RFC 9110] and browser security standards.
- The Client MUST NOT upgrade an HTTP subresource request to HTTPS based
  solely on the presence of an `https` key in the ADRP record. Protocol
  selection is determined by the URL scheme, not the ADRP record.
- If a Client is configured with strict mixed-content blocking, it SHOULD
  block HTTP subresources regardless of the ADRP-discovered port.


## 5. Interoperability with Existing Standards

### 5.1. DNS (RFC 1035 / RFC 1034)

ADRP operates entirely within the existing DNS framework. It uses only the
TXT record type as defined in [RFC 1035] and follows the DNS concepts and
terminology defined in [RFC 1034]. ADRP imposes no requirements on DNS
implementation beyond standard TXT record support.

Key compatibility points:

- ADRP TXT records coexist with other TXT records (SPF, DKIM, DMARC, etc.)
  on the same domain. Clients use the aggregation strategy in Section 3.1.2
  to identify ADRP records.
- ADRP does not require any changes to DNS servers, resolvers, or
  authoritative nameservers.
- ADRP does not introduce new DNS record types, opcodes, or response codes.

### 5.2. HTTP/HTTPS (RFC 7230 / RFC 9110)

ADRP only influences the initial connection setup — specifically, which TCP
port the Client connects to. Once the connection is established, the
application-layer protocol (HTTP/1.1, HTTP/2, HTTP/3) operates normally.

Key compatibility points:

- The `Host` header in HTTP requests is unaffected by ADRP. The Client
  sends `Host: example.com` regardless of whether the connection was made to
  port 80 or port 8080.
- ADRP does not modify the HTTP/1.1 semantics defined in [RFC 7230] or the
  HTTP semantics defined in [RFC 9110].
- ADRP does not affect HTTP/2 or HTTP/3 protocol behavior. The ALPN
  negotiation proceeds normally after the TCP connection is established.
- A domain using ADRP with non-standard ports is indistinguishable from a
  domain using standard ports at the HTTP protocol level.

### 5.3. QUIC/HTTP3 (RFC 9000 / RFC 9114)

QUIC (and HTTP/3) uses UDP port 443 by convention. ADRP does not define a
dedicated key for QUIC, as QUIC shares the same port as HTTPS.

**Behavior when ADRP specifies a non-standard HTTPS port:**

If a domain's ADRP record contains `"https": 8443`, a QUIC-capable Client
has two options:

1. **QUIC-first approach (RECOMMENDED):** The Client first attempts a QUIC
   connection to the ADRP-discovered HTTPS port (e.g., UDP port 8443). If
   the QUIC connection succeeds, it is used for HTTP/3. If it fails, the
   Client falls back to TCP to the same port for HTTP/1.1 or HTTP/2.
2. **Separate ports:** The domain operator MAY configure QUIC and TCP/HTTPS
   on the same port (recommended) or different ports. If different ports are
   needed, a future ADRP extension could introduce a `quic` key. However,
   this is not defined in this version of the specification.

**Default QUIC port fallback:** If no ADRP record is present or the `https`
key is absent, the Client uses UDP port 443 for QUIC, consistent with
[RFC 9000].

**Important:** A Client MUST NOT assume that the TCP port specified for
`https` is the same as the UDP port for QUIC. If the ADRP-discovered HTTPS
port is non-standard, the Client SHOULD attempt QUIC on that same port
first, and if that fails, fall back to the standard QUIC port (443).


## 6. IANA Considerations

### 6.1. DNS Record Types

ADRP uses the existing TXT record type as defined in [RFC 1035]. No new DNS
record types are required or registered by this specification.

### 6.2. Port Numbers

ADRP does not register any new port numbers. It only enables Clients to
discover port numbers dynamically from DNS TXT records. Port numbers used in
ADRP records are chosen by the domain operator and may be any valid port
(1-65535).

### 6.3. KirinDNS JSON Keys Registry

IANA is requested to establish an "KirinDNS JSON Keys" registry. This
registry will track the JSON key names recognized by ADRP clients.

The initial registry entries are:

| Key     | Description                                    | RFC        |
|---------|------------------------------------------------|------------|
| http    | TCP port for HTTP                              | [This spec]|
| https   | TCP port for HTTPS                             | [This spec]|
| ws      | TCP port for WebSocket (unencrypted)           | [This spec]|
| wss     | TCP port for WebSocket (encrypted)             | [This spec]|

Future extensions to ADRP that introduce new keys (e.g., `quic` for QUIC
port, `grpc` for gRPC port) MUST be registered in this registry. The
registration policy is "Expert Review" — one or more IANA-appointed experts
will review new key registrations for consistency and interoperability.


## 7. References

### Normative References

[RFC 1034] Mockapetris, P., "DOMAIN NAMES - CONCEPTS AND FACILITIES",
           STD 13, RFC 1034, DOI 10.17487/RFC1034, November 1987.

[RFC 1035] Mockapetris, P., "DOMAIN NAMES - IMPLEMENTATION AND SPECIFICATION",
           STD 13, RFC 1035, DOI 10.17487/RFC1035, November 1987.

[RFC 2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement
           Levels", BCP 14, RFC 2119, DOI 10.17487/RFC2119, March 1997.

[RFC 7230] Fielding, R., et al., "Hypertext Transfer Protocol (HTTP/1.1):
           Message Syntax and Routing", RFC 7230, DOI 10.17487/RFC7230,
           June 2014.

[RFC 7858] Hu, Z., et al., "Specification for DNS over Transport Layer
           Security (TLS)", RFC 7858, DOI 10.17487/RFC7858, April 2016.

[RFC 8484] Hu, Z., Palombini, C., Weiler, S., and S. Bellovin, "DNS Queries
           over HTTPS (DoH)", RFC 8484, DOI 10.17487/RFC8484, October 2018.

[RFC 8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119
           Key Words", BCP 14, RFC 8174, DOI 10.17487/RFC8174, May 2017.

[RFC 9000] Iyengar, J. and M. Thomson, "QUIC: A UDP-Based Multiplexed and
           Secure Transport", RFC 9000, DOI 10.17489/RFC9000, May 2021.

[RFC 9110] Fielding, R. and M. Hadley, "HTTP Semantics", RFC 9110,
           DOI 10.17489/RFC9110, June 2022.

[RFC 9114] Bishop, M., "HTTP/3", RFC 9114, DOI 10.17489/RFC9114, June 2022.

### Informative References

[RFC 4408] Kitterman, S., "SPF: Sender Policy Framework",
           RFC 4408, DOI 10.17487/RFC4408, April 2006.

[RFC 6376] Kucherawy, M. and M. Levine, "DomainKeys Identified Mail (DKIM)
           Signatures", RFC 6376, DOI 10.17487/RFC6376, September 2011.

[RFC 7489] Kitterman, S., et al., "Domain-based Message Authentication,
           Reporting, and Conformance (DMARC)", RFC 7489, DOI 10.17487/RFC7489,
           March 2015.
