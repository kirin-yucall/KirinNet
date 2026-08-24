# KirinNet 泛洪协议（Flood Protocol）

> **Version:** 0.1（草案）
> **Date:** 2026-08-08
> **Status:** **已会签定稿（KNET-CC-007，2026-08-08 节点 PM 会签通过）**
> **Scope:** 受限泛洪消息信封与包类型、TTL（跳数）、`forward_chain` 转发链（防环）、fanout 出度上限、配额口径、末端回传语义
> **关联编号:** T1（解锁闸）/ FR6（好友链泛洪解析）/ FR11（防滥用配额）/ 9.3.2（签名覆盖范围，**引用 T9·已会签定稿（KNET-CC-011）**）
> **承载关系:** T1 信封是 T3（信任权重携带）/T4（多候选应答承载）/T6（好友链泛洪解析）/T8（count 包语义）的共同承载层，须最先交付。
> **签名口径:** 本文件中 `nonce` 与 `signature` 的覆盖范围**引用 T9（`DECISIONS.md` §9.3.2，P-ARCH 技术定稿口径·已会签定稿（KNET-CC-011，2026-08-08 节点 PM 会签通过））**，P-FLOOD 引用不重定义；算法本身归 P-ARCH 主笔。

---

## 0. 草案状态与依据

| 项 | 说明 |
|---|---|
| 草案定位 | v0.1 **信封**草案：定义泛洪信封公共字段与四类包类型枚举、TTL/`forward_chain`/fanout/配额/末端回传；签名覆盖范围引用 T9 不重定义 |
| 反提炼对象 | 节点仓 `KirinNet-Node\需求文档\02_DNS动态解析.md` §3.3（query/answer/announce 三类包格式）+ FR6（好友链泛洪·6 跳·fanout 16·`forward_chain` 防环）+ FR11（每日 3 次配额、超限 -127）+ `settings`（`dns_flood_max_hops=6`/`dns_flood_fanout=16`/`dns_flood_quota_daily=3`） |
| 协议新增（节点侧未实现） | `count`（引导期计数泛洪）与 `publish`（内容发布泛洪）的语义由 T8 与内容发布域分别定义，T1 仅定义其**信封承载位** |
| 会签记录 | T1 已经节点 PM 会签（**KNET-CC-007，2026-08-08 通过**）定稿；下游引用本文件的草案（T3/T4/T6/T8）须沿用本文件字段并标注「引用 T1·已会签定稿（KNET-CC-007）」 |
| 不越界 | 签名覆盖范围归 T9（P-ARCH）；钱包地址编码归 T2；T6 阶段二社交信任链算法归 PR-DDNS（波 2）；本文件不定型上述项 |

---

## 1. 设计动机与原则

KirinNet 是去中心化网络，**不依赖中心权威 / 注册系统 / 限流网关**。所有跨节点的控制面与数据面分发（身份宣告、解析查询、计数、内容发布）共用一条**受限泛洪通道**。

**受限泛洪（restricted flooding）的四条纪律：**

1. **好友链泛洪非广播**：泛洪仅在好友关系构成的边（IM 列表 `contacts`）上传播，**不对非好友节点广播**（02_DNS §2.4 Out of Scope）。好友链泛洪 ≠ 全网广播。
2. **跳数受限（TTL）**：每包携带 `ttl`（跳数上限），转发时 `ttl-1`，`ttl ≤ 0` 时停止转发。
3. **出度受限（fanout）**：单次转发最多发给 `fanout` 个未拉黑好友，防风暴。
4. **防环（`forward_chain`）**：转发链上记录所有已转发节点的域名，链上节点不再重复转发。

**与去中心化纪律的关系：** 受限泛洪用「好友关系 + 跳数 + fanout + 防环」做天然的拓扑约束，**不使用限流 / 注册 / CA**（§0 去中心化决策）；引导期另有「计数阀门」（T8，中心化式防投毒、一次性），运营期靠信任权重（T3，去中心化防污染、持续）—— 两套机理分明，切换点共管。

