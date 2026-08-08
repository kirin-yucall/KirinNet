# KirinDNS Client Libraries

Multi-language client implementations of the **KirinDNS Resolution Protocol
(ADRP) v2.0** — 15 languages exposing one consistent resolution model.

- **协议权威**：`../01_Standard/spec_v1.md`（§2.2 SRV 名、§3 解析流程、§4 安全、§2.5 回退端口）、`../01_Standard/did-dns-protocol.md`（身份 TXT 字段）。
- **架构红线**：统一 Ed25519；端点/品牌 `kirin` 零 `aura`；跨语言一致性；安全 fail-closed。

---

## 协议模型（ADRP v2.0 = SRV + TXT 双层）

ADRP v2.0 用**两层 DNS 记录**完成「服务端口发现 + 身份元数据」：

| 层 | 记录类型 | 用途 | 关键约束 |
|---|---|---|---|
| **SRV 层** | `SRV`（RFC 2782） | 每个服务协议一条 SRV，告示 `target:port` | 服务名见下表；按 priority↑、weight↓ 选最优 |
| **TXT 层** | `TXT` | 身份元数据（`id`/`key`/`nick`/`ipfs`） | 分号分隔 `key=value`；以 `id=` 起首且含 `key=` 为身份记录；忽略 SPF/DKIM/DMARC |

**SRV 服务名**（spec §2.2，三个，`_tcp` 协议下）：

| 服务 | SRV 名 |
|---|---|
| HTTP | `_kirinnet-http._tcp` |
| HTTPS | `_kirinnet-https._tcp` |
| WebSocket | `_kirinnet-ws._tcp` |

**回退端口**（spec §2.5 / §3.3.1 Step 4，SRV 缺失时）：HTTP=80、HTTPS=443、WebSocket=80、WSS=443。

**身份 TXT 格式**（spec §3.2）：`id=<uuid>;key=<hex_pubkey>;nick=<name>[;ipfs=<bool>]`，`id`/`key` 必填，`nick`/`ipfs` 可选，未知键忽略。

**安全 fail-closed**：SRV 查询 NXDOMAIN / 空答案 → 回退标准端口（不抛错，调用方正常连接）；未知 service → 抛错（不静默）；身份 TXT 缺 `id` 或 `key` → 返回 null。强制 DoT/DoH、禁明文 53。

---

## 跨语言 API（v2 主 API + v1 legacy 包装）

每门语言暴露**同一组 v2 函数**（命名随语言惯例）：

1. `resolveService(domain, service)` → `{target, port} | null` — 解析单个服务的 SRV（`service` ∈ `http|https|ws`）。
2. `resolveIdentity(domain)` → `{id, key, nick?, ipfs?} | null` — 解析身份 TXT。
3. `resolveAllServices(domain)` → `{http, https, ws}` 三个 SRV 结果（缺失为 null）。
4. `resolve_kirin_dns(domain)` / 等价 legacy 包装 → v2 全量结果（`{domain, ws, http, https, identity}`，`ws` 缺失时回退）。

> **v1 兼容层**：12 门已迁移语言同时保留 v1「TXT-JSON 端口」入口（`Resolve`/`resolve`/`resolve_kirin_dns` 等，返回 `{http,https,ws,wss}` 端口映射），仅为向后兼容；新代码请用 v2 主 API。

### 15 语言导出符号逐行对照

