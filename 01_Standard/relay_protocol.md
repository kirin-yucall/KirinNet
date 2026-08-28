# KirinNet 内网穿透/中继协议（Relay Protocol）

> **Version:** 0.1（草案）
> **Date:** 2026-08-24
> **Status:** **已会签定稿（KNET-CC-013，2026-08-26 联合关闭：V1~V10 实机全 PASS + 公网在线；2026-08-24 节点 PM 会签附条件通过·随单条件已履约·已合并 master）**
> **Scope:** relay 候选通告（SRV 服务名扩展 `_kirinnet-relay._tcp`）、tunnel_id 定型（格式/生命周期/与 T4 候选映射）、隧道建立协议（控制面 `/api/v2/relay/*`）、数据面语义（HTTP 反代 + WSS 隧道基线）、打洞占位、安全模型（TLS / relay 不可信语义 / 抗滥用与运营者策略边界）
> **关联编号:** KNET-CC-013（**节点 PM 会签附条件通过 2026-08-24 22:30·条件履约·合并 master·云主机 V1~V10 全 PASS 后联合关闭 2026-08-26**）/ T4（`candidate_type=relay` + `tunnel_id` 占位的**波 1 定型文档**，候选排序**引用不重定义**）/ T9（签名质询，**引用 §3.5 不重定义**）/ T1（answer.candidates 承载）/ T3（trust_weight）/ T6（分布式解析层）/ spec_v1 §2.2·§2.5·§3.3.1·§4.1·§5.2（SRV 服务名/回退端口/target≠qname/TLS 校验/Host 头）/ 节点仓《需求文档/14_反向代理与内网穿透.md》（FR1~FR5·§2.4·§3·§7，**规划输入**）/ COM-02（云主机 8.133.174.128 / kirin.yucalls.com）
> **承载关系:** 本协议即 T4 §0/§8 中「relay tunnel_id 编码归波 1 实机验证定型」所指的那份**定型文档**；以节点 14 篇规划为输入提炼契约基线（同 T6 模式），**节点侧实现（R01/R02）已随 KNET-CC-013 会签通过解锁（2026-08-24），按 §11 V1~V10 清单在云主机推进**。

---

## 0. 草案状态与依据

| 项 | 说明 |
|---|---|
| 草案定位 | v0.1 定义 relay 候选通告方式、tunnel_id 格式与生命周期、隧道建立/保活/关闭协议、v1 数据面基线（HTTP 反代 over WSS）、安全模型与 fail-closed 矩阵 |
| 反提炼对象 | 节点 14 篇全篇（**规划中，当前代码未实现**）：FR1 穿透客户端 / FR2 反向代理服务端 / FR3 可达性探测与地址发布 / FR4 隧道安全 / FR5 管理 UI / §2.4 不做清单 / §3.2~§3.4 设计 / §4 数据表 / §5 API / §7 已知问题 |
| 会签记录 | **已会签定稿（KNET-CC-013）**：节点 PM 2026-08-24 22:30 附条件通过·随单条件履约·合并 master；云主机（8.133.174.128）V1~V10 实机联合验证全项 PASS（含 V2 真实公网复验改判，2026-08-26），单已联合关闭（定稿前置已满足） |
| 不越界 | 候选 schema 与排序归 T4；签名质询与覆盖范围归 T9（did-dns §3.5 / DECISIONS §9.3）；answer 包 wire 归 T1；权重取值归 T3；分布式解析与缓存归 T6；P2P 打洞算法**不定型**（§8 占位）；节点侧 R01~R05 实现排期归节点 PM |

**编号对齐说明：** T4 §0/§8 将 tunnel_id wire 编码占位标注为「波 1 T7（实机验证）」；而波 1 任务表（协作记录 §COM-03）中「T7」指浏览器扩展，穿透/中继契约未配 T 号。两处「T7」存在编号歧义——本文件承接 T4 占位的**定型职责**，建议 X-CC 立单 KNET-CC-013 时钉死本协议编号，并在 T4 §8 回填指向 `relay_protocol.md`（一行修订随会签携带，不改 T4 语义）。

---

## 1. 设计动机：可达性是全网功能的前置条件

阶段一关键认知：**实测 IPv6 并非每设备可达**。绝大多数用户节点运行在家庭宽带/机房 NAT 之后，没有公网 IP，外部节点无法直达（连不上 8080/8082）——没有可达性，分布式 DNS 泛洪、IM 消息、内容推送、好友访问全部落空（14 篇 §1）。

本协议定义的恢复路径：

| 组件 | 部署位置 | 职责 | 14 篇对应 |
|---|---|---|---|
| 穿透客户端 | 每个 NAT 后节点（内置） | 主动向公网中继建立加密长连接（隧道），把本地 HTTP/WS 服务映射到公网 | FR1 / R01 |
| 反向代理服务端（relay） | 公网节点/VPS/云主机（可自建、好友提供、公共中继并存） | 监听公网端口（443），按 Host 路由到对应节点的隧道并转发；只转发不落盘 | FR2 / R02 |

**去中心化形态（红线）：** 中继不必须是中心化服务——任何有公网 IP 的节点都可充当 relay（类似分布式 DNS 中好友提供解析）。多中继冗余，无单一中继依赖；**不引入中心化限流/注册/CA**（§9.4）。

