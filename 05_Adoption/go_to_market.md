# KirinDNS — Go-To-Market Strategy

This document outlines the marketing and adoption strategy for KirinDNS,
from initial launch to mainstream adoption across the Internet.

---

## 1. Target Audience

### 1.1 Web3 Developers (Primary)

**Who they are:** Developers building decentralized applications (dApps),
IPFS gateways, Arweave clients, blockchain node frontends, and Web3
infrastructure.

**Why they need KirinDNS:**
- Many Web3 services run on non-standard ports to avoid ISP throttling,
  to share IP addresses with other services, or because they are deployed
  behind reverse proxies.
- Users of dApps should not need to remember port numbers. ADRP makes
  `https://gateway.ipfs.example.com` work the same as
  `https://gateway.ipfs.example.com:8080`.
- Local development servers (typically on :3000 or :8080) can be
  discovered via ADRP, making local dApp development seamless.

**Where to find them:**
- Ethereum and Solana developer forums
- IPFS and Arweave community channels
- Web3 hackathons (ETHGlobal, Solana Hackathon)
- Dev.to, Hacker News, Reddit r/ethdev, r/web3

### 1.2 Enterprise IT (Secondary)

**Who they are:** IT departments at large organizations that manage internal
services, microservices architectures, and multi-tenant environments.

**Why they need KirinDNS:**
- Enterprise services often run on non-standard ports (e.g., port 8080,
  8443, 9090) for security, load balancing, or multi-tenant isolation.
- ADRP allows internal services to be discoverable via standard URLs,
  reducing configuration complexity and training overhead.
- ADRP is DNS-based, so it integrates with existing enterprise DNS
  infrastructure (Active Directory DNS, BIND, AWS Route53).

**Where to find them:**
- IT conferences (RSA Conference, Gartner IT Symposium)
- Enterprise tech blogs
- LinkedIn groups for IT professionals
- Partner with enterprise DNS providers (Cloudflare for Business, AWS)

### 1.3 Privacy Advocates (Tertiary)

**Who they are:** Users who prioritize privacy, use DoH/DoT resolvers,
and are concerned about ISP tracking.

**Why they need KirinDNS:**
- ADRP requires DoH/DoT for DNS queries, aligning with privacy-first
  principles.
- ADRP can be used to route traffic through custom resolver chains on
  non-standard ports, providing an additional layer of privacy.
- ADRP does not require any changes to existing privacy tools (Tor,
  Brave, private DNS resolvers).

**Where to find them:**
- Privacy-focused forums (PrivacyGuides, EFF community)
- Tor Project community
- Brave browser community
- Signal and Telegram privacy groups

---

## 2. Key Messaging

### Primary Tagline

**"The Internet is more than just port 80 and 443."**

This message captures the core value proposition: the current model of
assuming all web traffic goes to ports 80/443 is limiting, and ADRP
unlocks the full range of the port space for seamless web access.

### Secondary Messages

| Audience | Message |
|----------|---------|
| Web3 developers | "Decentralized DNS that respects user sovereignty." |
| Enterprise IT | "No code changes required for your existing DNS infrastructure." |
| Privacy advocates | "Port discovery that doesn't compromise your privacy." |
| Browser vendors | "Better UX for users — no more 'wrong port' errors." |
| General audience | "Type a URL, get connected — no port numbers needed." |

### Messaging Principles

1. **Avoid FUD:** Do not frame ADRP as a solution to a problem that
   doesn't exist for most users. Instead, frame it as an improvement for
   users who *do* encounter port-related issues.

2. **Emphasize backward compatibility:** ADRP is purely additive. Domains
   without ADRP TXT records work exactly as before. This is a key selling
   point for enterprises and browser vendors.

3. **Be technical when appropriate:** When speaking to developers and IT
   professionals, use technical language (DNS TXT records, DoH, IETF RFC).
   When speaking to end users, use plain language ("no more port numbers").