| # | 语言 | v2 服务解析（SRV） | v2 身份解析（TXT） | v1 legacy 入口（端口 dict） | 运行时 / 依赖 |
|---|---|---|---|---|---|
| 1 | JavaScript | `resolveService(domain, service)` | `resolveIdentity(domain)` | `resolve_kirin_dns(domain)` | Node.js ≥18，`dns` |
| 2 | TypeScript | （JS 的类型定义，见 `javascript/kirin_dns.d.ts`） | — | — | `tsc --noEmit` |
| 3 | Python | `resolve_service(domain, service)` → `SRVResult \| None` | `resolve_identity(domain)` → `dict \| None` | `resolve_kirin_dns(domain)` | `dnspython` |
| 4 | Rust | `ResolvedPorts::resolve_service(domain, service)` → `Option<SRVResult>` | `ResolvedPorts::resolve_identity(domain)` → `Option<Identity>` | `ResolvedPorts::resolve(domain)` → `Result<ResolvedPorts>` | `trust-dns-resolver` + `tokio` |
| 5 | Go | `kirindns.ResolveService(domain, service)` → `(*SRVResult, error)` | `kirindns.ResolveIdentity(domain)` → `(*Identity, error)` | `kirindns.Resolve(domain)` → `(ResolvedPorts, error)` | Go 1.21+，stdlib |
| 6 | C | `kirin_resolve_service(domain, service, &srv)` → `int` | `kirin_resolve_identity(domain, &id)` → `int` | `kirin_resolve(domain, &ports)` → `int` | C99，`libresolv` |
| 7 | C++ | `kirin::resolveService(domain, service)` → `optional<SrvResult>` | `kirin::resolveIdentity(domain)` → `optional<Identity>` | `kirin::resolve_kirin_dns(domain)` → `KirinDnsResult` | C++17 header-only，`libresolv` |
| 8 | C# | —（**波 1 待迁移**） | —（**波 1 待迁移**） | `await KirinDns.ResolveAsync(domain)` → `Task<KirinPorts>` | .NET 6+ |
| 9 | Java | —（**波 1 待迁移**） | —（**波 1 待迁移**） | `KirinDns.resolve(domain)` → `KirinDns.Ports` | JDK 11+，JNDI DNS |
| 10 | Kotlin | —（**波 1 待迁移**） | —（**波 1 待迁移**） | `KirinDns.resolve(domain)` → `KirinPorts` | Kotlin/JVM，`javax.naming` |
| 11 | Ruby | `KirinDNS.resolve_service(domain, service)` → `Hash \| nil` | `KirinDNS.resolve_identity(domain)` → `Hash \| nil` | `KirinDNS.resolve_kirin_dns(domain)` → `Hash` | Ruby stdlib（`resolv`/`json`） |
| 12 | Swift | `try await KirinDNS.resolveService(domain, service)` → `SrvResult?` | `try await KirinDNS.resolveIdentity(domain)` → `KirinIdentity?` | （v2 wrapper 内置） | Foundation + `dig` |
| 13 | PHP | `KirinDNS\resolveService($domain, $service)` → `?array` | `KirinDNS\resolveIdentity($domain)` → `?array` | （v2 wrapper 内置） | PHP 8.0+，`dns_get_record` |
| 14 | Dart | `await KirinDns.resolveService(domain, service)` → `SrvResult?` | `await KirinDns.resolveIdentity(domain)` → `Map?` | （v2 wrapper 内置） | Dart 3.0+，`dart:io` UDP |
| 15 | Lua | `kirin.resolveService(domain, service)` → `table?` | `kirin.resolveIdentity(domain)` → `table?` | （v2 wrapper 内置） | Lua 5.1+，`luasocket` |

> C# / Java / Kotlin 当前仍是 v1 TXT-JSON 模型（`resolve(domain)→{http,https,ws,wss}`），波 1 D07 将重写为 v2（SRV+TXT+身份）。

---

## 目录结构

```
02_Libraries/
├── c/            kirin_dns.h + kirin_dns.c        (C99, libresolv)
├── cpp/          kirin_dns.hpp                    (C++17, header-only, libresolv)
├── csharp/       KirinDns.cs                      (.NET 6+, v1 待波1重写)
├── dart/         kirin_dns.dart                   (Dart 3.0+, dart:io UDP)
├── go/           kirin_dns.go + kirin_dns_test.go (Go 1.21+, stdlib)
├── java/         KirinDns.java                    (JDK 11+, JNDI, v1 待波1重写)
├── javascript/   kirin_dns.js + kirin_dns.d.ts    (Node.js ≥18)
├── kotlin/       KirinDns.kt                      (Kotlin/JVM, javax.naming, v1 待波1重写)
├── lua/          kirin_dns.lua                    (Lua 5.1+, luasocket)
├── php/          kirin_dns.php                    (PHP 8.0+, dns_get_record)
├── python/       kirin_dns.py + tests/            (dnspython, pytest)
├── ruby/         kirin_dns.rb                     (stdlib: resolv, json)
├── rust/         Cargo.toml + src/lib.rs          (trust-dns-resolver, tokio)
├── swift/        KirinDNS.swift                   (Foundation, dig fallback)
└── README.md     (本文件)
```

