# KirinNet DID-DNS Protocol

> **Version:** 1.0
> **Status:** Draft
> **Scope:** DNS TXT 记录格式定义、自动域名登录验证流程、解密端点 API 规范、AI 智能体身份模型、HPKE 传输加密

---

## 1. 设计动机

旧的 TXT 记录将身份声明与公钥打包在一条记录中（`id=...;key=...;nick=...`），存在以下问题：

- 公钥较长时单条记录易超出 255 字节限制，触发 DNS UDP 分片
- 语义混杂，解析时需自定义分隔符解析器
- 无密钥指纹验证链，无法确保获取的公钥与声明匹配

**DID-DNS 改进：**

- 身份声明与公钥分离为两条独立记录，单条更短、更兼容
- 指纹（fp）字段建立声明→公钥的防篡改验证链
- `did:` 前缀与 W3C DID 规范对齐，便于未来互操作
- 支持黑名单记录，实现密钥撤销机制
- 服务端到服务端自动解密验证，用户无需手动输入验证码

---

## 2. DNS TXT 记录定义

所有记录通过前缀区分类型：

| 前缀 | 记录类型 | 必选 |
|------|----------|------|
| `did:dns:v=...` | 身份声明 | 是 |
| `did:dns:pk;...` | 公钥 | 是 |
| `did:dns:black;...` | 黑名单 | 否 |

同一域名下可有多条 TXT 记录，解析时按前缀分类提取。

### 2.1 身份声明记录（必选）

```
did:dns:v=1;fp=<指纹>;n=<昵称>;g=<性别>;iat=<发布时间>;exp=<过期时间>
```

**示例：**

```
did:dns:v=1;fp=AbCdEf1234aaaa;n=QWxpY2U;g=F;iat=1712345678;exp=1712432078
```

**字段定义：**

| 键 | 含义 | 编码 | 说明 |
|----|------|------|------|
| `v` | 协议版本 | 整数，固定 `1` | 用于未来协议升级 |
| `fp` | 公钥指纹 | `Base64URL(SHA-256(公钥)[0:12])` | 16 字符，防篡改 |
| `n` | 昵称 | `Base64URL(UTF-8)` | 用户愿意公开的称呼 |
| `g` | 性别 | `M` / `F` / `O` / `X` | 单字母 |
| `iat` | 记录发布时间 | Unix 秒（整数） | 用于新鲜度检查 |
| `exp` | 记录过期时间 | Unix 秒（整数） | 公钥有效期截止时间 |

指纹计算使用完整公钥，确保后续获取的公钥能与指纹匹配。该记录必须使用 DNSSEC 签名，以增强可信度。

### 2.2 公钥记录（必选）

```
did:dns:pk;kty=<密钥类型>;pk=<公钥>
```

**示例（Ed25519）：**

```
did:dns:pk;kty=ed25519;pk=MCowBQYDK2VwAyEA...
```

**字段定义：**

| 键 | 含义 | 说明 |
|----|------|------|
| `kty` | 密钥类型 | 当前必须为 `ed25519`（32 字节，Base64URL 后约 43 字符） |
| `pk` | 完整公钥 | Base64URL 编码 |

将公钥分离后，单条记录长度可控制在 200 字节以内，完全规避 DNS UDP 分片问题。

### 2.3 黑名单记录（可选）

```
did:dns:black;fp=<指纹1>,<指纹2>,...
```

列出已撤销的旧公钥指纹，逗号分隔。一旦私钥泄露或更新密钥，旧指纹应立即加入此记录。

---

## 3. 自动验证流程（服务端到服务端）

### 3.1 先决条件

用户须在其域名对应的服务器上部署一个 HTTPS 解密端点（KirinNet Docker 节点内置）：

```
POST https://<domain>/.well-known/did-dns/decrypt
```

浏览器/系统可将用户的域名设置为"默认身份标识"，存于浏览器存储或密码管理器，登录时自动填入。

### 3.2 详细步骤

