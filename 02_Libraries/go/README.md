# kirin-dns-go

KirinDNS (ADRP) Go client library — lightweight DNS-based port discovery.

```go
import "github.com/kirin-yucall/kirin-dns-go"

ports, err := kirindns.Resolve("example.com")
// ports.HTTP, ports.HTTPS, ports.WS, ports.WSS
```

[Full KirinNet Project](https://github.com/kirin-yucall/KirinNet)