---

## Quick Start（v2 主 API）

**JavaScript / TypeScript（Node.js）：**
```js
const { resolveService, resolveIdentity } = require('./javascript/kirin_dns');

const ws = await resolveService('alice.kirinnet.org', 'ws');
// => { target: 'alice.kirinnet.org', port: 8082 }  或 null（回退到 80）

const id = await resolveIdentity('alice.kirinnet.org');
// => { id: '550e8400-...', key: '04abc...', nick: 'Alice' }  或 null
```

**Python：**
```python
from kirin_dns import resolve_service, resolve_identity

srv = resolve_service('alice.kirinnet.org', 'ws')   # SRVResult(target=..., port=...) 或 None
identity = resolve_identity('alice.kirinnet.org')    # {'id':..., 'key':..., 'nick':...} 或 None
```

**Go：**
```go
import "kirindns"

srv, err := kirindns.ResolveService("alice.kirinnet.org", "ws")  // *SRVResult, error（无记录时 srv==nil）
id, err  := kirindns.ResolveIdentity("alice.kirinnet.org")       // *Identity, error（无身份时 id==nil）
```

**Rust：**
```rust
use kirin_dns::ResolvedPorts;

let srv = ResolvedPorts::resolve_service("alice.kirinnet.org", "ws").await;  // Option<SRVResult>
let id  = ResolvedPorts::resolve_identity("alice.kirinnet.org").await;       // Option<Identity>
```

**C：**
```c
#include "kirin_dns.h"

KirinSRVResult srv;
if (kirin_resolve_service("alice.kirinnet.org", "ws", &srv) == KIRIN_OK) {
    printf("WS: %s:%u\n", srv.target, srv.port);
}

KirinIdentity id;
if (kirin_resolve_identity("alice.kirinnet.org", &id) == KIRIN_OK) {
    printf("ID: %s\n", id.id);
}
```

**C++：**
```cpp
#include "kirin_dns.hpp"

if (auto srv = kirin::resolveService("alice.kirinnet.org", "ws")) {
    std::cout << "WS: " << srv->target << ":" << srv->port << "\n";
}
if (auto id = kirin::resolveIdentity("alice.kirinnet.org")) {
    std::cout << "ID: " << id->id << "\n";
}
```

**Ruby：**
```ruby
require_relative 'kirin_dns'

srv = KirinDNS.resolve_service('alice.kirinnet.org', 'ws')   # {target:, port:} 或 nil
id  = KirinDNS.resolve_identity('alice.kirinnet.org')         # {id:, key:, nick:} 或 nil
```

**Swift：**
```swift
let srv = try await KirinDNS.resolveService("alice.kirinnet.org", "ws")  // SrvResult?
let id  = try await KirinDNS.resolveIdentity("alice.kirinnet.org")       // KirinIdentity?
```

**PHP：**
```php
require 'kirin_dns.php';

$srv = KirinDNS\resolveService('alice.kirinnet.org', 'ws');  // ['target'=>..., 'port'=>...] 或 null
$id  = KirinDNS\resolveIdentity('alice.kirinnet.org');        // ['id'=>..., 'key'=>...] 或 null
```

**Dart：**
```dart
import 'kirin_dns.dart';

final srv = await KirinDns.resolveService('alice.kirinnet.org', 'ws');  // SrvResult?
final id  = await KirinDns.resolveIdentity('alice.kirinnet.org');       // Map?
```

**Lua：**
```lua
local kirin = require("kirin_dns")

local srv = kirin.resolveService("alice.kirinnet.org", "ws")  -- {target=..., port=...} 或 nil
local id  = kirin.resolveIdentity("alice.kirinnet.org")        -- {id=..., key=..., nick=...} 或 nil
```