---

## 2. 泛洪信封（公共字段）

所有泛洪包共享一个**信封（envelope）**，信封字段按固定顺序排列。包类型特有字段（payload）置于信封之后。

```
{
  "v": <协议版本, 整数, 固定 1>,
  "type": <包类型, 见 §3>,
  "src_domain": <发起方域名, ASCII>,
  "ttl": <剩余跳数, 整数, 发起时设为该包类型的上限>,
  "query_id": <请求标识, ASCII, 同一泛洪查询链共享>,
  "nonce": <随机数, 引用 T9 §9.3.1 挑战码结构>,
  "forward_chain": [<已转发节点域名, ASCII, 顺序追加>],
  "signature": <Ed25519 签名 Base64URL, 引用 T9 §9.3.2 覆盖范围>,
  "payload": { <包类型特有字段, 见 §3> }
}
```

### 2.1 信封字段定义

| 字段 | 类型 | 必选 | 含义 | 约束 |
|----|------|------|------|------|
| `v` | int | 是 | 协议版本 | 固定 `1`，未来升级递增 |
| `type` | enum | 是 | 包类型 | `announce` / `count` / `query` / `answer` / `publish`（见 §3） |
| `src_domain` | str | 是 | 发起方域名（身份锚点） | ASCII，与 `did:dns:v=1` 身份声明记录的域名一致 |
| `ttl` | int | 是 | 剩余跳数 | 发起时设为该包类型的跳数上限（见 §4.1）；转发时 `ttl-1`；`ttl ≤ 0` 停止转发 |
| `query_id` | str | 是 | 请求标识 | 同一泛洪查询链（query→answer 链）共享，用于聚合同一查询的多候选应答；防重放（与 `nonce` 配合） |
| `nonce` | str | 是 | 随机数 | **引用 T9 §9.3.1**（挑战码 `nonce:timestamp:hmac` 结构），由发起方 CSPRNG 生成；用于包级防重放 |
| `forward_chain` | str[] | 是 | 转发者域名链 | 发起方为 `[src_domain]`；每个转发者追加自身域名后转发；**防环与签名覆盖**（见 §5、§7） |
| `signature` | str | 是 | Ed25519 签名 | **引用 T9 §9.3.2 签名覆盖范围**（覆盖 `challenge` + 双方域名 + `forward_chain` + T3 权重字段），P-FLOOD 不重定义；算法 Ed25519，64 字节 Base64URL |
| `payload` | object | 是 | 包类型特有字段 | 见 §3 |

### 2.2 信封规范化（防编码歧义）

签名前，信封字段按**固定顺序**拼接，字段间用 `\n` 分隔；JSON 场景按 **JCS（RFC 8785）** 规范化后再签名（与 T9 §9.3.2 一致）。**禁止**对字段重排或省略后再签名。

---

## 3. 包类型（payload 枚举）

T1 定义五类包类型的**信封承载位与公共约束**；各包类型特有字段的语义由对应 T 项草案定义（T8 定义 `count` 语义/阈值/开关；T4 定义 `answer` 候选排序；T6 定义 `query`/`announce` 解析流程；内容发布域定义 `publish` 配额计入）。

