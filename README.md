# KirinNet 麒麟网 — 去中心化身份与节点网络协议

> 私钥即身份，域名即寻址标签，为人和 AI 智能体共享。

KirinNet 是一个完全去中心化的网络协议。**双模式身份，无全网分界**：可发布域名以前**域名即身份**（公钥放传统 DNS TXT 记录）；可发布域名以后**钱包私钥即身份**（利用现有加密货币基建，XRP 优先，公钥放分布式 DNS TXT 记录）。身份验证统一为**签名质询-应答**：校验方发随机信息，受验方私钥签名返回，公钥验签完成验证。域名允许不同的人发布相同名称，归属由去中心化节点群的信任权重决定，纠纷留给法律。

**不需要中心化 CA。不需要用户注册。不需要密码。** DNS 就是你的身份层，Ed25519 私钥就是你的证明。

> **本仓库仅开源 KirinNet 协议**（身份协议 / 服务发现 / IM / 安全模型 / SDK / 浏览器生态）。
> 用户节点（Node）实现已拆分为独立仓库：**[kirin-yucall/KirinNet-Node](https://github.com/kirin-yucall/KirinNet-Node)**。

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
| KYC 实名认证 | 只适用于法律主体 | 私钥=身份，不追问碳基还是硅基 |
| 密码登录 | 数据库拖库即灾难 | 无私钥存储，DNS 即信任锚 |
| 中心化域名注册 | 域名唯一性由注册局裁决 | 允许同名，节点群信任权重评分，法律兜底 |

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

详见 [`01_Standard/did-dns-protocol.md`](01_Standard/did-dns-protocol.md)。

---

## 协议组成

| 文档 | 内容 | 状态 |
|---|---|---|
| [`did-dns-protocol.md`](01_Standard/did-dns-protocol.md) | DID-DNS 身份协议（记录格式/自动认证/解密端点/HPKE/AI 智能体身份模型） | ✅ 基线 |
| [`spec_v1.md`](01_Standard/spec_v1.md) | ADRP 解析协议（SRV 服务发现 + TXT 身份元数据） | ⚠️ 旧格式待对齐 |
| [`dns_automation.md`](01_Standard/dns_automation.md) | DNS 自动化标准（更新 API 契约、节点更新循环） | ✅ |
| [`im_protocol.md`](01_Standard/im_protocol.md) | P2P IM 协议（两阶段好友、会话密钥） | ⚠️ 旧品牌/旧密钥 |
| [`security_model_v1.md`](01_Standard/security_model_v1.md) | 安全威胁模型（三层信任/心跳/分布式入侵检测） | ⚠️ RSA 体系待对齐 |

> 已知协议不一致问题（密钥体系三套并存、TXT 格式两代等）见 [`需求设计文档.md`](需求设计文档.md) 第 9 章。

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

详见 [`02_Libraries/README.md`](02_Libraries/README.md)（15 语言实现状态）。

---

## 安全架构

- **强制 DoH/DoT**：身份记录解析必须走加密 DNS（DoT/DoH），明文 53 返回的身份记录拒绝或降级告警，配合 TOFU 警示与跨通道交叉验证防 DNS 投毒
- **零 CA 信任链**：DNSSEC/DoH → DNS 公钥 → 指纹验证 → HPKE 加密
- **Ed25519 统一密钥**：身份签名、好友加密、Follower 内容加密全部 Ed25519
- **HPKE 传输加密**：Ed25519→X25519 转换 + ECDH + HKDF-SHA-256 → AES-256-GCM
- **设备授权模式**：挑战-响应自动认证，用户无需手动输入验证码，授权码 60 秒一次性有效
- **密钥撤销**：黑名单 `did:dns:black` 记录发布已撤销指纹
- **引导期计数防投毒**：域名发布走计数泛洪，计数达 1000 万 → 多点协商共识时间戳 → 全网开关关闭计数
- **社交信任解析防污染**：IM 列表（好友 + 常用网址）维护权重，转发链天然带权重分，钱包级负权重降分，社交节点自我修复
- **去中心化**：每个用户自跑节点，无中心服务器，不需要限流
- **三层信任模型**：好友密钥锁定 → 政府 CA（可选实名映射）→ 物理追责

详见 [`01_Standard/security_model_v1.md`](01_Standard/security_model_v1.md)。

---

## 客户端生态

- **Chrome 扩展**（Manifest V3）：DNS TXT 查询 → 端口发现 → 重定向非标准端口服务 → [`03_Browser_Extension/`](03_Browser_Extension/)
- **定制 Chromium**：内置扩展打包，核心 DNS 栈零改动 → [`04_Chromium_Browser/`](04_Chromium_Browser/)
- **IETF 标准化**：ADRP 草案 + DNSOP 工作组路线图 → [`05_Adoption/rfc_draft.md`](05_Adoption/rfc_draft.md)

---

## 项目结构

```
KirinNet/
├── README.md
├── 需求设计文档.md              # 协议需求与设计总览
├── DECISIONS.md                # 架构决策记录
├── 01_Standard/                # 协议规范
│   ├── did-dns-protocol.md     # DID-DNS 身份协议
│   ├── spec_v1.md              # ADRP 解析协议
│   ├── dns_automation.md       # DNS 自动化标准
│   ├── im_protocol.md          # IM 通信协议
│   ├── security_model_v1.md    # 安全威胁模型
│   └── draft-*-adrp-*.txt      # IETF 草案
├── 02_Libraries/               # 15 语言 SDK（kirin-dns / kirin-auth）
├── 03_Browser_Extension/       # Chrome Extension (Manifest V3)
├── 04_Chromium_Browser/        # 定制 Chromium 构建说明
├── 05_Adoption/                # IETF 路线图 / GTM / 演示站点
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

Apache License 2.0. See [LICENSE](LICENSE) for details.

---

## Links

- **需求与设计总览**: [`需求设计文档.md`](需求设计文档.md)
- **DID-DNS 协议**: [`01_Standard/did-dns-protocol.md`](01_Standard/did-dns-protocol.md)
- **IETF 路线图**: [`05_Adoption/rfc_draft.md`](05_Adoption/rfc_draft.md)
- **Chrome 扩展**: [`03_Browser_Extension/`](03_Browser_Extension/)
- **用户节点（独立仓库）**: [kirin-yucall/KirinNet-Node](https://github.com/kirin-yucall/KirinNet-Node)
- **GitHub**: [kirin-yucall/KirinNet](https://github.com/kirin-yucall/KirinNet)
