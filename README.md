# KirinNet
KirinNet：专为 Web3 打造的下一代网络解析协议。基于 SRV 记录智能寻址 + TXT 身份验证，无缝兼容传统网络。在 KirinNet 中，域名即身份，无需密码与繁琐注册。构建完全去中心化的内容与通信生态，数据绝对主权，资料随节点完美迁移，彻底告别封号与审查。开源解析库，诚邀浏览器原生接入。

# KirinDNS — Port-Aware DNS Resolution for the Modern Web

**The Internet is more than just port 80 and 443.**

KirinDNS (ADRP) is a lightweight DNS-based protocol that lets clients discover
the actual listening ports of HTTP/HTTPS/WebSocket services through standard
DNS SRV records, and user identity via DNS TXT records. It enables seamless
access to services running on non-standard ports without requiring users to
type port numbers in URLs.

```
https://dapp.example.com  ->  automatically resolves to port 8443 via ADRP
```

No code changes. No new DNS record types. No breaking changes.

---

## Why KirinDNS?

### The Problem

Many services run on non-standard ports:
- Web3 dApp development servers on port 3000
- IPFS gateways on port 8080
- Corporate internal services on port 8443
- Multi-tenant platforms sharing a single IP across different ports

Today, users must know the port number and type it manually:
`https://gateway.ipfs.example.com:8080` — a poor user experience.

### The Solution

ADRP encodes port information in SRV records and identity in TXT records:

```
; SRV records for service discovery
_kirinnet-http._tcp.example.com.  IN  SRV  0 0 8080 example.com.
_kirinnet-https._tcp.example.com. IN  SRV  0 0 8443 example.com.

; TXT record for identity
id=550e8400-e29b-41d4-a716-446655440000;key=04abc...;nick=Alice
```

An ADRP-aware client queries these records before connecting, discovers the
correct port via SRV and identity via TXT, then connects transparently.

### Key Properties

- **Zero infrastructure changes** — uses standard DNS SRV and TXT records
- **Backward compatible** — domains without KirinDNS SRV records fall back to standard ports
- **Typed service discovery** — SRV records natively express priority/weight/port
- **Identity built-in** — TXT records carry user identity (UUID, public key, nickname)
- **Encrypted DNS** — all ADRP queries use DoH/DoT
- **No new DNS record types** — no resolver changes needed

---

## Quick Start

### Python

```bash
pip install kirin-dns dnspython
```

```python
from kirin_dns import resolve_kirin_dns

ports = resolve_kirin_dns("example.com")
# Returns: {"http": 8080, "https": 8443}
# Falls back to: {"http": 80, "https": 443} if no ADRP record
```

### JavaScript / Node.js

```bash
npm install kirin-dns
```

```javascript
const { resolve_kirin_dns } = require('kirin-dns');

const ports = await resolve_kirin_dns('example.com');
// Returns: { http: 8080, https: 8443 }
// Falls back to: { http: 80, https: 443 } if no ADRP record
```

### Go

```bash
go get github.com/kirin-yucall/kirin-dns-go
```

```go
import "github.com/kirin-yucall/kirin-dns-go"

ports, err := kirindns.Resolve("example.com")
// Returns: ResolvedPorts{HTTP: 8080, HTTPS: 8443, WS: 80, WSS: 443}
```

### Rust

```bash
cargo add kirin-dns
```

```rust
use kirin_dns::KirinDns;

let ports = KirinDns::resolve("example.com").await?;
// ports.http() == 8080, ports.https() == 8443
```

### Browser Extension

