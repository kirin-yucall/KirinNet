# KirinDNS — IETF Standardization Roadmap

This document outlines the strategy for advancing the KirinDNS Resolution
Protocol (ADRP) from an Internet-Draft to an RFC-published Internet Standard,
and for achieving broad ecosystem adoption.

---

## 1. The IETF Proposal Process

### 1.1 Step 1 — Internet-Draft Submission

The current `spec_v1.md` is already written in RFC-style format (with
Conventions and Definitions, Security Considerations, IANA Considerations,
and References). The first step is to submit it as an Internet-Draft to the
IETF datatracker.

**Actions:**

1. Create an account on the [IETF Datatracker](https://datatracker.ietf.org/).
2. Submit `spec_v1.md` through the [IETF Draft Submission Tool](https://datatracker.ietf.org/submit/).
3. The draft will receive a temporary URL:
   `https://datatracker.ietf.org/doc/draft-kirindns-adrp/`
4. Internet-Drafts expire after 6 months unless submitted to a Working Group.

**Timeline:** 2–4 weeks for initial review and publication on the datatracker.

### 1.2 Step 2 — Working Group Selection

ADRP is a cross-cutting protocol that touches DNS operations, HTTP semantics,
and transport-layer port discovery. The most appropriate Working Groups are:

#### Primary: DNSOP (DNS Operations)

DNSOP is the best fit because ADRP's core mechanism is DNS-based port
discovery via TXT records. DNSOP handles operational improvements to DNS
without changing DNS's core protocol — exactly what ADRP does.

**Argument for DNSOP:**
- ADRP uses only existing DNS record types (TXT)
- No changes to DNS wire format, authoritative server behavior, or resolver
  algorithms
- The protocol's novelty is the *application* of DNS for port discovery, not
  a modification of DNS itself
- Precedent: DNSOP has published operational extensions like RFC 8484 (DoH)
  and RFC 8906 (EDNS Client Subnet)

#### Secondary: HTTPBIS (HTTP Bis)

HTTPBIS may be relevant if the working group decides that ADRP's impact on
HTTP connection setup (port selection) warrants joint review. HTTPBIS would
focus on the interoperability implications for HTTP clients and servers.

**Argument for HTTPBIS involvement:**
- ADRP influences which TCP port an HTTP client connects to
- HTTP semantics (RFC 9110) define default ports; ADRP extends this model
- HTTPBIS can validate that ADRP does not break existing HTTP assumptions

**Recommended approach:** Submit to DNSOP as the primary WG, and request
HTTPBIS as a reviewing WG. This is a common pattern for cross-cutting
protocols.

### 1.3 Step 3 — WG Last Call

Once DNSOP adopts the draft, the Working Group will issue a "WG Last Call"
for comments from the broader IETF community. This is typically a 3-week
period during which anyone can submit concerns.

**Anticipated critiques and prepared responses:**

| Concern | Response |
|---------|----------|
| **"Why not use a new DNS record type?"** | Adding a new RR type requires global propagation to all resolvers. Using TXT achieves the same goal with zero resolver changes — strictly additive. |
| **"TXT records can be spoofed"** | All DNS data can be spoofed. ADRP requires DoT/DoH (encrypted DNS) and recommends DNSSEC. The same mitigations apply to A records. |
| **"This is just port 80/443 in disguise"** | ADRP enables services that *must* run on non-standard ports (e.g., behind a reverse proxy, in a container, or sharing an IP) to be addressable via standard URLs. |
| **"Interoperability: what if two TXT records exist?"** | The "first valid" aggregation strategy (Section 3.1.2) provides deterministic behavior. |
| **"Performance: adding a TXT query adds latency"** | ADRP queries are cached (TTL-based). The additional latency is one DNS round-trip (~10-50ms with DoH), which is negligible compared to TCP+TLS handshake times. |
| **"Security: port hijacking"** | Addressed in Section 4.1 of the spec with three layers: DNSSEC, encrypted DNS, and certificate validation. |

**Actions during WG Last Call:**
1. Monitor the IETF mailing list (dnspop@ietf.org) for comments.
2. Respond to each comment within 48 hours.
3. Update the Internet-Draft to address concerns.
4. Prepare an IESG (IETF Standards Management) summary of changes.

### 1.4 Step 4 — RFC Publication

After WG Last Call, the draft moves to the IESG (Internet Engineering Steering
Group) for final review. The IESG has three possible decisions:

1. **Approve for publication** — the draft becomes an RFC.
2. **Send to IETF for last call** — the community is asked for final comments.
3. **Reject** — the draft is rejected (rare; usually results in revisions).

**Publication path:**

```
WG Last Call -> IESG Review -> RFC Editor -> RFC Publication
     (3 weeks)    (2-4 weeks)    (1-2 weeks)   (RFC assigned)
```

**RFC Category:** ADRP will be submitted as an **Informational** or
**Best Current Practice (BCP)** RFC initially, not as a Standards Track RFC.
This is because ADRP does not mandate implementation — it defines a discovery
mechanism that implementations may choose to adopt. The precedent for this
approach is RFC 8484 (DNS-over-HTTPS), which was published as Standards Track
but went through a gradual adoption phase.

**Timeline estimate:** 6–12 months from Internet-Draft submission to RFC
publication, assuming no major objections.

---

## 2. Addressing Key Stakeholders' Concerns

### 2.1 ISPs and CDN Providers

**Why they care:** ISPs and CDNs operate at the network edge and need to
optimize traffic routing. ADRP helps them in several ways:

**Benefits for ISPs:**
- **Better traffic visibility:** When services advertise their actual ports
  via ADRP, ISPs can make more informed routing decisions rather than
  assuming all HTTP traffic goes to port 80/443.
- **Reduced deep packet inspection (DPI) complexity:** Currently, ISPs must
  inspect traffic on non-standard ports to classify it. With ADRP, the port
  information is in DNS, so traffic classification can be done at the DNS
  resolution layer.
- **No infrastructure changes required:** ADRP uses standard DNS TXT records.
  ISPs' existing DNS infrastructure handles ADRP natively.

**Benefits for CDNs:**
- **Flexible origin routing:** CDNs can use ADRP to direct clients to
  different origin servers on different ports, enabling better load balancing
  and failover strategies.
- **Multi-tenant support:** A single IP address can serve multiple services
  on different ports, each discoverable via ADRP. This is valuable for
  edge computing platforms where multiple tenants share infrastructure.

**Key message:** *"ADRP gives you more data to make better routing decisions,
without requiring you to change anything."*

### 2.2 Security Vendors (WAFs, Firewalls, IDS/IPS)

**Why they care:** Security vendors must inspect and control traffic. ADRP
introduces non-standard ports that could potentially be used to bypass
port-based rules.

**How ADRP helps security vendors:**
- **DNS-layer visibility:** ADRP port information is available at DNS
  resolution time, giving WAFs and firewalls the opportunity to apply
  policies *before* the connection is established.
- **Integration with existing security infrastructure:** ADRP TXT records can
  be inspected by DNS-level security tools (e.g., DNS firewalls, DoH
  proxies). If a domain advertises an unexpected port, the security vendor
  can flag it.
- **No protocol-level changes:** ADRP does not modify HTTP, TLS, or any
  application-layer protocol. Once the connection is established, traffic
  looks identical to a connection on the standard port.

**Potential concerns and responses:**

| Concern | Response |
|---------|----------|
| **"ADRP could be used to hide malicious services on unusual ports"** | ADRP does not hide anything — the port is in plaintext in the DNS TXT record, visible to anyone who queries DNS. This is actually *more* transparent than using port 80/443 for everything. |
| **"Firewalls rely on port-based rules"** | ADRP-aware firewalls can read the TXT record and apply port-agnostic rules. For example, instead of "block port 8080," the rule becomes "block ADRP-discovered ports for this domain." |
| **"ADRP could bypass WAF port restrictions"** | ADRP-aware WAFs can intercept DNS queries and enforce port policies at the DNS layer, which is more effective than port-based filtering alone. |

**Key message:** *"ADRP makes port information visible at the DNS layer,
giving security tools more data, not less."*

### 2.3 Browser Vendors (Chrome, Firefox, Safari, Edge)

**Why they care:** Browser vendors want the best user experience. Currently,
when a user navigates to `https://dapp.example.com`, the browser always
connects to port 443. If the service is on a different port, the user gets
an error — or worse, the developer must force the user to type
`https://dapp.example.com:8443`.

**Benefits for browser vendors:**
- **Better UX for Web3 and decentralized apps:** Many Web3 services run on
  non-standard ports (e.g., local dev servers on :3000, IPFS gateways on
  :8080, custom node endpoints). ADRP eliminates the "wrong port" error
  entirely.
- **Zero user intervention:** ADRP is transparent to the end user. They type
  a standard URL, and the browser resolves the correct port automatically.
- **No breaking changes:** ADRP is purely additive. If a domain has no ADRP
  TXT record, the browser behaves exactly as it does today (connects to
  port 80/443).
- **Reduced support burden:** Fewer "can't connect" errors from users trying
  to reach services on non-standard ports.

**Adoption path for browser vendors:**

1. **Phase 1:** Support via extension (the KirinDNS extension we have built).
   This allows early adopters to test ADRP without waiting for browser
   integration.

2. **Phase 2:** Flag-based support. Browser vendors can add a flag
   (e.g., `chrome://flags/#enable-kirindns`) that enables ADRP resolution
   for testing.

3. **Phase 3:** Native support. Once ADRP is mature and has an RFC, browser
   vendors can integrate ADRP into their networking stacks.

**Key message:** *"ADRP is the missing piece for seamless port-aware
browsing — no user action, no developer action, no breaking changes."*

---

## 3. Community Building

### 3.1 GitHub Discussion Forum

Create a dedicated GitHub Discussions space for KirinDNS:

**Repository:** `github.com/kirindns/protocol` (or similar)

**Discussion categories:**
- **💡 Ideas** — Propose new features, protocol extensions, or use cases.
- **🛠️ Development** — Discuss library implementations, bugs, and
  improvements.
- **📢 Announcements** — Release notes, IETF milestones, partnership news.
- **❓ Q&A** — General questions about ADRP.
- **📖 Show and Tell** — Share projects built on ADRP.

**Pinned discussions:**
1. "What is KirinDNS?" — A beginner-friendly explanation.
2. "ADRP IETF Submission Timeline" — Live tracking of the standardization
   process.
3. "Contributor Guide" — How to contribute to the protocol, libraries, or
   extensions.

### 3.2 KirinDNS Hackathon

Host a virtual hackathon to drive developer adoption:

**Format:** 48-hour virtual hackathon (similar to ETHGlobal, Hackathon
platforms).

**Categories:**
- **Best ADRP Integration** — Best use of the ADRP protocol in an
  application.
- **Best Developer Tool** — Best tool or library built around ADRP.
- **Best Web3 ADRP App** — Best Web3 application using ADRP for port
  discovery.
- **Best Security Use Case** — Best use of ADRP for security or privacy.

**Prizes:**
- 1st place: $5,000 + feature in KirinDNS documentation
- 2nd place: $2,500
- 3rd place: $1,000
- People's Choice: $500 (voted by the community)

**Timeline:**
- Announce hackathon 6 weeks in advance
- Provide starter kits (library SDKs, example projects)
- Host a kickoff webinar explaining ADRP
- Judge submissions in a live judging session
- Publish winning projects in the KirinDNS showcase

**Partners:**
- Web3 hosting providers (IPFS, Arweave, Filecoin)
- DNS providers (Cloudflare, AWS Route53)
- Developer tools (Vercel, Netlify)

### 3.3 Ongoing Community Engagement

- **Monthly ADRP SIG (Special Interest Group) call** — Open to anyone
  interested in ADRP. Discuss progress, answer questions, plan next steps.
- **Advisory board** — Recruit 5-10 industry experts (from DNSOP, Web3,
  security) to provide guidance on the standardization process.
- **Contributor program** — Formal program for developers who contribute to
  ADRP libraries, extensions, or documentation. Contributors receive
  recognition on the ADRP website and in RFC acknowledgments.

---

## 4. Summary Timeline

| Milestone | Target Date | Status |
|-----------|-------------|--------|
| Internet-Draft submitted to IETF | Month 1 | Planned |
| DNSOP Working Group adoption | Month 2-3 | Planned |
| WG Last Call | Month 4-5 | Planned |
| IESG review | Month 6 | Planned |
| RFC publication | Month 8-12 | Planned |
| First browser vendor flag support | Month 12-18 | Planned |
| Native browser support | Month 18-24 | Planned |

The goal is to have ADRP published as an RFC within 12 months and to have
at least one major browser vendor supporting ADRP via a flag within 18 months.

---

## 5. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| DNSOP rejects the draft | Medium | High | Have HTTPBIS as a backup WG. Be prepared to address concerns quickly. |
| Security community raises major concerns | Medium | High | Proactively engage with the SECDIR (IETF security directorate) before WG Last Call. |
| No browser vendor interest | Low | High | Build a large user base via the extension first; demonstrate demand. |
| Competing standard emerges | Low | Medium | Move quickly through the IETF process. File the Internet-Draft early. |
| IETF process stalls | Low | Medium | Maintain community momentum via hackathons and SIG calls regardless of IETF progress. |