**云主机波 1 角色：** 8.133.174.128（Debian12/Docker 29.7.2，域名 kirin.yucalls.com 已解析，目录框架 `/opt/kirinnet-relay/{conf/tls,data/duckdb,data/media,logs,bin}` 已建，端口方案复用 443 + SSH 7899，certbot 待装）作为波 1 验证环境的**首个公共 relay 实例**（COM-02 §COM-02 云主机资源行）。

---

## 2. 与 T4 的关系（本协议 = T4 relay 占位的波 1 定型）

T4（multi_candidate_resolution.md）已定义且本协议**不重定义**：

| T4 已定义 | 本协议关系 |
|---|---|
| 候选类型 `candidate_type: direct \| relay`（§5） | **引用**。direct=直连 IP:端口优先，relay=中继端点兜底；NAT 后节点仅 relay（T4 §5.4） |
| 回退顺序 direct → relay（§5.3） | **引用**。direct 全部不可达才回退 relay；relay 也全部不可达 → 解析失败 fail-closed，不静默兜底 |
| 排序键 `(trust_weight DESC, hops ASC, TTL DESC)`（§3，源自 02 篇 FR7） | **引用**。relay 候选与其他候选同场排序，本协议不改排序规则 |
| 候选 schema `tunnel_id` 字段（§2.1：「仅 relay 候选，编码归波 1 实机验证」） | **本协议定型**（§4）：填入本协议 §4.1 定义的 tunnel_id 字符串，客户端视为不透明标识 |
| relay 候选 `content` = 中继端点（§5.2） | **本协议补充**其来源：§3 的 SRV 通告 + 隧道注册回执 `relay_public_endpoint` |

一句话分工：**T4 管「候选长什么样、怎么排、怎么回退」；本协议管「relay 候选从哪来、隧道怎么建、tunnel_id 是什么、流量怎么走」**。两者经 `candidate_type=relay` 候选条目衔接：本协议 §5 建立隧道成功后，节点把 `{candidate_type:"relay", content:<中继端点>, tunnel_id:<本协议 §4 格式>}` 发布进解析体系（经 T1 answer.candidates / 02 篇 dns_resolve_cache，承载归 T1/T6，本协议不重定义）。

---

## 3. relay 候选通告（SRV 服务名扩展）

### 3.1 relay 自我宣告：`_kirinnet-relay._tcp`

relay 运营者在其**自己的域名**下发布一条 SRV，宣告中继能力：

```
_kirinnet-relay._tcp.<relay域名>.  IN  SRV  <priority> <weight> <port> <target>.
; 示例（云主机波 1 实例）
_kirinnet-relay._tcp.kirin.yucalls.com.  IN  SRV  0 0 443 kirin.yucalls.com.
```

- **语义**：本 host 对外提供 KirinNet relay 服务（可接受隧道注册并转发公网流量）。
- **port**：relay 公网监听端口，RECOMMENDED 443（与 spec_v1 §2.5 HTTPS 回退端口一致，亦与云主机复用 443 方案一致，COM-02）。
- **服务名先例**：`_kirinnet-ipfs._tcp` 已预留（spec_v1 §3.2.1 迁移注记 / dns_automation §10）、`_kirinnet-quic._udp` 未来扩展（spec_v1 §5.3）——`_kirinnet-relay._tcp` 同型扩展。已随本次会签履约在 spec_v1 §2.2 服务名表 + §6.1 IANA 表各加一行（KNET-CC-013 修订，2026-08-24）。
- **回退**：无 `_kirinnet-relay._tcp` SRV 时，客户端 MUST NOT 猜测某主机是 relay（fail-closed，不静默尝试）；服务发现只能经 SRV 或好友显式配置（14 篇 FR1 多中继配置）。

### 3.2 NAT 后节点的服务发布：SRV target 指向 relay

NAT 后节点（无 direct 能力）把自己各服务的 SRV **target** 指向所用 relay 的端点：

```
_kirinnet-http._tcp.<节点域名>.  IN  SRV  0 0 443 <relay域名>.
_kirinnet-https._tcp.<节点域名>. IN  SRV  0 0 443 <relay域名>.
_kirinnet-ws._tcp.<节点域名>.    IN  SRV  0 0 443 <relay域名>.
```

- spec_v1 §3.3.1 Step 3 已明确允许 target ≠ 查询域名（target 须可解析 A/AAAA）——本用法**不修改** SRV 语义，属既有能力的应用。
- 公网客户端到达 relay 后按 **Host 头 = 原节点域名** 路由（spec_v1 §5.2「Host MUST 携带原域名，非 SRV target」与本协议一致，见 §6.2）。
- 有 direct 能力的节点：SRV target 仍指向自身（direct 候选），relay 候选仅在解析体系候选数组中并存兜底（T4 §5.3），不必改公网 SRV。

### 3.3 tunnel_id 不进公网 DNS（决策）

**决策：tunnel_id 只在解析体系候选（T1 answer.candidates / 02 篇缓存）与隧道控制面中携带，不写入公网 DNS TXT/SRV。**