The KirinDNS Chrome Extension automatically redirects HTTP/HTTPS requests to
ADRP-discovered ports. Install from the [Chrome Web Store](#) or load the
unpacked extension from `03_Browser_Extension/`.

---

## Project Structure

```
KirinDNS_Project/
├── 01_Standard/           # Protocol specification
│   ├── spec_v1.md         # ADRP specification (RFC-style)
│   └── compatibility.md   # Compatibility notes
├── 02_Libraries/          # Client library implementations
│   ├── python/            # Python library (dnspython)
│   ├── javascript/        # Node.js library
│   ├── go/                # Go library
│   └── rust/              # Rust library
├── 03_Browser_Extension/  # Chrome Extension (Manifest V3)
├── 04_Chromium_Browser/   # Custom Chromium build instructions
├── 05_Adoption/           # IETF roadmap, GTM strategy, demo sites
├── 07_User_Node/          # Self-hosted User Node Docker service
│   ├── spec.md            # User Node specification
│   ├── Dockerfile         # Docker image definition
│   ├── docker-compose.yml # Docker Compose configuration
│   ├── package.json       # Node.js dependencies
│   └── src/               # User Node source code
│       └── server.js      # Express API server
└── 08_KirinNet/            # Federated social platform
    ├── architecture.md    # System architecture
    ├── api_contract.md    # RESTful API specification
    ├── backend/           # Aggregator backend code
    ├── frontend/          # Web application frontend
    └── utils/             # Utility functions
```

---

## Protocol Specification

The full ADRP specification is available at [`01_Standard/spec_v1.md`](01_Standard/spec_v1.md).

Key points:
- SRV record format: `_kirinnet-{http|https|ws}._tcp.<domain> IN SRV 0 0 <port> <target>.`
- TXT record format: `id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>`
- Fallback to standard ports (80/443) if SRV is missing or invalid
- Identity is optional — domains without identity TXT work as anonymous services
- All queries MUST use DNS-over-TLS (DoT) or DNS-over-HTTPS (DoH)

---

## IETF Standardization Status

ADRP is being advanced through the IETF process:

1. **Internet-Draft** — submitted to the IETF datatracker
2. **Working Group** — targeting DNSOP (DNS Operations)
3. **WG Last Call** — pending WG adoption
4. **RFC Publication** — target: within 12 months

See the [IETF Standardization Roadmap](05_Adoption/rfc_draft.md) for details.

---

## Contributing

We welcome contributions! Here's how to get started:

### Reporting Issues

Found a bug? Open an issue on GitHub with:
- A clear description of the problem
- Steps to reproduce
- Expected vs. actual behavior

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Write tests for your changes
4. Ensure all tests pass (`pytest` for Python, `jest` for JavaScript)
5. Submit a pull request

### Code Style

- **Python**: Follow PEP 8, max line length 120
- **JavaScript**: ES2022+, no semicolons (optional), 2-space indent
- **Go**: Standard `gofmt` formatting
- **Rust**: `rustfmt` formatting

### Adding a New Library Implementation

If you want to add ADRP support for a new language:

1. Create a new directory under `02_Libraries/<language>/`
2. Implement the core function: `resolve_kirin_dns(domain) -> {ports}`
3. Add tests that match the cross-language test matrix in
   `02_Libraries/python/tests/test_kirin_dns.py` (the `TestCrossLanguageConsistency` class)
4. Add the language to the CI workflow in `.github/workflows/ci.yml`
5. Submit a PR

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Links

- **Protocol Spec**: [`01_Standard/spec_v1.md`](01_Standard/spec_v1.md)
- **IETF Roadmap**: [`05_Adoption/rfc_draft.md`](05_Adoption/rfc_draft.md)
- **GTM Strategy**: [`05_Adoption/go_to_market.md`](05_Adoption/go_to_market.md)
- **Demo Sites**: [`05_Adoption/demo_sites.md`](05_Adoption/demo_sites.md)
- **Chrome Extension**: [`03_Browser_Extension/`](03_Browser_Extension/)
- **User Node**: [`07_User_Node/spec.md`](07_User_Node/spec.md)
- **KirinNet Platform**: [`08_KirinNet/architecture.md`](08_KirinNet/architecture.md)
- **Chromium Build**: [`04_Chromium_Browser/build_instructions.md`](04_Chromium_Browser/build_instructions.md)
- **IETF Datatracker**: [draft-kirindns-adrp](https://datatracker.ietf.org/doc/draft-kirindns-adrp/) (coming soon)

---

**The Internet is more than just port 80 and 443.**

---

> **KirinDNS** — Port-Aware DNS Resolution for the Modern Web
> [![CI](https://github.com/kirin-yucall/KirinNet/actions/workflows/ci.yml/badge.svg)](https://github.com/kirin-yucall/KirinNet/actions/workflows/ci.yml)
> [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
> [![Python](https://img.shields.io/badge/Python-3.9+-blue.svg)](02_Libraries/python/)
> [![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](02_Libraries/javascript/)
> [![Go](https://img.shields.io/badge/Go-1.21+-00ADD8.svg)](02_Libraries/go/)
> [![Rust](https://img.shields.io/badge/Rust-stable-orange.svg)](02_Libraries/rust/)
