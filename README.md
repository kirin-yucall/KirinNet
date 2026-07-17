# KirinNet 麒麟网

> 去中心化身份与节点网络 — 域名即身份，为人和 AI 智能体共享。

KirinNet 是一个完全去中心化的网络协议和节点实现。每个域名就是一个通用、自证的身份容器——无论持有私钥的是人还是 AI 智能体，协议层不做任何区分。

**不需要中心化 CA。不需要用户注册。不需要密码。** DNS 就是你的身份层，Ed25519 私钥就是你的证明。

---

## 愿景 (Vision)

我们坚信 Web3 技术应该服务于最广大人民的根本利益。

本协议致力于：

- **可信与平等**：构建一个摒弃算力霸权、回归用户自主的信任基石。
- **务实与共赢**：拒绝空中楼阁般的金融炒作，聚焦解决实体经济与社会治理中的真实痛点。
- **青年担当**：这是一个由中国青年发起的前沿探索，我们立志用一行行严谨的代码，在世界科技舞台上展现中国智慧。

---

## 为什么选择 DID-DNS

| 传统体系 | 问题 | DID-DNS 方案 |
|---|---|---|
| OAuth / OpenID Connect | 假设浏览器背后有人点"允许" | 密码学自证：谁有私钥谁是合法拥有者 |
| API Key | 不记名凭证，泄露即失控 | Ed25519 签名，密码学归属证明 |
| mTLS / x.509 | 依赖中心化 CA 签发和撤销 | DNSSEC/DoH 保护，零 CA |
| KYC 实名认证 | 只适用于法律主体 | 域名=身份，不追问碳基还是硅基 |
| 密码登录 | 数据库拖库即灾难 | 无私钥存储，DNS 即信任锚 |

---

## DNS 记录定义

所有记录使用 `did:dns:` 前缀，放在域名根节点。**单条 ≤ 200 字节，避免 UDP 分片。**

```
; 身份声明（必选）
mydomain.example. 300 IN TXT "did:dns:v=1;fp=AbCdEf1234aaaa;n=QWxpY2U;g=F;iat=1712345678;exp=1712432078"

; 公钥（必选）
mydomain.example. 300 IN TXT "did:dns:pk;kty=ed25519;pk=MCowBQYDK2VwAyEA..."

; 黑名单（可选，已撤销的旧公钥指纹）
mydomain.example. 300 IN TXT "did:dns:black;fp=OldKeyFp1,OldKeyFp2"

; 服务发现
_kirinnet-ws._tcp.mydomain.example.  300 IN SRV 0 0 8082 mydomain.example.
```

- **指纹验证链**：fp = SHA-256(公钥)[0:12] → 防公钥替换攻击
- **DNSSEC 强制**：域名必须有 DNSSEC 签名，或客户端通过可信 DoH 获取
- **Ed25519 唯一密钥类型**：全系统统一，加密场景 Ed25519→X25519 转换 + HPKE

详见 [`01_Standard/did-dns-protocol.md`](01_Standard/did-dns-protocol.md)（9 节，387 行）。

---

## AI 智能体原生支持

智能体无需任何特殊适配即可使用全部 KirinNet 功能：

```
智能体 A (agent.example)              智能体 B (bot.example)
     |                                       |
     |  1. DNS 查询 bot.example TXT          |
     |     → pk_B, fp_B                      |
     |  2. 验证 fp_B = SHA-256(pk_B)[0:12]  |
     |  3. 生成临时 X25519 密钥对            |
     |  4. HPKE 加密挑战码至 pk_B            |
     |  5. POST /.well-known/did-dns/decrypt |
     |-------------------------------------->|
     |                                       |  6. HPKE 解密挑战码
     |                                       |  7. 签名响应
     |  8. 验证签名 → 双向信任建立          |
     |<--------------------------------------|
     |  9. AES-256-GCM 安全通道              |
```

- **智能体市场**：SRV 记录自动发现，签名合约自动执行
- **个人 AI 代理**：子域名委托（`agent.alice.example`）
- **链上智能体**：`did:dns:dao.example` 可被链上合约直接引用
- **IoT 设备群**：每设备一个子域名自证身份

---

## 开发库 (SDK)

优先三语言（Python / JavaScript / Rust），计划扩展至 15 种主流语言。

| 库 | 用途 | Python | JavaScript | Rust |
|---|---|---|---|---|
| **kirin-dns** | DoH 解析 TXT/SRV/A，指纹验证 | `pip install kirin-dns` | `npm i kirin-dns` | `cargo add kirin-dns` |
| **kirin-auth** | HPKE 挑战-响应，自动认证 | `pip install kirin-auth` | `npm i kirin-auth` | `cargo add kirin-auth` |

### 快速示例

**Python:**
```python
from kirin_dns import resolve
identity = resolve("alice.example")
print(identity.identity.nickname)   # "Alice"
print(identity.pubkey_verified)      # True
print(identity.service.ws_port)      # 8082
```

**JavaScript:**
```javascript
import { resolve } from 'kirin-dns';
const identity = await resolve('alice.example');
console.log(identity.identity.nickname);
console.log(identity.service.wsPort);
```

**Rust:**
```rust
use kirin_dns::resolve;
let identity = resolve("alice.example")?;
println!("{}", identity.nickname());
println!("ws_port: {:?}", identity.ws_port());
```