| type | 用途 | 跳数上限 | 是否广播 | 配额计入 | payload 关键字段 | 语义主笔 |
|---|---|---|---|---|---|---|
| `announce` | 节点入网/记录宣告（身份锚点 + 公钥 + 端点变化广播给好友） | **15**（入网宣告广播泛洪，§0 决策） | 是（好友圈内广播式，但仍受 fanout/防环约束） | 否（系统宣告，不计入用户自主泛洪配额） | `record_type` / `content` / `did_dns`（身份声明串）/ `expires_at` | T6（解析流程）/ 节点 02 篇 FR9（双通道更新） |
| `count` | 引导期计数泛洪（域名发布计数，达 1000 万阈值触发开关） | 见 T8 | 否（受限泛洪） | 是（属用户自主泛洪，计入每日配额） | `counter_value` / `timestamp` / `consensus_flag`（T8 定） | **T8**（计数语义/阈值/共识时间戳/开关） |
| `query` | 好友链解析查询（本地 miss → 好友链受限泛洪） | **≤6**（`dns_flood_max_hops=6`，六度分隔） | 否（受限泛洪，02_DNS FR6） | 否（系统解析，不计入配额） | `qname` / `qtype` / `requester_domain` | T6（解析流程） |
| `answer` | 解析应答回传（含多候选 + 路径权重） | ≤6（与 query 同，回传链不大于查询链） | 否（沿 `forward_chain` 逆向回传） | 否 | `candidates[]` / `trust_weight` / `hops` | **T4**（候选 schema + 排序） |
| `publish` | 内容发布泛洪（用户自主发布内容到好友圈） | ≤6（受限泛洪，02_DNS FR6 同构） | 否 | **是（计入每日 3 次配额，§0 决策）** | `content_ref` / `content_type` | 内容发布域（T1 仅承载） |

### 3.1 各 payload 字段速览（细节见对应 T 项草案）

#### 3.1.1 `announce` payload

```
{
  "domain": <被宣告的域名, ASCII>,
  "record_type": <A | SRV | TXT(did:dns:)>,
  "content": <IP / host:port / did:dns: 串>,
  "did_dns": <did:dns:v=1;... 身份声明串, 引用 did-dns-protocol.md §2.1>,
  "expires_at": <过期时间 Unix 秒 | null>
}
```

> **依据:** 节点 02 篇 §3.3 `announce` 包（`v, domain, record_type, content, did_dns, signature, ttl`），好友收到后写入 `dns_hosts(source='friend')` 并按 `ttl` 过期（FR5/FR9）。

#### 3.1.2 `count` payload（语义归 T8，本文件仅承载）

```
{
  "counter_value": <整数, 节点本地计数值或回执聚合值, 语义见 T8>,
  "timestamp": <Unix 秒>,
  "consensus_flag": <bool, 是否已达共识阈值（开关传播，见 T8）>
}
```

> **协议新增说明:** 节点 02 篇**当前无 `count` 包实现**（FR 表无此项），属协议层为引导期计数防投毒新增；节点本地计 1 还是回执聚合由 T8 定稿明确。

#### 3.1.3 `query` payload

```
{
  "qname": <待解析域名, ASCII>,
  "qtype": <A | SRV | TXT(did:dns:)>,
  "requester_domain": <请求方域名, ASCII, 同 src_domain 或经代理>
}
```

> **依据:** 节点 02 篇 §3.2/§3.3 `query` 包（`v, qname, ttl, query_id, nonce, requester_domain, forward_chain[]`），非广播好友链泛洪（FR6）。

#### 3.1.4 `answer` payload（候选 schema 归 T4）

```
{
  "candidates": [
    {
      "domain": <域名>,
      "record_type": <A | SRV | TXT>,
      "content": <IP / host:port / did:dns: 串>,
      "ttl": <候选 TTL 秒>,
      "expires_at": <过期 Unix 秒 | null>,
      "source": <manual | friend | flood>,
      "trust_weight": <-127~100, 引用 T3>,
      "hops": <该候选经过的转发跳数>
    }
  ],
  "trust_weight": <路径权重 = min(链上各转发者权重), 引用 T3>,
  "hops": <回传路径总跳数>
}
```

> **依据:** 节点 02 篇 §3.3 `answer` 包（`v, query_id, qname, candidates[], trust_weight, forward_chain[]`），候选 schema 字段与 02 篇 `dns_resolve_cache.candidates` JSON 对齐（T4 定稿排序键 `(trust_weight DESC, hops ASC, TTL DESC)`）。

#### 3.1.5 `publish` payload（语义归内容发布域，T1 仅承载）

```
{
  "content_ref": <内容引用, 编码格式归内容发布域>,
  "content_type": <内容类型枚举, 内容发布域定>
}
```

