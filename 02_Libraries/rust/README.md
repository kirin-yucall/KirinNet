# kirin-dns-rs

KirinDNS (ADRP) Rust client library — lightweight DNS-based port discovery.

```rust
use kirin_dns::KirinDns;

let ports = KirinDns::resolve("example.com").await?;
// ports.http(), ports.https(), ports.ws(), ports.wss()
```

[Full KirinNet Project](https://github.com/kirin-yucall/KirinNet)