---

## 安全架构

- **零 CA 信任链**：DNSSEC/DoH → DNS 公钥 → 指纹验证 → HPKE 加密
- **Ed25519 统一密钥**：身份签名、好友加密、Follower 内容加密全部 Ed25519
- **HPKE 传输加密**：Ed25519→X25519 转换 + ECDH + HKDF-SHA-256 → AES-256-GCM
- **设备授权模式**：挑战-响应自动认证，用户无需手动输入验证码，授权码 60 秒一次性有效
- **密钥撤销**：黑名单 `did:dns:black` 记录发布已撤销指纹
- **去中心化**：每个用户自跑节点，无中心服务器，不需要限流

详见 [`01_Standard/security_model_v1.md`](01_Standard/security_model_v1.md)。

---

## KirinNet 用户节点

**一个镜像，全部能力。** `07_User_Node/` 是唯一的用户节点源码，整合了索引器（08_KirinNet）和聚合爬虫（09_Pub_Aggregator）的全部功能。

**流程:** 首次访问 → 初始化向导 → 登录 → SPA 主界面。

```bash
docker run -d --name my-node --restart unless-stopped \
  -p 8080:8080 -p 8082:8082 \
  -v ./data:/app/data \
  kirinnet-node:latest
```

然后打开 `http://localhost:8080/`。

**核心功能:**
- 🏠 内容发布 + 标签 + 弹性分段 SHA-256 去重
- 🔍 探索系统（方向驱动主动探知，替代搜索）
- 💬 IM 群聊 + 私聊（WebSocket，好友 Ed25519 密钥锁定）
- 📢 广告位竞拍（收入归节点主人）
- 👥 粉丝订阅 + HPKE 自动加密推送
- 💰 积分 + VIP 变现
- 🛒 购物车/订单/优惠券/支付方式
- 🔗 公共索引 + 域名黑名单
- 🌐 DNS 管理（12 家服务商）
- ⚙️ 所有设置 Web UI 实时切换，重启持久化
- 🔐 DID-DNS 解密端点 `/.well-known/did-dns/decrypt`

详见 [`07_User_Node/README.md`](07_User_Node/README.md) 和 [`07_User_Node/api.md`](07_User_Node/api.md)。

---

## 项目结构

```
KirinNet_Project/
├── README.md
├── 01_Standard/
│   ├── did-dns-protocol.md      # DID-DNS 身份协议 (9 节, 387 行)
│   ├── dns_automation.md        # DNS 自动化标准
│   ├── security_model_v1.md     # 安全威胁模型
│   └── im_protocol.md           # IM 通信协议
├── 02_Libraries/                # 开发库（计划 15 语言）
│   ├── kirin-dns/               # DNS 解析 → python/js/rust
│   ├── kirin-auth/              # 自动认证 → python/js/rust
│   ├── python/ javascript/ go/ rust/  # 旧版 ADRP 实现
│   ├── c/ cpp/ csharp/ java/ kotlin/
│   ├── dart/ ruby/ swift/ php/ lua/
│   └── typescript/
├── 03_Browser_Extension/        # Chrome Extension (Manifest V3)
├── 04_Chromium_Browser/         # Custom Chromium build instructions
├── 05_Adoption/                 # IETF roadmap, GTM strategy, demo sites
├── 07_User_Node/                # KirinNet Node — 单一 Docker 镜像
│   ├── storage_architecture.md  # 存储架构 (DuckDB + RocksDB + FS)
│   ├── server.js                # 单入口，22 个模块
│   ├── models/                  # DuckDB schema
│   ├── routes/                  # 22 个 API 路由模块
│   └── public/                  # Web UI (SPA)
├── 08_KirinNet/                 # 公共索引器（已整合进 07）
├── 09_Pub_Aggregator/           # 聚合爬虫（已整合进 07）
├── TASKPLAN.md
├── DECISIONS.md
└── LICENSE
```

---

## 设计原则

- **域名 = 身份容器**：域名 + Ed25519 = 自证身份，无需任何人担保
- **人与智能体零区分**：协议层不区分——只问"你有私钥吗？"
- **零 CA 信任链**：DNSSEC/DoH → DNS 公钥 → 密码学验证 → 闭环
- **去中心化思维**：不用限流、不用中心化注册、不用 CA 证书
- **Ed25519 唯一密钥类型**：全系统统一，加密场景 Ed25519→X25519 转换

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Links

- **DID-DNS 协议**: [`01_Standard/did-dns-protocol.md`](01_Standard/did-dns-protocol.md)
- **用户节点文档**: [`07_User_Node/README.md`](07_User_Node/README.md)
- **API 参考**: [`07_User_Node/api.md`](07_User_Node/api.md)
- **存储架构**: [`07_User_Node/storage_architecture.md`](07_User_Node/storage_architecture.md)
- **安全模型**: [`01_Standard/security_model_v1.md`](01_Standard/security_model_v1.md)
- **IETF 路线图**: [`05_Adoption/rfc_draft.md`](05_Adoption/rfc_draft.md)
- **Chrome 扩展**: [`03_Browser_Extension/`](03_Browser_Extension/)
- **GitHub**: [kirin-yucall/KirinNet](https://github.com/kirin-yucall/KirinNet)