> **配额:** `publish` 计入每日 3 次用户自主泛洪配额（§0 决策 + FR11）；内容发布的 T 项编号与字段定稿不在 T1 范围，T1 仅承诺信封承载位。

---

## 4. TTL（跳数）与 fanout（出度）

### 4.1 跳数上限（TTL）

| 包类型 | 跳数上限 | 依据 |
|---|---|---|
| `announce`（入网宣告广播） | **15** | §0 决策「入网宣告 15 跳广播泛洪」 |
| `count`（计数泛洪） | T8 定（引导期阀门，跨节点聚合所需跳数） | T8 |
| `query`（解析查询） | **≤6** | 节点 `dns_flood_max_hops=6`（02 篇 FR6/§5.3），六度分隔 |
| `answer`（解析应答） | **≤6** | 与 query 同链 |
| `publish`（内容发布） | **≤6** | 02 篇 FR6 同构（受限泛洪非广播） |

**转发规则（好友节点收到包时）:**

1. **限频**: 每好友入站 ≤30 次/分（02 篇 FR11），超限静默丢弃。
2. **防环**: `forward_chain` 含自身域名 → 丢弃（见 §5）。
3. **跳数检查**: `ttl ≤ 0` → 停止转发（仅本地处理或回传，不再扩散）。
4. **本地命中**: 查询类（query）本地命中则回传 `answer`，未命中则 `ttl-1` 转发给未拉黑好友。
5. **均无响应**: 均无应答时静默不响应（02 篇 §3.2）。

### 4.2 fanout（出度上限）

- **默认值 16**：单次转发最多发给 ≤ `dns_flood_fanout=16` 个未拉黑好友（02 篇 FR6/§5.3）。
- **选择策略**: 优先选择 `trust_weight` 较高的好友（T3 定义权重排序），NAT 后节点或好友数 <16 时按实际好友数。
- **配额扣减**: 仅**用户自主泛洪**（`publish` / 用户触发的 `count`）扣减每日配额；系统类（`announce` / `query` / `answer`）不扣减配额（02 篇 FR11）。

---

## 5. `forward_chain` 转发链（防环）

### 5.1 结构

- `forward_chain` 是一个**有序域名数组**，初始为 `[src_domain]`（发起方域名）。
- 每个转发者在转发前**追加自身域名**到链尾：`forward_chain = [...forward_chain, self_domain]`。
- 回传类包（`answer`）保留查询链的 `forward_chain`，沿链逆向回传。

### 5.2 防环规则（与节点 FR6 一致）

| 规则 | 说明 |
|---|---|
| **自身已在链 → 丢弃** | 转发者检查 `forward_chain.includes(self_domain)`，命中则丢弃该包（防环） |
| **重复 query_id + nonce → 丢弃** | 同一 `query_id` 已处理过（去重表命中）则丢弃（防重放/重复扩散） |
| **链长度 ≥ ttl + 1 → 丢弃** | 链长度（含发起方）超过跳数上限说明异常环路，丢弃 |
| **拉黑节点（-127）不出现在链/不转发** | T3 黑名单节点不转发其包、不响应其查询（02 篇 FR7/FR11） |

### 5.3 签名覆盖（引用 T9）

`forward_chain` **MUST 纳入签名覆盖范围**（T9 §9.3.2 第 4 项），防转发链篡改/注入。**T9 已会签定稿（KNET-CC-011，2026-08-08）——P-FLOOD 引用不重定义**——签名算法、规范化规则、覆盖字段顺序归 P-ARCH 定稿，本文件不重定义。

---

## 6. 末端回传语义

### 6.1 解析查询的末端行为（query/answer）

- 本地命中（`dns_hosts` 未过期）→ 回传 `answer`（沿 `forward_chain` 逆向或直接回 `src_domain`）。
- 本地 miss 且 `ttl-1 > 0` → 追加自身域名到 `forward_chain`，转发给未拉黑好友。
- 本地 miss 且 `ttl-1 ≤ 0`（已到跳数上限）→ **静默不响应**（不回传空 answer，02 篇 §3.2「均无则静默不响应」）。
- 等待窗口 `dns_query_timeout_ms=2000ms`：发起方聚合 `query_id` 对应的所有 `answer`，多候选排序后写入缓存并返回（02 篇 FR6）。