---

## 3. Launch Plan

### Phase 1 — Launch (Months 1-3)

**Goal:** Establish ADRP as a working protocol with community visibility.

**Actions:**

1. **Publish the Chrome Extension**
   - Submit the KirinDNS extension to the Chrome Web Store.
   - Target: 1,000 installs in the first month.
   - Promotion: Post to Chrome Web Store featured apps, Hacker News,
     Reddit r/chromeextensions.

2. **Publish Libraries on Package Registries**
   - **Python:** Publish `kirin-dns` on PyPI.
   - **JavaScript:** Publish `kirin-dns` on npm.
   - **Go:** Publish `github.com/kirin-yucall/kirin-dns-go`.
   - **Rust:** Publish `kirin-dns` on crates.io.

3. **Submit the Internet-Draft to IETF**
   - Submit `spec_v1.md` as an Internet-Draft.
   - Announce on the IETF DNSOP mailing list.
   - Link from the ADRP website and GitHub repository.

4. **Launch the ADRP Website**
   - Domain: `kirindns.org` (or similar).
   - Content: Protocol overview, documentation, library links, extension
     link, GitHub link, IETF draft link.
   - Design: Clean, professional, similar to other protocol projects
     (e.g., https://dns-over-https.com).

5. **Press and Community Outreach**
   - Hacker News post: "Introducing KirinDNS: Port-Aware DNS Resolution."
   - Dev.to article: "How KirinDNS Makes Non-Standard Ports Transparent."
   - Reddit r/sysadmin: "A DNS-based solution for port discovery."
   - LinkedIn post targeting IT professionals.

**Success metrics for Phase 1:**
- 500+ Chrome extension installs
- 100+ GitHub stars
- 1,000+ library downloads (npm + PyPI combined)
- Internet-Draft submitted and visible on datatracker

### Phase 2 — Education (Months 4-9)

**Goal:** Build developer understanding and adoption.

**Actions:**

1. **Blog Series: "Why ADRP?"**
   - Post 1: "Why the Internet Needs Port-Aware DNS" — The problem ADRP
     solves, with real-world examples.
   - Post 2: "How ADRP Works Under the Hood" — Technical deep-dive into
     the protocol, with diagrams.
   - Post 3: "ADRP and Web3: A Natural Fit" — How ADRP enables seamless
     Web3 development.
   - Post 4: "ADRP for Enterprise: Better Internal Routing" — Enterprise
     use cases.

2. **YouTube Tutorials**
   - Video 1: "Setting Up KirinDNS in 5 Minutes" — Install the extension,
     configure a test domain, demonstrate port discovery.
   - Video 2: "Building a Web3 dApp with KirinDNS" — Full tutorial on
     building a dApp that uses ADRP for port discovery.
   - Video 3: "ADRP for Enterprise IT" — Demonstrating ADRP with
     enterprise DNS infrastructure.

3. **Conference Talks**
   - Submit talks to IETF meetings (DNSOP session).
   - Submit talks to Web3 conferences (EthDenver, Solana Breakpoint).
   - Submit talks to IT conferences (RSA, Gartner).

4. **Developer SDK and Documentation**
   - Create a comprehensive developer portal at `docs.kirindns.org`.
   - Include API reference for all libraries.
   - Include integration guides (e.g., "Integrating ADRP with Nginx",
     "Using ADRP with Express.js").

**Success metrics for Phase 2:**
- 10,000+ Chrome extension installs
- 500+ GitHub stars
- 50,000+ library downloads
- 1,000+ YouTube views per video
- At least 1 conference acceptance

### Phase 3 — Partnerships (Months 10-18)

**Goal:** Secure partnerships with major platforms and providers.

**Actions:**

1. **Web3 Hosting Providers**
   - Partner with IPFS gateway providers to adopt ADRP by default.
   - Partner with Arweave clients to use ADRP for port discovery.
   - Partner with Filecoin storage providers to advertise service ports
     via ADRP.

2. **DNS Providers**
   - Work with Cloudflare to add ADRP TXT record management to their
     dashboard.
   - Work with AWS Route53 to support ADRP records.
   - Work with Google Cloud DNS to add ADRP support.

3. **Browser Vendors**
   - Present ADRP to Chrome, Firefox, and Safari teams.
   - Offer the KirinDNS extension as a reference implementation.
   - Propose ADRP as a candidate for browser-level integration.

4. **Hosting Platforms**
   - Partner with Vercel, Netlify, and Railway to offer ADRP as a
     feature for services running on non-standard ports.
   - Partner with Docker Hub to enable ADRP for containerized services.

**Success metrics for Phase 3:**
- 50,000+ Chrome extension installs
- 1,000+ GitHub stars
- 200,000+ library downloads
- At least 3 partnership announcements
- At least 1 DNS provider integrating ADRP support

### Phase 4 — Mainstream (Months 18-36)

**Goal:** Achieve mainstream adoption and RFC publication.

**Actions:**

1. **RFC Publication**
   - Guide the Internet-Draft through the IETF process.
   - Address all community concerns.
   - Publish as an RFC.

2. **Browser Integration**
   - Work with browser vendors to integrate ADRP into their networking
     stacks.
   - Start with a flag-based approach, then move to native support.

3. **Enterprise Adoption**
   - Publish case studies from enterprises using ADRP.
   - Offer enterprise support and consulting.
   - Present ADRP at enterprise IT conferences.

4. **Developer Ecosystem**
   - Host the KirinDNS Hackathon.
   - Build a showcase of projects built on ADRP.
   - Create a contributor program.

**Success metrics for Phase 4:**
- RFC published
- 100,000+ Chrome extension installs
- 5,000+ GitHub stars
- 1,000,000+ library downloads
- At least 1 browser vendor with flag-based ADRP support

---

## 4. Budget Considerations

| Item | Estimated Cost |
|------|----------------|
| Domain and hosting (1 year) | $500 |
| Chrome Web Store developer fee | $5 (one-time) |
| Hackathon prizes | $9,000 |
| Conference travel (2 conferences) | $3,000 |
| YouTube production (3 videos) | $2,000 |
| Website design and development | $5,000 |
| **Total** | **$19,005** |

Most of these costs can be reduced through volunteer contributions and
in-kind support from partners.

---

## 5. Competitive Landscape

| Competitor | Description | ADRP Advantage |
|------------|-------------|----------------|
| **Standard HTTP port** | The default (80/443) | ADRP enables non-standard ports without user action |
| **SRV records (RFC 2782)** | DNS SRV records for service discovery | ADRP is simpler (JSON in TXT vs. complex SRV format), more browser-friendly |
| **Well-known URIs (RFC 5785)** | .well-known paths for service discovery | ADRP works at the DNS layer, not the HTTP layer — no HTTP request needed |
| **Link headers** | HTTP Link headers for service discovery | ADRP works before the HTTP connection is established |
| **Custom DNS record types** | Proprietary DNS record types | ADRP uses standard TXT records — no resolver changes needed |

ADRP's key differentiator is that it is **DNS-layer, JSON-based, and
purely additive** — no changes to existing infrastructure, no new DNS
record types, no breaking changes.

---

## 6. Success Metrics Summary

| Metric | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|--------|---------|---------|---------|---------|
| Chrome extension installs | 500+ | 10,000+ | 50,000+ | 100,000+ |
| GitHub stars | 100+ | 500+ | 1,000+ | 5,000+ |
| Library downloads | 1,000+ | 50,000+ | 200,000+ | 1,000,000+ |
| IETF status | Internet-Draft | WG adopted | WG Last Call | RFC published |
| Partnerships | 0 | 1-2 | 3+ | 5+ |
| Browser support | Extension only | Extension only | Flag-based | Native |