**C# / Java / Kotlin（当前 v1，波 1 重写为 v2）：**
```csharp
var ports = await KirinDns.ResolveAsync("alice.kirinnet.org");  // KirinPorts{Http,Https,Ws,Wss}
```
```java
KirinDns.Ports ports = KirinDns.resolve("alice.kirinnet.org");  // {http, https, ws, wss}
```
```kotlin
val ports = KirinDns.resolve("alice.kirinnet.org")  // KirinPorts(http, https, ws, wss)
```

---

## Tested（实测状态三档）

| 档位 | 含义 |
|---|---|
| ✅ 已测 | 已跑门禁命令并通过（单测 / smoke 全绿） |
| 🟡 已迁移待补测 | 源码已对齐 v2.0，但 SRV 主路径单测待补（波 1 D07） |
| 🔴 待迁移 | 仍是 v1 TXT-JSON 模型，波 1 D07 重写为 v2 |

| 语言 | 门禁命令 | 当前状态 | 说明 |
|---|---|---|---|
| Python | `pytest tests/` | ✅ 已测 | 29 passed / 9 skipped（v1 端口解析类标注波1重写） |
| JavaScript | `node javascript/kirin_dns.js`（self-test） | 🟡 已迁移待补测 | self-test 通过；SRV 路径单测待补（D07） |
| TypeScript | `tsc --noEmit javascript/kirin_dns.d.ts` | 🟡 已迁移待补测 | 类型定义已对齐 v2 实现 |
| C | `gcc -std=c99 ... -DTEST`（self-test） | 🟡 已迁移待补测 | self-test 通过；SRV 主路径单测待补 |
| C++ | `g++ -std=c++17 ... -DTEST_KIRIN_DNS`（self-test） | 🟡 已迁移待补测 | self-test 通过；SRV 主路径单测待补 |
| Go | `go test ./...` | 🟡 已迁移待补测 | **注意假绿**：现有 test 仅测 v1 `parseTxtV1`，未验 SRV 主路径，波 1 须迁出后重验 |
| Rust | `cargo test` | 🟡 已迁移待补测 | 单测覆盖 v1 解析 + v2 `Identity::parse`/`srv_service_name`；SRV 实查待补 |
| Swift | `swift test` | 🟡 已迁移待补测 | 待补 |
| Dart | `dart test` | 🟡 已迁移待补测 | 待补 |
| Lua | `lua ...` | 🟡 已迁移待补测 | 待补 |
| PHP | `php ...` | 🟡 已迁移待补测 | 待补 |
| Ruby | `ruby ...` | 🟡 已迁移待补测 | 待补 |
| C# | `dotnet test` | 🔴 待迁移 | v1 TXT-JSON，波 1 重写为 v2 SRV+TXT+身份 |
| Java | `javac && java -ea` | 🔴 待迁移 | v1 TXT-JSON，波 1 重写为 v2 |
| Kotlin | `kotlinc -include-runtime ...` | 🔴 待迁移 | v1 TXT-JSON，波 1 重写为 v2 |

> CI 矩阵（`.github/workflows/ci.yml`）当前仅覆盖 Python/JS/Go/Rust + lint，**11 语言无 CI**，波 1 扩展到 15 语言。

---

## 跨语言一致性（波 1 落地）

波 1 D07 将建立固定 SRV/TXT 输入 → 断言 15 语言输出结构等价的一致性脚本，校验：SRV 名三件套、回退端口、身份字段、fail-closed 错误语义、品牌零 `aura`。

---

## 版本

| 版本 | 日期 | 变更 |
|---|---|---|
| v2.0 | 2026-08-08 | P-SDK 重写：对齐 ADRP v2.0（SRV+TXT 双层）；API 表逐语言对照真实导出符号；Quick Start 改 v2 主 API；Tested 三档（已测/已迁移待补测/待迁移）；标注 C#/Java/Kotlin 波1重写、Go 假绿 |
| v1.0 | （历史） | 旧 v1 口径：`resolve_kirin_dns(domain)→{http,https,ws,wss}` TXT-JSON 端口（**已过时**） |