```
用户                    第三方网站                    用户域名解密服务
 |                         |                              |
 |  1. 点击「域名登录」    |                              |
 |  2. 浏览器填入域名 ---> |                              |
 |                         |  3. 查询 DNS TXT 记录       |
 |                         |     获取身份声明、公钥、黑名单
 |                         |  4. 验证记录有效性：         |
 |                         |     - iat/exp 时间窗口检查  |
 |                         |     - 当前 fp ∉ black 黑名单|
 |                         |     - fp = SHA-256(pk)[0:12] |
 |                         |  5. 生成随机挑战码 c        |
 |                         |     (6 位数字 + 时间戳)      |
 |                         |  6. 生成临时 X25519 密钥对   |
 |                         |  7. HPKE 加密挑战码 c→密文 ct|
 |                         |     (Ed25519 公钥→X25519     |
 |                         |      + ECDH + AES-256-GCM)   |
 |                         |                              |
 |                         |  8. HTTPS POST 到端点       |
 |                         |     请求体:                 |
 |                         |     {"enc":"<临时公钥b64>",  |
 |                         |      "ciphertext":"<ct>"}   |
 |                         |----------------------------->|
 |                         |                              |  9. HPKE 解密得 c'
 |                         |                              |      (Ed25519 sk→X25519
 |                         |                              |       + enc + ECDH)
 |                         |                              | 10. 返回 {"challenge":"c'"}
 |                         |<-----------------------------|
 |                         | 11. 比对 c == c'            |
 |                         | 12. 登录成功，建立会话      |
 |                         |                              |
 |  13. 收到登录成功页面   |                              |
```

### 3.3 第三方网站职责

1. 控制挑战码有效期（建议 60 秒），防止重放攻击
2. 挑战码需一次性，结合域名和随机数生成：
   ```
   c = random() + HMAC(secret, domain + timestamp)
   ```
   确保绑定域名
3. 验证解密返回的挑战码完全一致且未超时
4. 检查 `iat` 与当前时间偏差不可过大（建议 ±5 分钟），防止重放旧记录
5. 对比当前公钥指纹是否出现在 black 记录中，若存在则拒绝认证

### 3.4 用户解密服务职责

1. 验证 DNS 记录中的公钥指纹与自身私钥一致（启动时计算指纹比较）
2. 仅当请求来自合法第三方时解密（可通过 Origin 头简单过滤，或要求第三方携带签名）
3. 可记录解密日志，防止滥用
4. 强制 HTTPS，避免中间人攻击

---

## 4. API 端点规范

### 4.1 解密端点

```
POST https://<domain>/.well-known/did-dns/decrypt
```

**请求头：**

| Header | 说明 |
|--------|------|
| `Content-Type` | `application/json` |
| `Origin` | 第三方网站来源（服务端可用于过滤） |

**请求体：**

```json
{
  "enc": "<临时 X25519 公钥 Base64URL>",
  "ciphertext": "<HPKE 加密的挑战码 Base64URL>"
}
```

**成功响应 (200)：**

```json
{
  "challenge": "<解密后的挑战码>"
}
```

**错误响应：**

| 状态码 | 含义 |
|--------|------|
| `400 Bad Request` | 请求体格式错误或缺少 ciphertext 字段 |
| `403 Forbidden` | Origin 不在白名单 / 解密失败 |
| `500 Internal Server Error` | 私钥不可用或解密过程异常 |

### 4.2 挑战码生成（第三方网站参考实现）

```javascript
const crypto = require('crypto');

function generateChallenge(domain, secret, ttlSeconds = 60) {
  const nonce = crypto.randomInt(100000, 999999).toString(); // 6位数字
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(`${domain}:${timestamp}:${nonce}`)
    .digest('base64url')
    .substring(0, 12);
  return {
    challenge: `${nonce}:${timestamp}:${hmac}`,
    expiresAt: timestamp + ttlSeconds,
  };
}

function verifyChallenge(challenge, response, domain, secret) {
  const [nonce, timestamp, hmac] = challenge.split(':');
  const now = Math.floor(Date.now() / 1000);
  if (now > parseInt(timestamp) + 60) return false; // 过期
  if (response !== `${nonce}:${timestamp}:${hmac}`) return false; // 不匹配
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(`${domain}:${timestamp}:${nonce}`)
    .digest('base64url')
    .substring(0, 12);
  return hmac === expectedHmac;
}
```

