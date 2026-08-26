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
| 8 | C# | `await KirinDns.ResolveServiceAsync(domain, service)` → `Task<KirinSrvResult?>` | `await KirinDns.ResolveIdentityDidDnsAsync(domain)` → `Task<DidDnsIdentity?>` | `await KirinDns.ResolveAsync(domain)` → `Task<KirinPorts>`（legacy，v1 端口 dict） | .NET 6+ |
| 9 | Java | `KirinDns.resolveService(domain, service)` → `SrvResult` | `KirinDns.resolveIdentityDidDns(domain)` → `DidDnsIdentity` | `KirinDns.resolve(domain)` → `KirinPorts`（legacy） | JDK 11+，JNDI DNS |
| 10 | Kotlin | `resolveService(domain, service)` → `SrvResult?` | `resolveIdentityDidDns(domain)` → `DidDnsIdentity?` | `resolve(domain)` → `KirinPorts`（legacy） | Kotlin/JVM，`javax.naming` |
| 11 | Ruby | `KirinDNS.resolve_service(domain, service)` → `Hash \| nil` | `KirinDNS.resolve_identity(domain)` → `Hash \| nil` | `KirinDNS.resolve_kirin_dns(domain)` → `Hash` | Ruby stdlib（`resolv`/`json`） |
| 12 | Swift | `try await KirinDNS.resolveService(domain, service)` → `SrvResult?` | `try await KirinDNS.resolveIdentity(domain)` → `KirinIdentity?` | （v2 wrapper 内置） | Foundation + `dig` |
| 13 | PHP | `KirinDNS\resolveService($domain, $service)` → `?array` | `KirinDNS\resolveIdentity($domain)` → `?array` | （v2 wrapper 内置） | PHP 8.0+，`dns_get_record` |
| 14 | Dart | `await KirinDns.resolveService(domain, service)` → `SrvResult?` | `await KirinDns.resolveIdentity(domain)` → `Map?` | （v2 wrapper 内置） | Dart 3.0+，`dart:io` UDP |
| 15 | Lua | `kirin.resolveService(domain, service)` → `table?` | `kirin.resolveIdentity(domain)` → `table?` | （v2 wrapper 内置） | Lua 5.1+，`luasocket` |

> C# / Java / Kotlin 的 v2 主 API（`ResolveService`/`resolveService` + did:dns 身份解析）已在 D07（2026-08-09）落地，与 12 门已迁移语言同基线；`resolve(domain)` legacy 入口保留作向后兼容。三门本机缺 .NET/JDK/Kotlin 工具链未实跑，CI 已配 job（见 Tested 表）。

---

## 目录结构

