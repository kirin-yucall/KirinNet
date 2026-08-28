# KirinNet 关键决策记录 — 协议

> 整理自 2026-07-09 ~ 2026-07-10 对话 + 2026-08-01 需求对齐。记录协议层架构决策、命名变更、设计取舍。
> **节点相关决策（存储/Docker/认证/探索系统）已随 Node 仓库迁移至 [kirin-yucall/KirinNet-Node](https://github.com/kirin-yucall/KirinNet-Node)。**

---

## 0. 需求对齐决策（2026-08-01，含 v2/v3/v4 变更）

| 决策 | 结论 |
|---|---|
| 密钥体系 | **统一 Ed25519**（签名 + HPKE 加密，公钥加密/私钥解密等价 RSA）；IM 与好友层同步统一 |
| TXT 格式 | **全量迁移 `did:dns:`**，废弃旧格式（`id=;key=;nick=`） |
| 协议一体 | **身份 + 发布 + IM 为同一协议** |
| **身份模型（v2→v4）** | **双模式身份，无全网分界**：可发布域名以前**域名即身份**（公钥放传统 DNS TXT）；可发布域名以后**钱包私钥即身份**（XRP 优先，公钥放分布式 DNS TXT）；两种模式长期共存，节点自行演进 |
| **身份验证（v4）** | 统一为**签名质询-应答**（发随机信息 → 私钥签名 → 公钥验签）；**HPKE 加密挑战 + 解密端点保留原方案并存** |
| **域名归属（v2）** | 由**去中心化节点群的信任权重**决定；同名域名**多候选 + 权重排序**；**纠纷留给法律** |
| **引导期计数（v3 恢复）** | 域名发布走**计数泛洪**防投毒；计数达 **1000 万** → **多点协商**共识时间戳 → **全网开启开关，不再返回计数包**（计数仅限引导期） |
| **VDF（v3 暂存）** | 共识时间戳保留，作为**发布时序裁定依据**（用户裁定）；VDF 机制暂存待用；信任权重分后续关联**节点商城交易模块** |
| **信任权重体系（v3）** | **IM 列表**（好友 + 常用网址）手动维护权重；好友间权重不同；**转发链天然带权重分**；冲突由**用户决策评分**；**钱包级负权重**降低解析分数 → 社交节点自我修复的**防污染解析** |
| 泛洪规则 | 入网宣告 15 跳广播泛洪；解析/发布为好友链泛洪（非广播）；每节点每天 **3 次**用户自主泛洪配额；超限进 IM 黑名单（信任权重 -127，不转发/不响应） |
| 分布式 DNS | **IM = 分布式 DNS**：双通道更新（DNS 服务商 + IM 好友消息），好友链泛洪 + 六度分隔解析，本地映射表基于 IM 列表（轻量化） |
| 内容发布 | 走受限泛洪（计入 3 次配额） |
| DNS 服务商 | 12 家扩展为 **15 家**；引导期依赖 + 长期并行兜底（不消灭传统 DNS，互操作务实） |
| IM 协议 | 端点 `/aura/*` 改 `/kirin/*`；密钥 Ed25519 + HPKE；**PFS 纳入 v1** |
| SDK | 保持 15 语言宣称，需求设计完成后实现 |
| 标准化 | **暂缓 IETF 提交**，先完善协议与实现 |
| **DNS 解析安全（新增）** | **强制 DoH/DoT（必须项）**：身份记录解析禁止明文 53，明文返回的身份记录拒绝/降级告警；TOFU 首次接触警示；跨通道交叉验证；自动登录优先 HPKE 解密端点通道（威胁分析见 `security_model_v1.md` 第七章） |

---

## 1. 命名与品牌

| 决策 | 内容 |
|---|---|
| 项目名 | KirinNet（麒麟网），取自用户名字音译 |
| 协议名 | KirinDNS (ADRP) |
| 包名 | `kirin-dns`（PyPI / npm） |
| 组织 | `kirin-yucall`（GitHub） |
| 旧名 | AuraDNS / AuraNet（已全量替换，仍有残留见下） |

---

## 2. 协议：TXT vs SRV 未完结

**2026-07-10 审计结论**：
- 所有文档（spec、IETF draft、im_protocol）仍描述 TXT 记录
- 所有代码实现未使用 SRV
- 声称的 TXT→SRV 转换实际未执行
- 此问题待用户决策（SRV 存端口、TXT 存身份的双记录模型为既定方向）

---

## 3. SDK：15 语言客户端库

| # | 语言 | 状态 |
|---|---|---|
| 1 | JavaScript | ✅ 已测试，npm 已发布 |
| 2 | Python | ✅ 已测试，PyPI 已发布 |
| 3 | Go | ✅ 语法通过，GitHub: kirin-yucall/kirin-dns-go |
| 4 | Rust | ✅ 语法通过，GitHub: kirin-yucall/kirin-dns-rs |
| 5 | C | ✅ 已测试（gcc） |
| 6 | C++ | ✅ 已测试（g++17） |
| 7-15 | C#/Java/Kotlin/Dart/Ruby/Swift/PHP/Lua/TypeScript | 语法通过，待实测 |

---

## 4. IETF 标准化

- 已生成 `draft-kirin-yucall-kirindns-adrp-00.txt`
- 因 TXT/SRV 未定，尚未提交
- 占位日期需替换真实值后提交

---

## 5. 安全模型

- 两阶段好友请求（请求不含密钥，接受后交换公钥）
- 政府 CA 仅证明"物理身份=域名"，不做信任推荐
- 攻击单节点 = 物理攻击一个人的代价
- 粉丝公钥加密推送，端到端不可窃听
- 分布式入侵检测（心跳信号+流量骤降）

---

## 6. 去中心化原则

- 不需要限流（每个用户自跑节点）
- 域名 = 身份，DNS = 信任锚点
- 客户端 DOH 验证

---

## 7. 文档规范

- 文档通过 patch 逐节迭代（不整篇重写）
- 中文文档，中文注释
- API 路径/变量名/注释必须用 `kirin`（零 `aura` 引用）

---

## 8. 遗留问题（待处理）

- `im_protocol.md`、`04_Chromium_Browser/` 仍含 `aura` 品牌残留（协议仓库，需替换为 `kirin`）
- `01_Standard/spec_v1.md` 与 `did-dns-protocol.md` 的密钥体系/TXT 格式冲突（已决策统一，待修订文档）
- `01_Standard/dns_automation.md` 服务商数待更新（12 → 15 家）
- `01_Standard/compatibility.md` 为空文件（填充或删除）
- 泛洪消息格式、VDF 算法、多点协商、信任权重体系等细节待协议设计阶段细化

---

## 9. P-ARCH 裁决记录（2026-08-08，波 0）

> **裁决人:** P-ARCH 协议契约架构师
> **裁决性质:** 协议契约层技术裁决（结论交 P-DOC 执笔改写、P-FLOOD 草案引用、X-QA 验收）
> **追溯依据:** `需求设计文档.md` v1.5 §6.1（身份模型）/§6.8（加密原语）/§9.2·§9.3（spec_v1 迁移决策）+ §0（统一 Ed25519/全量 did:dns:/强制 DoH-DoT 决策表）
> **基线文件:** `01_Standard/did-dns-protocol.md` v1.0（C-1 裁决基线）
> **执行纪律:** P-DOC 按 9.2/9.3 执笔逐节改写 `spec_v1.md`；T9 定稿经节点 PM 会签（KNET-CC）后方可标定稿；本节裁决不替代 P-DOC 执笔。

### 9.1 架构红线 checklist（波 0 巡检，2026-08-08 21:30）

> 巡检范围：`KirinNet\01_Standard\*` 全集 + IETF 草案 00/01。基线：`需求设计文档.md` §0 + `did-dns-protocol.md` v1.0。

| # | 红线项 | 巡检结论 | 残留位置 | 处理口径 |
|---|---|---|---|---|
| R1 | Ed25519 唯一（secp256k1/rsa/RSA-OAEP/RSA-4096 零新引用） | ⚠ 残留（均属待迁移文档本体，非新引用） | secp256k1：`spec_v1.md` 行 169/179、`draft-01.txt` 行 262/275；RSA：`im_protocol.md` 全篇（RSA-4096/RSA-OAEP）、`security_model_v1.md` §1.1/2.x/3.x（RSA 密钥对/签名/哈希） | spec_v1 由 P-DOC 按 §9.2/§9.3 迁移；im_protocol + security_model 按 `需求设计文档` §6.5/§6.6 改造（P-DOC 主笔）；draft-00/01 标「已废弃·暂缓」 |
| R2 | aura 零残留 | ⚠ 残留（im_protocol 10 处 `/aura/*`） | `im_protocol.md` 行 21/32/46/49/68/92/115/141/165/244 | 与 §0「改名 /kirin/*」决策冲突；P-DOC 改造 im_protocol 时一并替换（KNET-CC-002 节点侧同步） |
| R3 | TXT 全量 `did:dns:` | ✅ PASS（spec_v1 §3.2.1 是唯一旧格式残留，C-1 裁决对象） | 旧 `id=;key=;nick=` 仅见于 spec_v1 §3.2.1（待 C-1 迁移） | 见 §9.2 C-1 裁决 |
| R4 | 强制 DoH/DoT（MUST/MUST NOT，RFC 2119） | ✅ PASS | spec_v1 §3.3.1/§4.3 + draft-00/01 表述正确（MUST be sent over encrypted DNS transport；MUST NOT be used UDP/TCP 53） | 维持现状；did-dns §3.4 与 security_model §7.3 的「明文 53 拒绝/降级告警」须 P-DOC 在 spec_v1 §4.3 补强 fail-closed 表述 |
| R5 | 单条 TXT ≤200 字节 | ✅ PASS（实测） | did:dns 新格式三类记录：身份声明 73B / 公钥 69B / 黑名单（2 指纹）44B | 见 §9.2.4 核算；旧 secp256k1 格式 196B 已逼近 255 RDATA 上限，迁移必要性成立 |
| R6 | fail-closed 默认值显式标注 | ⚠ 部分缺失 | security_model §7.3 已有「拒绝/降级告警，不得静默采信」；did-dns §3.4「强制 HTTPS」；spec_v1 §4.2 DNSSEC 失败有 RECOMMENDED fallback | P-DOC 须在 spec_v1 §4 补「明文 53 → 拒绝（fail-closed）」与「DNSSEC 失败 → 默认 fail-closed，例外经 KNET-CC」 |

**checklist 总结:** R3/R4/R5 PASS；R1/R2/R6 残留均集中在待迁移文档（spec_v1 / im_protocol / security_model），无新引用违规。本 checklist 作为 X-QA 验收基线。

### 9.2 C-1 裁决：spec_v1 §3.2.1 迁移到 `did:dns:` + Ed25519 的口径

> **裁决对象:** `spec_v1.md` §3.2.1（行 156-200，旧式 `id=<uuid>;key=<hex>;nick=<name>[;ipfs=<bool>]` + secp256k1 注释行 179）与 §3.2.2/§3.3.2 的旧格式识别逻辑（`id=` + `key=` 前缀扫描）。
> **裁决基线:** `did-dns-protocol.md` §2（`did:dns:v=1;fp=…;n=…;g=…;iat=…;exp=…` + `did:dns:pk;kty=ed25519;pk=…` + `did:dns:black;fp=…`）。
> **追溯:** `需求设计文档.md` §9.2「TXT 格式两代·已决策全量迁移 did:dns:」+ §9.3「spec_v1 落后于 did-dns·已决策以 did-dns 为基线」+ §6.1 记录定义表。
> **结论:** 以 did-dns-protocol.md 为基线，spec_v1 §3.2.1 整节迁移，旧字段按下表映射。

#### 9.2.1 裁决结论

- spec_v1 §3.2.1（身份 TXT 格式）**整体作废重写**为 did-dns 三记录模型；旧单记录 `id=;key=;nick=` 不保留兼容（全量迁移，§0 已决策）。
- §3.2.2（与其他 TXT 共存）的「扫描 `id=` + `key=` 前缀识别身份记录」逻辑**作废**，改为「扫描 `did:dns:` 前缀按 v/pk/black 三类分类提取」（与 did-dns §6 + dns_automation §3 一致）。
- §3.3.2（身份解析流程）的「SplitOnSemicolon + 识别 id=/key=/nick=/ipfs」**作废**，改为「按前缀分类 → 解析指纹链 → 校验 fp = Base64URL(SHA-256(pk)[0:12])」（与 did-dns §3 一致）。
- §2.3（Identity TXT Record 定义）术语更新为 DID-DNS 三记录。
- §4.3（加密 DNS 传输）维持 MUST/MUST NOT 表述，并补强「明文 53 返回的身份记录拒绝/降级告警」（fail-closed，与 security_model §7.3 一致）。
- IANA §6.2（TXT Record Format）补注「格式定义见 did-dns-protocol.md」，避免两处定义。

#### 9.2.2 字段映射表（旧 → 新，供 P-DOC 执笔）

| 旧字段（spec_v1 §3.2.1） | 新记录 + 新字段（did-dns §2） | 映射说明 |
|---|---|---|
| `id=<uuid\|did>` | `did:dns:v=1` 记录本身（身份锚点改由域名 + 指纹链承载） | **废弃独立 id 字段**；身份唯一性由「域名 + fp 指纹链」保证（与 §6.1「域名即身份/钱包私钥即身份」双模式一致）。UUID 不再单列。 |
| `key=<hex_public_key>` (secp256k1 130hex) | `did:dns:pk;kty=ed25519;pk=<Base64URL>` | **secp256k1 → Ed25519**（§0 决策）；编码 hex → Base64URL；32 字节公钥 → 约 43 字符，单条 69 字节（远低于 200） |
| `nick=<nickname>` (明文) | `did:dns:v=1` 的 `n=<Base64URL(UTF-8)>` | 昵称改入身份声明记录，编码 Base64URL（非明文，与 did-dns §2.1 一致） |
| `ipfs=<bool>` | （废弃） | ipfs 字段在 did-dns 基线无对应；如需保留 IPFS 网关指示，走 SRV 扩展名 `_kirinnet-ipfs._tcp`（dns_automation §9 已预留），不在 TXT 身份记录中 |
| （无） | `did:dns:v=1` 新增 `fp=<Base64URL(SHA-256(pk)[0:12])>` | **指纹链**（新增，核心）：建立身份声明→公钥的防篡改绑定 |
| （无） | `did:dns:v=1` 新增 `g=<M/F/O/X>` | 性别（单字母，可选） |
| （无） | `did:dns:v=1` 新增 `iat=<unix秒>` / `exp=<unix秒>` | 时间窗（防重放旧记录，新鲜度检查 ±5 分钟，与 did-dns §3.3 一致） |
| （无） | `did:dns:black;fp=…,…` | 黑名单（新增，可选）：撤销旧公钥指纹，密钥轮换机制 |

#### 9.2.3 Ed25519 迁移口径（C-3 协议侧依据）

- 协议侧统一 **Ed25519**（签名 + 指纹）；加密场景 Ed25519 → X25519 转换 + HPKE（RFC 9180）。
- 公钥：32 字节，Base64URL 编码约 43 字符；指纹 `fp = Base64URL(SHA-256(完整公钥)[0:12])`，16 字符。
- **禁 RSA/secp256k1 新引用**（§0）；spec_v1 §3.2.1 行 179 的「RECOMMENDED key type is secp256k1」删除。
- 此口径作为 **C-3（节点 spec.md §6.2 RSA-OAEP→Ed25519）的协议侧依据**，C-3 经 KNET-CC-002 流转，节点 PM 会签后修订。

#### 9.2.4 单条 TXT ≤200 字节核算（实测）

| 记录 | 示例 | 字节数 | 限 |
|---|---|---|---|
| 身份声明 | `did:dns:v=1;fp=AbCdEf1234aaaa;n=QWxpY2U;g=F;iat=1712345678;exp=1712432078` | **73** | 200 ✅ |
| 公钥（Ed25519，43 字符） | `did:dns:pk;kty=ed25519;pk=MCowBQYDK2VwAyEA…（43 字符）` | **69** | 200 ✅ |
| 黑名单（2 指纹） | `did:dns:black;fp=OldKeyFp1aaaa,OldKeyFp2aaaa` | **44** | 200 ✅ |
| （对照）旧 secp256k1 单记录 | `id=<uuid36>;key=04<128hex>;nick=Alice;ipfs=false` | **196**（逼近 255 RDATA 上限） | 255 ⚠ |

**结论:** 新格式三类记录单条 44-73 字节，远低于 200 上限，规避 UDP 分片；旧格式 196 字节已逼近 255 RDATA 上限（且 secp256k1 公钥更长易超），迁移必要性技术成立。

#### 9.2.5 P-DOC 执笔依据（编号 9.2/9.3）

- P-DOC 按 §9.2.1-§9.2.4 执笔改写 `spec_v1.md` §2.3/§3.2.1/§3.2.2/§3.3.2/§4.3/§6.2（patch 逐节迭代，中文）。
- 改写后跨文件一致性自查：spec_v1 ↔ did-dns-protocol ↔ dns_automation ↔ im_protocol ↔ security_model 的 TXT 字段/密钥类型/指纹算法/端点路径逐项一致。
- IETF 草案 draft-00/01 标「已废弃·暂缓」（§0 决策），不随 spec_v1 同步迁移，待协议成型后按新基线重写。

### 9.3 T9 签名质询技术定稿口径（草案·待 KNET-CC 会签标定稿）

> **裁决人:** P-ARCH（技术定稿主笔）
> **追溯:** `需求设计文档.md` §6.1（签名质询-应答）+ §6.8（加密原语）+ §6.9 T9（随机信息格式 + 签名覆盖范围 + HPKE 分工）。
> **基线:** `did-dns-protocol.md` §3.3（60s TTL + 挑战码绑定域名）+ `security_model_v1.md` §7.2（HPKE 通道抗投毒分工表）。
> **状态:** **技术口径定稿**；强制会签项，须经节点 PM 会签（KNET-CC）后方可标「定稿」；未会签前 P-FLOOD T1/T3/T4/T6/T8 草案引用本口径时须标注「引用 T9 草案·未会签」。

#### 9.3.1 随机信息格式（Nonce + 时间戳防重放）

- **挑战码结构（与 did-dns §3.3 / §4.2 参考实现一致）**：`c = <nonce>:<timestamp>:<hmac>`
  - `nonce`：6 位随机数字（10^6 空间，单域名 + 时间窗内冲突可忽略），由校验方 CSPRNG 生成。
  - `timestamp`：Unix 秒（整数），校验方生成时的当前时间。
  - `hmac`：`Base64URL(HMAC-SHA256(secret, "<domain>:<timestamp>:<nonce>"))[0:12]`，绑定域名（防跨站重放）。
- **TTL（防重放窗口）**：**60 秒**（MUST，与 did-dns §3.3 第 1 条一致）；超过 60s 的应答 MUST 拒绝。
- **一次性**：校验方 MUST 维护已用 nonce 去重表（TTL 窗口内），同一 nonce 二次应答 MUST 拒绝。
- **新鲜度（DNS 记录侧）**：`did:dns:v=1` 的 `iat` 与当前时间偏差 MUST 在 ±5 分钟内（与 did-dns §3.3 第 4 条一致），防重放旧 DNS 记录。

#### 9.3.2 签名覆盖范围（签什么 / 不签什么）

- **MUST 覆盖（签名输入）**：受验方用 Ed25519 私钥对以下字段的规范化序列化字节签名：
  1. **挑战码明文 `c`**（`nonce:timestamp:hmac` 整体）—— 防篡改 + 防重放。
  2. **校验方域名**（请求来源）—— 防跨域重放。
  3. **受验方域名**（身份声明主体）—— 绑定 `did:dns:v=1` 身份声明。
  4. **泛洪 `forward_chain`（转发链）**—— P-FLOOD T1 草案的转发链字段 MUST 纳入签名覆盖范围（防转发链篡改/注入，P-FLOOD 引用本口径，不重定义）。
  5. **T3 权重字段**（`trust_weight`, int8 -127~100）—— P-FLOOD T3 草案的信任权重字段 MUST 纳入签名覆盖范围（防权重篡改，P-FLOOD 引用本口径）。
- **MUST NOT 覆盖**：传输层元数据（HTTP 头、TLS 证书、IP 地址）—— 这些由传输层（HTTPS/TLS）保证，不重复签名。
- **签名算法**：Ed25519（64 字节签名），输出 Base64URL（约 86 字符）。
- **规范化规则（防编码歧义）**：覆盖字段按固定顺序拼接，字段间用 `\n` 分隔；JSON 场景按 JCS（RFC 8785）规范化后再签名。

#### 9.3.3 与 HPKE 通道分工（security_model §7.2 基线）

| 通道 | 机制 | 抗 DNS 投毒 | 适用场景 | 定位 |
|---|---|---|---|---|
| **签名质询-应答**（本节 T9） | 校验方发挑战码 → 受验方 Ed25519 私钥签名 → 校验方公钥验签 | 弱（依赖公钥已正确获取） | 已有信任背书（好友链/IM 列表/已验证公钥）的场景 | 通用身份验证原语 |
| **HPKE 加密挑战**（did-dns §3） | 校验方 HPKE 加密挑战码 → 受验方私钥解密 → 比对 | 中（攻击者须同时伪造 TXT 公钥 + SRV 端点） | 自动登录、首次接触、TOFU 场景 | 自动化优先通道 |

- **分工边界**：两者**并存**（§0 + §6.1 决策），非互斥。
  - 自动登录 / 首次接触 / 无好友背书 → **优先 HPKE 解密端点通道**（`POST /.well-known/did-dns/decrypt`，抗投毒更强）。
  - 已有公钥 / 好友链 / IM 信任权重场景 → **签名质询-应答**（无需往返解密端点，轻量）。
  - 高安全场景（如智能体间合约）→ **两通道交叉验证**（HPKE 通道 + 签名质询都通过才放行）。
- **PFS（前向保密）**：IM v1 会话密钥 ECDH 轮换纳入 v1（§6.5）；HPKE 通道每次生成临时 X25519 密钥对（did-dns §3.2 步骤 6），天然具备单次会话 PFS；签名质询本身不提供 PFS（依赖会话层）。

#### 9.3.4 P-DOC / P-FLOOD 落点

- **P-DOC 落章节**：T9 技术口径由 P-DOC 落到 `did-dns-protocol.md`（§3 自动验证流程补签名质询子节）+ `im_protocol.md`（§7 安全模型补签名覆盖范围）+ `security_model_v1.md`（§7.2 分工表补 T9 引用）。
- **P-FLOOD 落点**：T1（泛洪消息格式）的 `forward_chain` 字段 + T3（信任权重体系）的 `trust_weight` 字段，**引用 §9.3.2 签名覆盖范围**，不重定义；P-FLOOD 草案标注「引用 T9 草案·未会签·单边定稿无效」。
- **会签要求**：T9 须经节点 PM 会签（KNET-CC，影响节点实现侧的签名/验签代码）后方可标「定稿」；未会签前本节为「技术定稿口径（草案）」。

#### 9.3.5 变更说明：权重字段名钉死 `trust_weight`

> **变更编号:** T9·KNET-CC-011·波0（会签前阻断项）
> **裁定依据:** E2 复核发现（字段名歧义）+ PM 裁定 2026-08-09
> **变更内容:** §9.3.2 第 5 项与 §9.3.4 P-FLOOD 落点的 T3 权重字段名统一钉死为 `trust_weight`（int8, -127~100）；废弃旧歧义表述 `weight` / `trust_score`。
> **钉死理由:** 签名覆盖范围是跨实现强一致契约（§9.3.2 已规定 JCS 规范化签名，字段名须固定，否则跨节点验签失败）；向节点 02 篇实现基线对齐（`dns_hosts.trust_weight` / `contacts.trust_weight` / `answer.trust_weight` 全量统一）；与 T1/T3/T4/T8 四草案正文统一。语义自明——`trust_weight` 优于无修饰的 `weight`（易与 SRV weight 混淆），优于 `trust_score`（score 暗示浮点而 T3 明定 int8）。

### 9.4 裁决交付物清单（交 P-DOC / P-FLOOD / X-QA）

| 交付物 | 接收方 | 用途 | 关联编号 |
|---|---|---|---|
| §9.1 架构红线 checklist | X-QA | 验收基线 | 波0·红线 |
| §9.2 C-1 裁决（字段映射 + Ed25519 迁移 + 200B 核算） | P-DOC | 执笔改写 spec_v1 §2.3/§3.2.1/§3.2.2/§3.3.2/§4.3/§6.2 | C-1·9.2·9.3 |
| §9.2.3 Ed25519 统一口径 | 节点 PM（经 KNET-CC-002） | C-3 节点 spec.md §6.2 RSA-OAEP→Ed25519 修订依据 | C-3 |
| §9.3 T9 技术定稿口径（草案·待会签） | P-DOC / P-FLOOD / 节点 PM（会签） | T9 定稿；P-FLOOD T1/T3 草案引用签名覆盖范围 | T9·T1·T3 |
| §9.3.3 HPKE 分工表 | P-DOC | 落 did-dns §3 / im_protocol §7 / security_model §7.2 | T9·波0 |

> **后续:** ① 释放 DECISIONS.md 锁；② 回填 `docs\协作记录.md` §COM-04+；③ git 提交（提交信息含 C-1·9.2·9.3·T9·波0）；④ 登记待协议 PM 验收放行（X-QA 独立验收：架构红线 checklist + 跨文件一致性 + 裁决可追溯）。

### 9.5 阶段一基线定版（2026-08-28，波 2 门禁项）

> **决策性质:** P-DOC 文档定版决策（非技术裁决，不涉条款语义）
> **依据:** 波 2 对齐——`docs\协作记录.md` §COM-03 2026-08-27 10:40（协议 PM 提案②「阶段一协议基线发布：01_Standard 定稿版打包 + 根 README/DECISIONS 刷新」）/ 12:40（节点 PM 回执：范围/门禁/依赖三项同意）
> **交付物:** `01_Standard/BASELINE.md`（新建 manifest）+ 根 `README.md`「阶段一基线（2026-08）」节 + 本节

| 项 | 决策 |
|---|---|
| 定版范围 | `01_Standard/` 14 份契约文件（版本/会签/定稿日期逐文件清单见 `BASELINE.md` §1）；2 份 IETF 草案 txt 不入基线（§0「暂缓 IETF 提交」+ §9.2.5） |
| 定版口径 | 版本与会签状态为**派生数据**：版本引各文件头、状态以 `docs\协作记录.md` §KNET-CC 台账为准；manifest 不复制条款语义；**零契约正文改动**（01_Standard 既有文件一字不动） |
| 已知滞后（记录不代改） | `flood_protocol.md` / `content_query.md` / `relay_protocol.md` 三文件头状态字样滞后于台账（CC-015/014/013 均已联合关闭），已记 `BASELINE.md` §2，重戳归 P-DOC 后续小批（同观察点 012-⑥ 先例） |
| 边界 | **对外发布（对外宣告/tag/官网）不在本批**——涉治理红线 10，需甲方口径；基线 commit 由 PM 合并后回填 `BASELINE.md` §4 锚点行 |