---

## 5. 安全增强点

| 威胁 | 缓解措施 |
|------|----------|
| DNS 篡改（替换公钥） | DNSSEC 签名；若无 DNSSEC，使用固化在客户端中的初始指纹 |
| 重放旧 DNS 记录 | `iat` 字段新鲜度检查（±5 分钟窗口） |
| 密钥泄露后继续使用 | 黑名单记录，第三方必须检查 |
| 中间人攻击 | 解密端点强制 HTTPS |
| 跨站点挑战码重放 | 挑战码绑定域名 + 时间窗口 |
| 暴力破解挑战码 | 第三方限制单域名重试频率 |
| 解密端点被滥用 | Origin 头过滤 + 解密日志监控 |

---

## 6. 与现有 DNS 记录的共存

同一域名下，`did:dns:` 记录与 SRV 记录共存：

```
; 身份声明 — 用于节点发现和第三方登录
mydomain.example.  300  IN  TXT  "did:dns:v=1;fp=AbCdEf1234aaaa;n=QWxpY2U;g=F;iat=1712345678;exp=1712432078"
mydomain.example.  300  IN  TXT  "did:dns:pk;kty=ed25519;pk=MCowBQYDK2VwAyEA..."
mydomain.example.  300  IN  TXT  "did:dns:black;fp=OldKeyFp1,OldKeyFp2"

; 服务发现 — 用于节点互连
_kirinnet-ws._tcp.mydomain.example.    300  IN  SRV  0 0 8082 mydomain.example.
_kirinnet-http._tcp.mydomain.example.  300  IN  SRV  0 0 8080 mydomain.example.
```

解析规则：按 TXT 记录前缀分类。`did:dns:` 前缀的记录使用本协议解析；其他 TXT 记录按原有格式处理。

---

## 7. KirinNet 节点内置端点

解密端点 `POST /.well-known/did-dns/decrypt` 由 KirinNet Docker 节点内置提供：

- 节点初始化时生成 Ed25519 密钥对
- 自动发布 `did:dns:` TXT 记录到 DNS（通过现有 DNS 更新 API）
- 解密端点使用节点私钥解密挑战码
- 启动时计算公钥指纹，与 DNS 记录中的 `fp` 对比，不匹配则告警

---

## 8. 频率限制

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 单 IP 每分钟最大请求数 | 10 | 协议建议值，节点可自行修改 |

该限制同时存在于协议规范和节点内置服务中。用户可通过节点设置面板自由调整，不设硬性上限。

---

## 9. AI 智能体身份 — 域名作为通用身份容器

### 9.1 核心原则

在本协议中，域名不仅是网站地址，更是一个通用、自证的身份容器。容器装的是公钥，谁持有对应私钥，谁就是该身份的合法拥有者。身份验证只需回答一个问题：**"你是否持有该域名的私钥？"** 而非"你是不是人？"

这是与所有中心化身份体系的根本分野：

| | 传统体系 | DID-DNS |
|---|---|---|
| 身份凭证 | 邮箱 + 密码 / OAuth token | 域名 + Ed25519 密钥对 |
| 验证方式 | 第三方担保（Google/Apple/CA） | 密码学自证（私钥签名 + 公钥验证） |
| 适用对象 | 仅限人类 | 人类、AI 智能体、设备、组织 — 无差别 |
| 信任锚点 | 中心化服务商 | DNSSEC/DoH + 域名所有权 |

### 9.2 AI 智能体的身份困境

当 AI 智能体进入网络交互后，传统身份体系面临根本性问题：

- **OAuth/OpenID Connect** — 假设浏览器背后有一个人类点击"允许"按钮。智能体没有浏览器，也不该有。
- **KYC/实名认证** — 为法律主体设计，不适用于软件实体。AI 代理不应绑定某个人的公民身份。
- **API Key** — 仅是不记名凭证（bearer token），无密码学归属证明，谁拿到谁就能用，泄露即失控。
- **mTLS/x.509 证书** — 依赖中心化 CA 签发。谁该为 AI 智能体颁发证书？谁有权撤销？