```
02_Libraries/
├── c/            kirin_dns.h + kirin_dns.c        (C99, libresolv)
├── cpp/          kirin_dns.hpp                    (C++17, header-only, libresolv)
├── csharp/       KirinDns.cs                      (.NET 6+, did:dns + SRV, D07)
├── dart/         kirin_dns.dart                   (Dart 3.0+, dart:io UDP)
├── go/           kirin_dns.go + kirin_dns_test.go (Go 1.21+, stdlib)
├── java/         KirinDns.java                    (JDK 11+, JNDI, did:dns + SRV, D07)
├── javascript/   kirin_dns.js + kirin_dns.d.ts    (Node.js ≥18)
├── kotlin/       KirinDns.kt                      (Kotlin/JVM, javax.naming, did:dns + SRV, D07)
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

**C# / Java / Kotlin（D07 已对齐 v2 did:dns；本机缺工具链，待 CI 实跑）：**
```csharp
// v2 主 API
var srv = await KirinDns.ResolveServiceAsync("alice.kirinnet.org", "ws");   // KirinSrvResult?
var id  = await KirinDns.ResolveIdentityDidDnsAsync("alice.kirinnet.org");  // DidDnsIdentity?
```
```java
// v2 主 API
KirinDns.SrvResult    srv = KirinDns.resolveService("alice.kirinnet.org", "ws");        // 可为 null
KirinDns.DidDnsIdentity id = KirinDns.resolveIdentityDidDns("alice.kirinnet.org");      // 可为 null
```
```kotlin
// v2 主 API
val srv = resolveService("alice.kirinnet.org", "ws")        // SrvResult?
val id  = resolveIdentityDidDns("alice.kirinnet.org")       // DidDnsIdentity?
```

---

## Tested（实测状态三档）

| 档位 | 含义 |
|---|---|
| ✅ 已测（真机） | 本机已跑门禁命令并通过（单测 / self-test 全绿） |
| ✅ 已测（CI 实机） | GitHub Actions ubuntu-latest 上实跑门禁命令并通过（TD-14：PR #1 run 32996637784，2026-08-26，20/20 job 全绿） |
| 🟡 代码就绪·待实机 | 源码已对齐 v2.0（SRV + did:dns + 身份），本机缺工具链无法实跑；CI 已配该语言 job，待 CI 出绿 |
| 🔴 待迁移 | 仍是 v1 TXT-JSON 模型（D07 后已清零，本档保留作占位） |

> 说明：D07（2026-08-09）已完成 15 语言全部对齐 ADRP v2.0——C#/Java/Kotlin 三门已从 v1 TXT-JSON 重写为 did:dns 三记录 + SRV 新基线（源码完整，仅本机缺 .NET/JDK/Kotlin 工具链未实跑），不再有「待迁移」。`🔴 待迁移` 档位保留为占位，当前无任何语言落入此档。TD-14（2026-08-26）CI 15 语言矩阵全绿后，「待实机」档清零。

| 语言 | 门禁命令 | 当前状态 | 说明 |
|---|---|---|---|
| Python | `pytest tests/` | ✅ 已测（真机） | **52 passed / 9 skipped / 0 error**（v1 端口解析类 9 例 skip 标注波1重写，did:dns/SRV 主路径全绿） |
| JavaScript | `node javascript/kirin_dns.js`（self-test） | ✅ 已测（真机） | self-test **43 passed**（SRV + did:dns 身份解析主路径全覆盖） |
| Rust | `cargo test` | ✅ 已测（真机） | **27 passed + 2**（v1 解析 + v2 `Identity::parse`/`srv_service_name`/SRV 实查覆盖） |
| C | `gcc -std=c99 ... -DTEST_KIRIN_DNS`（self-test） | ✅ 已测（CI 实机） | CI `c-tests`（ubuntu-latest）实跑通过，run 32996637784 |
| C++ | `g++ -std=c++17 ... -DTEST_KIRIN_DNS`（self-test） | ✅ 已测（CI 实机） | CI `cpp-tests`（ubuntu-latest）实跑通过（TD-14 修 test_main 重复 main），run 32996637784 |
| Go | `go test ./...` | ✅ 已测（CI 实机） | CI `go-tests`（ubuntu-latest）实跑通过，run 32996637784；测试偏重 v1 `parseTxtV1` 的覆盖缺口仍在（见 v2.1 行） |
| C# | `dotnet build/run`（self-test） | ✅ 已测（CI 实机） | CI `csharp-tests`（ubuntu-latest, .NET 8）实跑通过（TD-14 修 csproj 重复 Compile + Base64Url 类限定），run 32996637784 |
| Java | `javac && java -ea`（self-test） | ✅ 已测（CI 实机） | CI `java-tests`（ubuntu-latest, JDK 17）实跑通过，run 32996637784 |
| Kotlin | `kotlinc -include-runtime ...`（self-test） | ✅ 已测（CI 实机） | CI `kotlin-tests`（ubuntu-latest, 编译器钉 v2.4.10）实跑通过（TD-14 修下载 URL + Hashtable 导入），run 32996637784 |
| Swift | `swift run`（self-test） | ✅ 已测（CI 实机） | CI `swift-tests`（ubuntu-latest, Swift 6.1.2）实跑通过（TD-14 修 toolchain 404 + 两处词法），run 32996637784 |
| Dart | `dart run`（self-test） | ✅ 已测（CI 实机） | CI `dart-tests`（ubuntu-latest, stable）实跑通过（TD-14 修自测空安全），run 32996637784 |
| Lua | `lua kirin_dns.lua`（self-test） | ✅ 已测（CI 实机） | CI `lua-tests`（ubuntu-latest, lua5.3）实跑通过（TD-14 加 unpack 兼容 shim），run 32996637784 |
| PHP | `php kirin_dns.php`（self-test） | ✅ 已测（CI 实机） | CI `php-tests`（ubuntu-latest, PHP 8.2）实跑通过，run 32996637784 |
| Ruby | `ruby kirin_dns.rb`（self-test） | ✅ 已测（CI 实机） | CI `ruby-tests`（ubuntu-latest, Ruby 3.2）实跑通过，run 32996637784 |

> CI 矩阵（`.github/workflows/ci.yml`）已扩到 **15 语言矩阵 = 14 语言 job + lint**：Python(3.9-3.12)/JS(Node18/20/22)/Go/Rust/C/C++/C#/Java/Kotlin/Swift/Dart/Lua/PHP/Ruby 各跑 self-test，外加 lint（flake8 + eslint）。各门禁命令与上表「门禁命令」列一致。**TD-14（2026-08-26）矩阵已全绿**：PR #1 run 32996637784 全部 job conclusion=success。

---

## 跨语言一致性（波 1 落地）

波 1 D07 将建立固定 SRV/TXT 输入 → 断言 15 语言输出结构等价的一致性脚本，校验：SRV 名三件套、回退端口、身份字段、fail-closed 错误语义、品牌零 `aura`。

---

## 版本

| 版本 | 日期 | 变更 |
|---|---|---|
| v2.2 | 2026-08-27 | TD-14：CI 15 语言矩阵首次全绿（PR #1，run 32996637784，2026-08-26 实跑，20/20 job success）——Tested 表 11 门语言由「🟡 代码就绪·待实机」升「✅ 已测（CI 实机）」并注明 GitHub Actions ubuntu-latest；档位定义增 CI 实机档；「待实机」档清零 |
| v2.1 | 2026-08-09 | P-SDK 同步 X-QA 验收遗留（D07·9.5·波1 合并前小修）：Tested 三档重定义为「已测（真机）/代码就绪·待实机/待迁移（占位）」；Python 计数 29p→**52 passed/9 skipped**；JavaScript/Rust 标为已测（43 passed / 27+2）；C#/Java/Kotlin 由「🔴 待迁移」改为「🟡 代码就绪·待实机」（D07 已重写为 did:dns + SRV 新基线）；CI 说明「11 语言无 CI」→「15 语言矩阵 = 14 语言 job + lint」；API 对照表/Quick Start/目录结构注释补三门 v2 导出符号与基线状态 |
| v2.0 | 2026-08-08 | P-SDK 重写：对齐 ADRP v2.0（SRV+TXT 双层）；API 表逐语言对照真实导出符号；Quick Start 改 v2 主 API；Tested 三档（已测/已迁移待补测/待迁移）；标注 C#/Java/Kotlin 波1重写、Go 假绿 |
| v1.0 | （历史） | 旧 v1 口径：`resolve_kirin_dns(domain)→{http,https,ws,wss}` TXT-JSON 端口（**已过时**） |