理由：
1. **TTL 失配**：tunnel_id 每次重连轮换（§4.2，分钟级），公网 DNS TTL（典型 300s）会造成大面积陈旧标识；
2. **200B 红线**：往 did:dns 三记录（v/pk/black，身份专用）追加隧道字段会挤占预算并混淆身份/路由两个关注点；
3. **路由不需要**：relay 按 Host（域名）路由（§6.2），tunnel_id 非路由键，公网侧携带无必要。

**非规范性备选（未采纳，占位）：** 定义 `did:dns:relay;...` 第四类 TXT 记录携带中继绑定——若未来采纳须修订 did-dns-protocol §2/§6（新 CC），v0.1 不定型（守「方向驱动分阶段细化」）。

---

## 4. tunnel_id 定型

### 4.1 格式

| 项 | 定义 |
|---|---|
| 生成方 | **relay**（MUST）。relay 是路由表的拥有者，由它保证自身域内唯一 |
| 熵源 | 128 bit（16 字节）CSPRNG 随机 |
| 编码 | Base64URL（RFC 4648 §5，无 padding）= **22 字符**，如 `k9Xw2mQaP7bR4eNt6YhU0c` |
| 唯一性范围 | 单 relay 域内（MUST 唯一于该 relay 当前活隧道集合）；全局唯一不作要求——候选中 `content`（relay 端点）+ `tunnel_id` 联合定位 |
| 冲突处理 | relay 生成时检查活隧道集合，碰撞即重掷（2^-64 量级概率，工程可忽略） |
| 安全定位 | **非能力凭证**：客户端与第三方 MUST NOT 将其视为鉴权材料（路由键是域名，鉴权走 §5 签名质询）；用于 relay 路由表内部键、候选溯源、诊断与多隧道区分 |
| 不透明性 | 客户端 MUST NOT 解析其内部结构（无内部结构——纯随机，非确定性派生） |

**为何不用确定性 ID（如由节点公钥指纹派生）：** 确定性 ID 跨重连可关联（隐私劣化）、密钥轮换后语义断裂、且仍需 relay 侧防替换检查；纯随机每隧道轮换 + 域名所有权签名验证（§5.3）已覆盖全部需求，更简。

### 4.2 生命周期

```
reserved ──WSS 数据通道接入(≤30s)──▶ active ──优雅关闭(bye+drain≤5s)──▶ draining ──▶ closed
   │ 30s 未接入，回收                        │
   └────────▶ expired ◀── 3×heartbeat 无保活 ─┘
                       ◀── WSS 断开(未 bye，等保活超时兜底回收)
```

| 阶段 | 进入条件 | 超时/退出 |
|---|---|---|
| `reserved` | `POST /api/v2/relay/tunnel` 201 成立（§5.2），路由表暂不生效 | 30s 内未完成 WSS 接入 → `expired`，relay 回收预留 |
| `active` | WSS 数据通道接入并通过 token 校验（§5.3），relay 置路由表 `域名→tunnel_id` 生效 | 保活：默认 30s 心跳（§7.1）；3×heartbeat（默认 90s）无任何帧/心跳 → `expired`，路由回收（对齐 14 篇 §7.6「last_seen 超时 3×heartbeat 回收」） |
| `draining` | 节点发 `{"t":"bye"}` 帧或 DELETE（§7.3） | 在途请求排空 ≤5s → `closed`，路由删除 |
| `closed` / `expired` | 终态 | **tunnel_id 不复用**：任何重建（含同节点同域名）走全新握手，得到全新 tunnel_id（防重放/防陈旧路由劫持） |

同域名重注册（同域名 + 通过签名验证 = 同一所有者）：新隧道置 `active` 时**原子替换**旧路由，旧隧道 5s 排空后关闭——覆盖 14 篇 FR1「端口/域名变化自动重建」场景。

### 4.3 与 T4 候选条目的映射

```
T4 §2.1 relay 候选（本协议填充粗体字段）：
{
  "domain":           <节点域名>,
  "record_type":      "SRV",
  "content":          "<relay主机>:<relay端口>",        ← §5.2 回执 relay_public_endpoint / §3.1 SRV target
  "candidate_type":   "relay",
  "tunnel_id":        "<22字符 Base64URL>",            ← 本协议 §4.1，填入即定型（T4 §8 占位闭环）
  "trust_weight":     <T3 取值>,                        ← T3/T4 管，本协议不碰
  "hops"/"ttl"/"expires_at"/"source": <T4 §2.2 定义>
}
```

- **多中继冗余**：节点同时挂多个 relay（14 篇 FR1）→ 候选数组含多条 relay 条目（每 relay 一条，各带自己的 tunnel_id 与 content），排序与回退完全交给 T4 §5.3。
- **轮换同步**：隧道重建（新 tunnel_id）后节点 SHOULD 尽快刷新解析体系候选；**陈旧 tunnel_id 不阻断路由**（路由键是域名，relay 路由表已是新隧道），候选中的旧 tunnel_id 仅供诊断、无害。
- **签名覆盖**：候选 `tunnel_id` 字段是否纳入 T9 §9.3.2 签名覆盖 → 已随 KNET-CC-013 会签按建议口径钉死：**不纳入，维持 T9 现清单**（篡改 tunnel_id 无安全后果——非凭证非路由键；会签附条件项未含本点，按本文件建议口径生效，§13）。