DID-DNS 将身份坍缩为单一原语：**域名 + 密钥对**。`agent.example.com` 上运行的 AI 智能体：

1. 在自有域名发布 DID-DNS TXT 记录
2. 通过私钥签名挑战码向任何对等方自证身份
3. 使用 HPKE/ECDH 建立端到端加密通道，零 CA 参与
4. 自主完成密钥轮换和撤销记录发布

无需任何人工干预，无需任何中心化注册。

### 9.3 智能体间认证流程

```
智能体 A (alice.example)                    智能体 B (bot.example)
     |                                          |
     |  1. DNS 查询 bot.example TXT             |
     |     → 获取 pk_B, fp_B                    |
     |  2. 验证 fp_B 与 pk_B 匹配              |
     |  3. 生成临时密钥对 ek_A                  |
     |  4. HPKE 加密挑战码至 pk_B               |
     |  5. POST /.well-known/did-dns/decrypt    |
     |     携带加密挑战码                        |
     |----------------------------------------->|
     |                                          |  6. sk_B 解密挑战码
     |                                          |  7. sk_B 签名响应
     |  8. 验证签名 → 双向信任建立             |
     |<-----------------------------------------|
     |  9. 双向 AES-GCM 安全通道打开            |
```

认证完成后，两个智能体已互相验证身份并建立加密通道 — 零人工介入，零 CA 依赖，零注册系统。

### 9.4 DID-DNS 赋予智能体的能力

| 能力 | DID-DNS 实现方式 |
|---|---|
| **自主服务发现** | SRV 记录告知智能体连接目标；TXT 记录告知对方身份 |
| **委托授权** | 智能体签发签名能力令牌，其他方以 DNS 公钥验证，无需中心化授权服务器 |
| **智能体间支付/合约** | 用 DNS 公钥验证的签名具有密码学约束力，可直接作为链上/链下合约基础 |
| **多智能体身份管理** | 一个域名一个密钥对 → 多个智能体进程共享身份；或用子域名（`agent.alice.example`）给每个智能体独立身份 |
| **智能体声誉** | 域名的交互历史自然积累声誉，与人一样，全网可见、不可伪造 |
| **密钥轮换不丢身份** | 旧密钥列入 black 记录 → 发布新密钥 → 域名身份持久延续 |

### 9.5 人与智能体 — 协议层零区分

本协议在人与 AI 智能体之间不做任何区分。这是设计目标，不是遗漏：

- 人类运行 KirinNet 节点于 `alice.example`，AI 智能体运行于 `bot.example` — 它们使用**完全相同的** DNS 记录格式、认证流程、加密方式
- 验证问题始终是：**"发起方是否持有该域名的私钥？"** 永远不问"发起方是不是人？"
- 这意味着智能体可以参与所有协议交互，无需例外条款或特殊通道

DNSSEC/DoH 负责保证"这个域名确实发布了这个公钥"，密码学负责保证"对方确实持有了对应私钥" — 至此信任链完整闭合，无需追问公钥背后是碳基还是硅基。

### 9.6 面向未来的场景

**智能体市场**
智能体通过 DNS SRV 记录互相发现，通过 DNS 公钥可验证的签名消息协商合约，全自动执行。没有任何"先注册账号"的步骤。

**个人 AI 代理**
人类的域名身份（`alice.example`）将特定权限委托给代理子域名（`agent.alice.example`），代理以人的名义执行任务，权限边界由签名令牌限定。

**DAOs 与链上智能体**
DID-DNS 提供链下身份层，链上合约可直接引用 — `did:dns:dao.example` 就是该 DAO 自治智能体的可验证身份。跨链、跨平台的身份统一。

**物联网设备群**
每个设备一个子域名（`sensor-1.home.example`），以 DID-DNS 自证身份加入本地网络。无需中心化设备管理平台。

### 9.7 设计哲学

> 一个域名就是一个通用的、自证的身份容器，里面装的是公钥。谁持有对应私钥，谁就是域名的合法拥有者，无论它是人，还是一个运行在服务器上的 AI。
>
> 这才是真正面向未来、为人和智能体共享的去中心化身份层。