### 6.2 入网宣告的末端行为（announce）

- 好友收到 `announce` → 写入 `dns_hosts(source='friend')`，按 `payload.expires_at` 过期。
- `ttl-1 > 0` 且未在 `forward_chain` → 继续转发给未拉黑好友（15 跳广播，§0 决策）。
- **不回传**（`announce` 是单向广播，无 answer）。

### 6.3 计数泛洪的末端行为（count）

- 末端行为（本地计数 + 回执聚合 vs. 纯转发）**归 T8 定稿**（02 篇当前无 `count` 实现，属协议新增）。
- T1 承诺：`count` 包的信封字段（`query_id`/`nonce`/`forward_chain`/`signature`）与解析类一致，T8 定义其阈值（1000 万）、共识时间戳、开关传播。

---

## 7. 签名与防伪（引用 T9，不重定义）

> **本节为引用层，不重定义签名覆盖范围。** 签名算法、挑战码结构、覆盖字段、规范化规则、HPKE 分工全部归 T9（`DECISIONS.md` §9.3 + `did-dns-protocol.md` §3.5 + `im_protocol.md` §7.4 + `security_model_v1.md` §7.2.1），**引用 T9·已会签定稿（KNET-CC-011，2026-08-08）**。

### 7.1 签名覆盖范围（引用 T9 §9.3.2）

泛洪包的 `signature` 字段（Ed25519，64 字节，Base64URL）覆盖以下字段（T9 §9.3.2 MUST 覆盖项）：

1. **挑战码明文 `challenge`**（即信封 `nonce` 对应的 `nonce:timestamp:hmac` 结构，T9 §9.3.1）。
2. **校验方域名**（请求来源 `requester_domain` 或回传目标）。
3. **受验方域名**（`src_domain`，绑定 `did:dns:v=1` 身份声明）。
4. **泛洪 `forward_chain`**（本文件 §5 转发链，防转发链篡改/注入）。
5. **T3 权重字段**（`trust_weight` / `weight`，T3 草案，防权重篡改）。

**MUST NOT 覆盖**（T9 §9.3.2）：传输层元数据（HTTP 头、TLS 证书、IP 地址）—— 由传输层（HTTPS/TLS）保证。

### 7.2 与 HPKE 通道的分工（引用 T9 §9.3.3）

| 场景 | 优先通道 |
|---|---|
| 自动登录 / 首次接触 / TOFU | HPKE 解密端点（`did-dns-protocol.md` §3.2，抗投毒更强） |
| 已有公钥 / 好友链 / IM 信任权重 | **签名质询-应答**（本文件泛洪包走此通道） |
| 高安全场景 | 两通道交叉验证 |

### 7.3 密钥体系（架构红线）

- **统一 Ed25519**（签名 + 指纹）；禁 RSA / secp256k1 / RSA-OAEP 新引用（§0 决策 + DECISIONS §9.2.3）。
- 加密场景 Ed25519 → X25519 转换 + HPKE（RFC 9180），与本泛洪包的签名通道**并存**（T9 §9.3.3）。

---

## 8. 配额与防滥用（与节点 FR11 一致）

| 规则 | 值 | 说明 |
|---|---|---|
| 每日用户自主泛洪配额 | **3 次**（`dns_flood_quota_daily=3`） | `publish`（内容发布）+ 用户触发的 `count` 计入；`announce`/`query`/`answer` 不计入 |
| 超限处置 | 自动拉黑 -127（T3 黑名单） | 超限节点不转发其包、不响应其查询 |
| 入站限频 | 每好友 30 次/分 | 超限静默丢弃（02 篇 FR11） |
| 防重放 | `query_id` + `nonce` 去重表 | TTL 窗口内同一组合二次到达 → 丢弃（T9 §9.3.1 一次性约束） |

