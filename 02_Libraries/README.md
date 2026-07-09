# KirinDNS Client Libraries

Multi-language implementations of the KirinDNS Resolution Protocol (ADRP).
15 languages, all exposing the same core API.

## API

| #  | Language   | Function / Method                  | Returns                              |
|----|------------|------------------------------------|--------------------------------------|
|  1 | JavaScript | `resolve_kirin_dns(domain)`        | `Promise<{http,https,ws,wss}>`       |
|  2 | TypeScript | (type defs for JS)                 | `ResolvedPorts`                      |
|  3 | Python     | `resolve_kirin_dns(domain)`        | `dict[str,int]`                      |
|  4 | Rust       | `ResolvedPorts::resolve(domain)`   | `Result<ResolvedPorts>`              |
|  5 | Go         | `kirindns.Resolve(domain)`         | `(ResolvedPorts, error)`             |
|  6 | C          | `kirin_resolve(domain, &ports)`    | `int` (0=ok, <0=error)              |
|  7 | Java       | `KirinDns.resolve(domain)`         | `KirinDns.Ports`                     |
|  8 | C#         | `await KirinDns.ResolveAsync(d)`   | `Task<KirinPorts>`                  |
|  9 | Ruby       | `KirinDNS.resolve(domain)`         | `Hash`                               |
| 10 | Swift      | `try await KirinDNS.resolve(d)`    | `KirinPorts`                         |
| 11 | C++        | `kirin::resolve(domain)`           | `kirin::Ports`                       |
| 12 | PHP        | `KirinDNS\resolve($domain)`        | `array{http,https,ws,wss}`          |
| 13 | Kotlin     | `KirinDns.resolve(domain)`         | `KirinPorts`                         |
| 14 | Dart       | `await KirinDns.resolve(domain)`   | `Future<KirinPorts>`                |
| 15 | Lua        | `kirin_dns.resolve(domain)`        | `table`                              |

## Directory

```
02_Libraries/
├── c/            kirin_dns.h + kirin_dns.c       (libresolv, C99)
├── cpp/          kirin_dns.hpp                   (C++17, header-only, libresolv)
├── csharp/       KirinDns.cs                     (.NET 6+, System.Text.Json)
├── dart/         kirin_dns.dart                  (Dart 3.0+, dart:io UDP)
├── go/           kirin_dns.go + test             (Go 1.21+, stdlib only)
├── java/         KirinDns.java                   (JDK 11+, JNDI DNS)
├── javascript/   kirin_dns.js + .d.ts + tests    (Node.js >=18)
├── kotlin/       KirinDns.kt                     (Kotlin/JVM, javax.naming)
├── lua/          kirin_dns.lua                   (Lua 5.1+, luasocket)
├── php/          kirin_dns.php                   (PHP 8.0+, sockets + json)
├── python/       kirin_dns.py + tests            (dnspython)
├── ruby/         kirin_dns.rb                    (stdlib: resolv, json)
├── rust/         Cargo.toml + src/lib.rs         (trust-dns-resolver, tokio)
├── swift/        KirinDNS.swift                  (Foundation, dig fallback)
└── README.md
```

## Protocol (spec)

See `01_Standard/spec_v1.md`:

1. DNS TXT query for `domain`
2. Parse each TXT record as JSON
3. First valid record with >=1 recognized key wins
4. Keys: `http`, `https`, `ws`, `wss` — integer ports [1, 65535]
5. Fallback: http=80, https=443, ws=80, wss=443

## Quick Start

**JavaScript:**
```js
const { resolve_kirin_dns } = require('./kirin_dns');
const ports = await resolve_kirin_dns('alice.kirinnet.org');
```

**Python:**
```python
from kirin_dns import resolve_kirin_dns
ports = resolve_kirin_dns('alice.kirinnet.org')
```

**Go:**
```go
ports, _ := kirindns.Resolve("alice.kirinnet.org")
```

**C:**
```c
KirinPorts ports;
kirin_resolve("alice.kirinnet.org", &ports);
printf("HTTP: %u\n", ports.http);
```

**C++:**
```cpp
kirin::Ports ports = kirin::resolve("alice.kirinnet.org");
std::cout << "HTTP: " << ports.http << std::endl;
```

**Java:**
```java
KirinDns.Ports ports = KirinDns.resolve("alice.kirinnet.org");
```

**C#:**
```csharp
var ports = await KirinDns.ResolveAsync("alice.kirinnet.org");
```

**Ruby:**
```ruby
ports = KirinDNS.resolve('alice.kirinnet.org')
```

**Rust:**
```rust
let ports = ResolvedPorts::resolve("alice.kirinnet.org").await?;
```

**Swift:**
```swift
let ports = try await KirinDNS.resolve("alice.kirinnet.org")
```

**PHP:**
```php
$ports = KirinDNS\resolve('alice.kirinnet.org');
echo "HTTP: {$ports['http']}";
```

**Kotlin:**
```kotlin
val ports = KirinDns.resolve("alice.kirinnet.org")
println("HTTP: ${ports.http}")
```

**Dart:**
```dart
final ports = await KirinDns.resolve('alice.kirinnet.org');
print('HTTP: ${ports.http}');
```

**Lua:**
```lua
local kirin = require("kirin_dns")
local ports = kirin.resolve("alice.kirinnet.org")
print("HTTP: " .. ports.http)
```

## Tested

| Language      | Status                   |
|--------------|--------------------------|
| JavaScript   | PASSED (self-test)       |
| Python       | PASSED (unittest)        |
| C            | PASSED (gcc, self-test)  |
| C++          | PASSED (g++17, self-test)|
| PHP          | syntax valid             |
| Kotlin       | syntax valid             |
| Dart         | syntax valid             |
| Lua          | syntax valid             |
| Java         | syntax valid             |
| C#           | syntax valid             |
| Ruby         | syntax valid             |
| Go           | syntax valid             |
| Rust         | syntax valid             |
| Swift        | syntax valid             |
| TypeScript   | type defs (no runtime)   |