---

## 5. 隧道建立协议（控制面）

### 5.1 端点总览（relay 侧，全部 HTTPS，TLS 见 §9.1）

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| POST | `/api/v2/relay/challenge` | 无 | 申请签名质询码（T9 §3.5.1 结构） |
| POST | `/api/v2/relay/tunnel` | Ed25519 签名质询（T9） | 隧道握手注册，成立回 tunnel_id + tunnel_token |
| GET | `/api/v2/relay/tunnel/{tunnel_id}` | `tunnel_token`（一次性） | **WebSocket 升级** → WSS 数据通道（§6） |
| DELETE | `/api/v2/relay/tunnel/{tunnel_id}` | `tunnel_token` | 主动关闭（§7.3） |
| GET | `/api/v2/relay/info` | 无 | 运营者元数据（MAY，§5.4） |

命名说明：`/api/v2/` 为**协议跨仓端点命名空间**（本协议 relay 控制面 /api/v2/relay/* 与内容推送 /api/v2/push/* 同族）；节点本地 API（api.md 所记 /api/*，文档版本 2.8.x）与之分层，互不冲突。**与 14 篇 §5.1 `/api/relay/*`（节点本地管理面，status/connect/config）是不同层**——那是节点自身 admin API，归节点仓定义，本协议不碰。

### 5.2 握手流程（三步）

```
NAT 后节点                                   relay（如 kirin.yucalls.com:443）
    │  ① POST /api/v2/relay/challenge              │
    │     {"domain":"<节点域名>"}                    │
    │──────────────────────────────────────────────▶│
    │  ② relay 经 DoH/DoT 解析该域名 did:dns TXT     │
    │     取 pk（校验 fp 链 + iat ±5min + 非 black）  │
    │     生成质询码 c（T9 §3.5.1：nonce:ts:hmac，    │
    │     TTL 60s，一次性 nonce 去重）                │
    │◀──────────── 200 {"challenge":c, "expires_at"}─│
    │  ③ 节点用 Ed25519 私钥签名（T9 §3.5.2 覆盖：    │
    │     c + relay域名 + 节点域名）                  │
    │  POST /api/v2/relay/tunnel                    │
    │  {"domain","pk","sig","services":[            │
    │    {"name":"http","local_port":8080},         │
    │    {"name":"ws","local_port":8082}],          │
    │   "client_caps":{"multiplex":false}}          │
    │──────────────────────────────────────────────▶│
    │  ④ relay：DoH 复核 pk == DNS 当前 pk；T9 验签；  │
    │     黑名单检查 → 生成 tunnel_id + tunnel_token  │
    │◀─ 201 {"tunnel_id","tunnel_token",            │
    │        "relay_public_endpoint":"host:443",    │
    │        "heartbeat_s":30,"drain_s":5}          │
    │  ⑤ 30s 内 GET /api/v2/relay/tunnel/{id}       │
    │     头 X-KirinNet-Tunnel: <tunnel_token>       │
    │     WebSocket 升级 → 数据通道 active            │
    │──────────────────────────────────────────────▶│
```

### 5.3 鉴权与防劫持（引用 T9，不重定义）

- **质询码结构/TTL/一次性**：全部引用 T9 §3.5.1（`nonce:timestamp:hmac`，60s TTL，nonce 去重）——本协议不另造格式。
- **签名覆盖**：引用 T9 §3.5.2 第 1/2/3 项（挑战码明文 + 校验方域名=relay 域名 + 受验方域名=节点域名），Ed25519 64 字节 Base64URL。**不扩展覆盖项**：`services`/`local_port` 等注册载荷的完整性由 TLS（节点→relay）保证，签名只承担**域名所有权自证**（防劫持他人域名注册路由，14 篇 FR4）——与 T9「MUST NOT 覆盖传输层已保证内容」原则同向。
- **公钥锚定**：relay MUST 经 **DoH/DoT**（红线：强制加密 DNS 解析）解析节点域名 TXT，校验 fp 链 + `iat` ±5 分钟新鲜度 + 非 black（did-dns §2/§3.3.2 规则，引用）；请求体 `pk` MUST 与 DNS 当前 pk 一致，否则 403。
- **tunnel_token**：128 bit 随机 Base64URL（22 字符，同 §4.1 编码），**一次性**，仅用于 WSS 数据通道与 DELETE 的持有者校验；MUST NOT 出现在候选/SRV/日志明文。与 tunnel_id 分离：id 公开（可进候选）、token 秘密（通道绑定）。
- **过渡期 token 白名单**：14 篇 §7.3 提到签名质询未落地前可用 token 白名单——本协议定稿基线为 **Ed25519 签名质询 MUST**；relay 运营者本地白名单 MAY 作为**部署过渡**（运营者策略，非协议条款），会签定稿后应移除（fail-closed：验证失败一律 403，协议不提供降级路径）。

### 5.4 响应码（fail-closed 矩阵，控制面）

| 状态 | 场景 | 语义 |
|---|---|---|
| 201 | 注册成立 | tunnel 进入 `reserved` |
| 403 `invalid_signature` | T9 验签失败 / pk 与 DNS 不符 / fp 链断 / iat 过期 / pk 在 black | **拒绝，无降级**（fail-closed） |
| 429 | 质询码过期/复用（nonce 去重命中） | 客户端重新申请质询（不视为惩罚性限流，是防重放语义） |
| 503 `capacity` | 运营者本地容量策略（§9.4） | 客户端按 T4 §5.3 换下一 relay 候选 |
| 400 | 请求体格式/服务名非法 | — |
| `GET /api/v2/relay/info`（MAY） | `{"relay_domain","version","heartbeat_s","policy_hint":{...}}` | 运营者策略透明化，advisory 非强制 |

**建立失败后的回退（与 T4 §5.3 衔接）：** 节点隧道建立失败 → 该 relay 候选不发布/撤回；**客户端侧**解析到的 relay 候选不可达 → 按 T4 §5.3 继续（direct 优先已在前的排序不变，全部失败即解析失败）。协议任何环节 MUST NOT 静默降级到未验证/明文路径。

---

## 6. 数据面语义（v1 基线：HTTP 反代 over WSS 隧道）

> **基线来源：** 以节点 14 篇规划为输入提炼（FR2 Host/SNI 路由 + §7.1「v1 走 WSS 零新依赖」+ §7.4「v1 可退化为串行转发」）。**节点侧实现（R01/R02）已随 KNET-CC-013 会签通过解锁（2026-08-24），按 §11 V1~V10 清单在云主机推进**（同 T6 §7 模式）。

### 6.1 两段传输 + 一层端到端

```
公网客户端 ──HTTPS/WSS(TLS段1)──▶ relay ──WSS隧道(TLS段2, 节点主动外连)──▶ NAT 后节点本地服务
                                 │                                            (8080 HTTP / 8082 WS)
业务机密内容：客户端/节点在应用层做端到端加密（HPKE 体系，引用
security_model/im_protocol，与传输路径无关）——relay 两段都只见传输明文+业务密文
```

### 6.2 公网侧（relay 入站路由）

- 客户端 TCP 连 relay 端点（§3.1 SRV 得知），**TLS SNI = relay 端点域名**（证书校验对象是 relay，见 §9.2），**Host 头 = 原节点域名**（spec_v1 §5.2 原文即如此，天然兼容）。
- relay 按 Host 查路由表 `域名→tunnel_id`：命中 → 经隧道转发（§6.3）；未命中/未注册 → **404 `{"error":"no_tunnel"}`**（14 篇 FR2「未注册域名 404」）。客户端收到 404 按 T4 §5.3 换候选，最终 fail-closed。
- WebSocket 升级请求同路径处理：Upgrade 头存在时转发到该域名注册的 `ws` 服务端口，否则到 `http` 端口（v1 MAY 单一 `local_port` 默认 8080，14 篇 §4 relay_routes 形态）。

### 6.3 隧道帧（WSS 数据通道，v1 基线）

WSS 文本帧承载 JSON 控制、二进制帧承载载荷体；**v1 允许串行处理**（一时刻一请求，14 篇 §7.4），但帧内 `id` 字段自 v0.1 即存在（前向兼容多路复用，多路复用本身归阶段二 R05，本协议不定型）：

| 方向 | 帧 | 说明 |
|---|---|---|
| relay→节点 | `{"t":"req","id":N,"method","path","headers":{...}}` + 二进制体块 + `{"t":"end","id":N}` | 转发的公网请求 |
| 节点→relay | `{"t":"res","id":N,"status","headers":{...}}` + 二进制体块 + `{"t":"end","id":N}` | 本地服务响应回传 |
| 双向 | `{"t":"ka","ts":...}` | 保活（§7.1） |
| 节点→relay | `{"t":"bye"}` | 优雅关闭（§7.3） |
| 双向 | `{"t":"err","id":N,"code"}` | 错误（`no_route`/`local_unreachable`/`frame_invalid` 等） |
| 节点→relay（首帧） | `{"t":"ready","services":[...]}` | 确认注册服务清单，隧道转 `active` |

WebSocket 关闭码：`4001` token 无效 / `4002` 保活超时 / `4003` 运营者策略 / `1001` relay 重启排空。帧字段编码细节（header 折叠、二进制分块边界）在波 1 实机验证后微调，**语义字段（t/id/method/path/status）v0.1 定型**。

### 6.4 明确不做（v1，对齐 14 篇 §2.4 + 保守现状）

- **不做 L4 纯转发（TCP 透传）**：v1 数据面是 HTTP 反代语义（需读 Host 路由）；SNI 透传型 L4 列为阶段二占位，不定型。
- **不做 UDP 隧道**：v1 仅 TCP/WSS，覆盖 HTTP/WS 业务（14 篇 §2.4）。
- **不做中继计费/商业运营**、不做域名托管（中继只路由，解析仍在 02 篇/T6 体系）。

---

## 7. 保活、超时与关闭（生命周期执行细节）

### 7.1 保活（对齐 14 篇 FR1/§5.3 `relay_heartbeat_s=30` + 04 篇 WS 心跳）

- 节点每 `heartbeat_s`（默认 30s，握手回执告知）发 `{"t":"ka"}`；RFC 6455 ping/pong MAY 叠加。
- relay 侧路由表 `last_seen` 由任何 inbound 帧刷新；**3×heartbeat（默认 90s）无帧 → 路由回收 + 隧道 `expired`**（14 篇 §7.6）。

### 7.2 断线重连（对齐 14 篇 FR1）

- 节点重连退避 1s/2s/4s…上限 60s（SHOULD，节点客户端行为，状态机 `disabled→connecting→connected→reconnecting→disabled` 引用 14 篇 §3.2 不重定义）。
- 每次重连 = 全新握手（§5.2）+ **全新 tunnel_id**（§4.2 不复用）+ 原子替换旧路由。
- 多中继：主 relay 失联自动切换（14 篇 FR1/NFR「中继宕机 30s 内切换」目标），候选冗余由 T4 排序消费。

### 7.3 关闭

- **优雅**：节点发 `{"t":"bye"}` → relay 停止新路由、在途请求排空 ≤`drain_s`（默认 5s）→ 关闭；或 `DELETE /api/v2/relay/tunnel/{tunnel_id}`（带 tunnel_token）→ 204。
- **兜底**：WSS 异常断开未 bye → 等 3×heartbeat 超时回收（防半开连接占路由）。
- 关闭后 tunnel_id 作废；节点 SHOULD 撤回/刷新解析体系中的 relay 候选。

---

## 8. 打洞 vs 中继（v1 中继为主，打洞占位不定型）

- **v1 立场：中继为主**，遵循节点 14 篇 §2.4「不做 P2P 打洞直连（STUN/TCP 打洞成功率有限，v1 走中继隧道，打洞列为远期可选）」的保守现状——阶段一实测 IPv6 不可达的认知更强化此选择。
- **占位不定型**：P2P 打洞（STUN/UDP 打洞、直连候选的 NAT 分类）**不在本协议定义**；若阶段二立项，走新 CC，届时 T4 候选类型可扩展（如 `p2p`），T4 §2.1 enum 扩展随彼时修订——现在不预留语义、不写参数（守「方向驱动分阶段细化」红线，同 T8 VDF 预留处理方式）。
- **本协议与打洞的唯一交点**：T4 §5.3 的 direct→relay 回退顺序天然兼容未来「打洞成功即 direct、失败即 relay」的探测结果，无需本协议改动。

---

## 9. 安全模型

### 9.1 传输加密（复用云主机证书模式）

- relay 公网端口 MUST TLS（HTTPS/WSS 同端口 443）；证书为 relay **自身域名**证书（波 1 云主机：kirin.yucalls.com 的 Let's Encrypt 证书，certbot 波 1 待装，COM-02）——「复用 kirin.yucalls.com 证书模式」即此：一套 relay 域名证书同时服务控制面（§5）与两段数据面（§6.1 TLS 段1/段2）。
- 节点→relay 隧道 = WSS（同证书）。无 TLS 的明文隧道 MUST NOT（fail-closed；14 篇 FR4「无 TLS 场景自协商加密」列为目标项，v0.1 不定型）。
- DNS 解析 MUST 走 DoH/DoT（红线）：relay 解析节点 TXT（§5.3）、客户端解析 SRV（spec_v1 §4.3）均强制。

### 9.2 证书校验对象与身份验证分层（对 spec_v1 §4.1 的显式补充）

| 层 | 校验对象 | 说明 |
|---|---|---|
| 传输层 TLS | **relay 端点域名**（SRV target） | relay 模式下传输对端就是 relay——SNI/证书校验针对 relay 域名，Host 头携带原节点域名路由（§6.2） |
| 应用层身份 | **节点域名**（did:dns TXT + T9 签名质询） | 节点身份验证与传输路径无关（14 篇 §6：「DoH 验证仍有效——验证的是域名与签名」）：客户端经隧道对节点做 T9 质询验签，公钥锚定自 DNS TXT |
| 业务机密 | 端到端应用层加密（HPKE 体系） | 见 §9.3 |

**注意：** spec_v1 §4.1 缓解措施 3「证书 SAN MUST 匹配原域名而非 SRV target」按字面适用于 direct 场景；relay 场景下传输对端是 relay，须按本节分层。已随本次会签履约在 spec_v1 §4.1 加 relay 场景注记（KNET-CC-013 修订，2026-08-24，不改 direct 语义）。

### 9.3 relay 不可信语义（信任边界如实声明）

- relay 是**传输中介，不是信任锚**：MUST NOT 被要求可信于业务机密。
- **relay 可见**：传输层元数据（源/目的 IP、域名、Host/path、时序、流量大小）+ 任何未做端到端加密的应用层明文。relay 日志 SHOULD 仅记连接元数据，MUST NOT 落盘内容（14 篇 FR4「只转发不落盘」）。
- **relay 不可见**：经应用层端到端加密的业务内容（HPKE 加密的内容/IM/推送载荷——followers.encrypted_pushes、content 加密、IM 临时密钥体系，引用 security_model/im_protocol，本协议不重定义其原语）。**对经由 relay 的机密业务数据，客户端 MUST 使用应用层端到端加密**——这是协议级要求，不依赖 relay 自觉。
- 中继劫持/替换风险：路由劫持被 §5.3 签名质询阻断（注册须域名所有权证明）；在途篡改被 TLS 段阻断；伪装节点被应用层 T9 质询阻断（fail-closed：任一验证失败即断，无降级）。

### 9.4 抗滥用与运营者策略边界（不触红线）

- **协议不设**全网强制限流、身份注册、中心 CA（红线：去中心化不用限流/注册/CA）——隧道注册是**密码学域名所有权自证**（§5.3），不是身份注册。
- relay **运营者可自主**实施本地资源保护策略（并发隧道数、单隧道带宽/流量上限、路由表容量等）——属**运营者本地策略而非协议条款**：协议只定义其表达（503 `capacity`、`policy_hint` advisory），不规定数值；且策略 MUST NOT 要求中心化身份注册或第三方 CA 凭证作为接入前提（可以域名+签名自证接入）。
- 资源耗尽类滥用（DoS relay）：由运营者本地策略 + 多中继冗余（去中心化解法）消化，不上升为协议强制限流。

---

## 10. 与其他协议/模块的互引

| 对象 | 关系 |
|---|---|
| T4（multi_candidate_resolution） | 本协议是其 tunnel_id 占位的波 1 定型；候选 schema/排序/回退**引用不重定义**（§2） |
| T9（did-dns §3.5 / DECISIONS §9.3） | 质询码结构/签名覆盖/防重放**引用不重定义**（§5.3）；**引用 T9 草案已会签定稿（CC-011 联合关闭，波 0）**——若后续 T9 修订，本协议跟随 |
| T1（flood_protocol） | relay 候选经 answer.candidates 泛洪承载，wire 归 T1 |
| T3（trust_weight） | relay 候选权重取值/聚合归 T3；relay 自身的信任度影响其候选权重（社交层语义，本协议不碰） |
| T6（distributed_dns） | 解析/缓存/好友链泛洪归 T6；本协议只供给候选数据源 |
| spec_v1（ADRP） | §3.1/§3.2 使用 SRV 既有语义；已随 CC-013 会签履约完成两处一行修订（§2.2/§6.1 加 `_kirinnet-relay._tcp`；§4.1 relay 注记，2026-08-24） |
| 节点 14 篇 | 本协议的规划输入；节点侧 R01~R05 实现**已随 KNET-CC-013 会签通过解锁（2026-08-24），按 §11 V1~V10 清单推进** |
| 节点 04 篇（IM） | WS 通道 8082 经隧道可达，心跳复用同一机制（14 篇 §6） |
| 节点 10 篇（推送） | 推送目标在 NAT 后时经中继转发；DoH 验证与传输路径无关（14 篇 §6） |

---

## 11. 波 1 实机验证环境与清单（云主机联合验证）

**环境（COM-02，已就位）：** 8.133.174.128（阿里云 Debian12/40G/Docker 29.7.2），域名 kirin.yucalls.com 已解析，目录 `/opt/kirinnet-relay/` 框架已建，端口方案复用 443 + SSH 7899；certbot/Let's Encrypt 待装；R02（RELAY_MODE=1）波 1 部署。

| # | 验证项 | 门禁 | 状态 |
|---|---|---|---|
| V1 | TLS 就绪：certbot 签发 kirin.yucalls.com 证书，443 服务 HTTPS/WSS | 证书链有效，控制面可达 | ⏳ 待执行 |
| V2 | `_kirinnet-relay._tcp.kirin.yucalls.com` SRV 发布 + DoH 查询命中 | SRV 记录 `0 0 443 kirin.yucalls.com` | ⏳ |
| V3 | NAT 后演示节点 + 隧道握手三步（challenge→tunnel→WSS） | 201 + tunnel_id 22 字符 + active | ⏳ |
| V4 | 签名验证 fail-closed：错误私钥/过期质询/复用 nonce | 一律 403/429，无降级 | ⏳ |
| V5 | Host 路由：公网 `curl -H "Host: <节点域名>" https://kirin.yucalls.com/` 经隧道命中本地 8080；未注册域名 404 `no_tunnel` | 200/404 断言 | ⏳ |
| V6 | 保活与回收：停发心跳，3×30s 后路由回收、候选失效 | 过期回收断言 | ⏳ |
| V7 | 重连轮换：断线重连得**新 tunnel_id**，旧路由原子替换、无中断窗口 >5s | 替换断言 | ⏳ |
| V8 | 候选发布与回退：节点发布 direct+relay 候选（T4 schema），客户端按 direct→relay 回退，全失败解析失败 | T4 §5.3 顺序断言 | ⏳ |
| V9 | WS 业务经隧道：8082 IM 通道经 relay 可达，心跳复用 | WS 握手+消息回环 | ⏳ |
| V10 | 性能抽样：隧道开销目标 <15%（14 篇 NFR） | 抽样报告 | ⏳ |

验证产出（穿透方案验证报告，波 1 门禁项）由协议侧 + 节点 PM 联合署名后随会签归档。

---

## 12. 自测门禁（交付前自查）

| # | 门禁项 | 本草案结论 |
|---|---|---|
| RELAY-1 | 与 T4 关系清晰：候选 schema/排序/回退引用不重定义，tunnel_id 占位承接有出处 | ✅ §2/§4.3（T4 §0/§5/§8） |
| RELAY-2 | tunnel_id 定型完整：格式（22 字符 Base64URL/128bit CSPRNG/relay 生成）+ 生命周期（reserved/active/draining/expired/closed，不复用）+ T4 映射 | ✅ §4 |
| RELAY-3 | 签名质询引用 T9 不重定义（质询结构/覆盖范围/防重放均标注引用） | ✅ §5.3 |
| RELAY-4 | fail-closed 全路径：验签失败 403、未注册 404、无候选解析失败、明文隧道 MUST NOT | ✅ §5.4/§6.2/§9.1 |
| RELAY-5 | v1 中继为主、打洞占位不定型（与 14 篇 §2.4 一致） | ✅ §8 |
| RELAY-6 | relay 不可信语义如实（元数据可见/业务密文不可见/端到端加密 MUST） | ✅ §9.3 |
| RELAY-7 | 抗滥用措辞不触红线：运营者本地策略非协议条款，不引入中心化限流/注册/CA | ✅ §9.4 |
| RELAY-8 | 节点侧实现标注「会签通过后解锁（KNET-CC-013，2026-08-24）」 | ✅ §6/§0 |
| RELAY-9 | `grep -ri aura 01_Standard/relay_protocol.md` 零残留（仅本表命令文本引用，豁免口径同 T4-6） | ✅ |
| RELAY-10 | 引用编号一致（T1/T3/T4/T6/T9/spec_v1 §2.2/§2.5/§3.3.1/§4.1/§5.2/14 篇 FR1~FR5/§2.4/§7/COM-02） | ✅ |

---

## 13. 会签状态与遗留项

| 项 | 归属 | 状态 |
|---|---|---|
| 本协议整体（relay 候选通告/tunnel_id/隧道协议/数据面基线） | KNET-CC-013 节点 PM 会签 + 波 1 云主机联合验证 | **已会签定稿（KNET-CC-013，2026-08-24 附条件通过·履约·合并 master；2026-08-26 联合关闭——V1~V10 实机全 PASS + 公网在线）** |
| spec_v1 §2.2/§6.1 追加 `_kirinnet-relay._tcp` 服务名（各一行） | 随 CC-013 会签携带 | **已履约**（spec_v1 已加行，2026-08-24） |
| spec_v1 §4.1 缓解措施 3 的 relay 场景注记（一行） | 随 CC-013 会签携带 | **已履约**（spec_v1 §4.1 已加注记，2026-08-24） |
| T4 §8 占位行回填指向 relay_protocol.md（一行，含「T7」编号歧义澄清） | 随 CC-013 会签携带 | **已履约**（T4 §8 已回填，2026-08-24） |
| 候选 `tunnel_id` 是否纳入 T9 签名覆盖 | 会签观察点（建议：不扩，维持 T9 现清单——tunnel_id 非凭证非路由键） | **按建议口径钉死：不纳入**（CC-013 会签，附条件项未含本点，§4.3） |
| 隧道帧编码细节（header 折叠/分块边界） | 波 1 实机验证后微调（语义字段已定型） | V1~V10 已全 PASS（2026-08-26）；>32KB 大块 WS 拒帧缺陷登记遗留交 N-WS-RELAY 随帧编码微调处置（§KNET-CC-013 关闭行，不阻塞定稿） |
| L4 透传 / 无 TLS 自协商加密 / 多路复用 / P2P 打洞 | 阶段二占位，不定型 | 占位 |

---

## 14. 版本与变更

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-08-24 | 中继协议起草子代理（P-ARCH/P-NET 视角）首版草案：T4 tunnel_id 占位的波 1 定型（§2/§4，128bit CSPRNG Base64URL 22 字符，relay 生成，生命周期 reserved→active→draining→closed/expired 不复用）+ relay 候选通告（§3，`_kirinnet-relay._tcp` SRV 扩展 + NAT 节点 SRV target 指向 relay + tunnel_id 不进公网 DNS 决策）+ 隧道建立协议（§5，`/api/v2/relay/*` 三步握手，签名质询引用 T9 不重定义，fail-closed 矩阵）+ 数据面基线（§6，HTTP 反代 over WSS，v1 串行 MAY，L4/UDP 不做）+ 保活/重连/关闭（§7，3×heartbeat 回收对齐 14 篇 §7.6）+ 打洞占位（§8）+ 安全模型（§9，TLS 分层校验/relay 不可信语义/运营者策略不触红线）+ 波 1 云主机验证清单 V1~V10（§11）。**未会签·单边定稿无效**。（后经 KNET-CC-013 会签定稿并联合关闭，2026-08-26） |

---

*本文件为 KirinNet 内网穿透/中继协议 v0.1（已会签定稿：KNET-CC-013）。节点 PM 会签（2026-08-24 22:30 附条件通过·随单条件履约·合并 master）→ 云主机（8.133.174.128 / kirin.yucalls.com）V1~V10 实机验证全项 PASS + 公网在线 → 联合关闭（2026-08-26）。候选 schema/排序/回退引用 T4、签名质询引用 T9、answer 承载引用 T1、权重引用 T3、解析层引用 T6，均不重定义；节点侧实现已随会签解锁、按 V1~V10 清单推进；打洞与 L4 透传占位不定型。*