> **去中心化纪律:** 配额与限频是**节点本地**行为（每节点自跑、不依赖中心化网关），符合 §6「去中心化原则·不需要限流（每个用户自跑节点）」—— 这里的「限流」指中心化网关限流，节点本地的好友级入站限频是拓扑约束的一部分，不违反去中心化纪律。

---

## 9. 传输承载

| 通道 | 状态 | 说明 |
|---|---|---|
| HTTPS 直连好友端点（`POST /api/dns/query`） | **v1 主通道** | 02 篇 §3.3 现状，HTTPS 直连好友节点 HTTP 端点 |
| WS 常驻通道（8082） | 规划（E06） | 落地后优先走 WS（总览 9.9）；v1 先走 HTTP POST |
| 强制加密 DNS | MUST | 身份记录解析走 DoH/DoT，禁明文 53（架构红线 + 02 篇 NFR） |

---

## 10. 自测门禁（交付前自查）

| # | 门禁项 | 本草案结论 |
|---|---|---|
| T1-1 | 包类型与节点 02 篇 §3.3（query/answer/announce 三类）双向核对一致 | ✅ §3 三类字段与 02 篇 §3.3 对齐；新增 `count`/`publish` 标注「协议新增/承载位」 |
| T1-2 | `forward_chain` 防环规则与节点 FR6 一致 | ✅ §5（自身在链丢弃 / query_id 去重 / 链长 ≥ ttl+1 丢弃 / 黑名单不转发） |
| T1-3 | 入网宣告 15 跳、解析 ≤6 跳、fanout 上限与节点参数对齐 | ✅ §4（announce=15, query/answer/publish=≤6, fanout=16） |
| T1-4 | 签名覆盖范围引用 T9 不重定义 | ✅ §7 全节标注「引用 T9·已会签定稿（KNET-CC-011）」；算法/覆盖字段/规范化均归 P-ARCH |
| T1-5 | 配额口径（每日 3 次、超限 -127）与节点 FR11 一致 | ✅ §8 |
| T1-6 | `grep -ri aura` 零残留 | ✅（草案内零 aura，端点/品牌均 kirin） |
| T1-7 | 引用编号一致（FR6/FR11/T1/T9/9.3.2） | ✅ |

---

## 11. 会签状态与遗留项

| 项 | 归属 | 状态 |
|---|---|---|
| 签名覆盖范围（算法/字段/规范化） | T9 / P-ARCH | **引用 T9·已会签定稿（KNET-CC-011，2026-08-08）** |
| `count` 包语义/阈值/共识时间戳/开关 | T8 / P-FLOOD | T8 草案（依赖本 T1 信封） |
| T3 权重字段在签名覆盖内的命名（`weight` / `trust_score`） | T3 / P-FLOOD + T9 会签对齐 | T3 草案（引用 T9） |
| `publish` 包字段定稿 | 内容发布域 | T1 仅承载 |
| T6 阶段二社交信任链算法 | PR-DDNS（波 2） | 不在 T1 范围 |
| 钱包地址编码 | T2 | 不在本文件定义 |

---

## 12. 版本与变更

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-08-08 | P-FLOOD 首版草案：泛洪信封（§2 公共字段）+ 五类包类型（§3，含 announce 15 跳广播 / count 计数 / query+answer 解析 ≤6 跳 / publish 内容发布）+ TTL/fanout（§4，对齐节点 `dns_flood_max_hops=6`/`dns_flood_fanout=16`）+ `forward_chain` 防环（§5）+ 末端回传语义（§6）+ 签名覆盖引用 T9（§7，不重定义）+ 配额口径（§8，每日 3 次/超限 -127）。**未会签·单边定稿无效**。 |

---

*本文件为 T1 泛洪协议草案 v0.1，是 T3/T4/T6/T8 的共同承载层。强制会签项，须经节点 PM 会签（KNET-CC）后方可标「定稿」。签名覆盖范围引用 T9（`DECISIONS.md` §9.3.2）不重定义。*
