# KirinNet 多候选解析格式（Multi-Candidate Resolution）

> **Version:** 0.1（草案）
> **Date:** 2026-08-08
> **Status:** 草案 v0.1 · 未会签 · 单边定稿无效
> **Scope:** 候选 schema、权重携带、排序策略、客户端选择策略、direct/relay 候选类型与回退
> **关联编号:** T4（多候选解析格式）/ T1（answer 包承载，**引用 T1 草案·未会签**）/ T3（trust_weight 消费，**引用 T3 草案·未会签**）/ T9（候选权重字段在签名覆盖内，**引用 T9 草案·未会签**）/ FR7（多候选排序 `(trust_weight DESC, hops ASC, TTL DESC)`）/ FR8（多候选与冲突·direct/relay·不做唯一性裁决）
> **承载关系:** T4 消费 T3 权重值 + T1 answer 包字段；候选 schema 与节点 02 篇 answer 包 `candidates[]` 对齐。
> **签名口径:** 候选的 `trust_weight` 字段在 T9 签名覆盖范围内（引用 T9 §9.3.2），P-FLOOD 不重定义。

---

## 0. 草案状态与依据

| 项 | 说明 |
|---|---|
| 草案定位 | v0.1 定义多候选 schema、排序键、客户端选择策略、direct/relay 候选类型与回退顺序 |
| 反提炼对象 | 节点 02 篇 FR7（多候选排序 `(trust_weight DESC, hops ASC, TTL DESC)`，返回全部候选供客户端选择）+ FR8（允许同名域名共存，返回多候选各带权重，**不做唯一性裁决，纠纷留给法律**；候选类型 direct/relay，direct 直连 IP:端口权重优先 ↔ relay 中继端点 + 隧道标识兜底，NAT 后节点仅 relay，客户端按 direct→relay 回退）+ §4 数据表（`dns_resolve_cache.candidates` JSON 字段） |
| 会签要求 | T4 为强制会签项，须经节点 PM 会签（KNET-CC）后方可标「定稿」 |
| 不越界 | 排序键的字段值定义归 T3（trust_weight）/T1（hops/TTL）；签名覆盖归 T9；穿透/中继隧道标识的具体编码（wire 格式）归波 1 实机验证 + T7；本文件定义候选 schema 与排序应用 |

---

## 1. 设计动机：去中心化无权威裁决

KirinNet 是**无中心权威**的去中心化网络，**不做域名唯一性裁决**（02 篇 §2.4 Out of Scope + FR8 + §0「域名归属由去中心化节点群的信任权重决定；同名域名多候选 + 权重排序；纠纷留给法律」）。

**多候选解析的核心原则：**

1. **允许同名域名共存**：多个节点可声明同一域名（不同 IP/端点/内容），解析返回全部候选。
2. **权重排序**：候选按 `(trust_weight DESC, hops ASC, TTL DESC)` 排序（02 篇 FR7），权重高的靠前。
3. **客户端自行选择**：协议返回全部候选，**不替客户端做唯一性裁决**；客户端按权重/类型自行选择，纠纷留给法律（§0 决策）。
4. **direct/relay 回退**：候选分 direct（直连）与 relay（中继兜底），客户端按 direct→relay 回退（FR8）。

**与去中心化纪律:** 多候选 + 权重排序是去中心化防冲突机制，**不依赖中心化仲裁 / CA / 注册系统**（§6）。

---

## 2. 候选 Schema（与节点 answer 包对齐）

### 2.1 候选对象结构

单个候选（candidate）的字段（与节点 02 篇 §4 `dns_resolve_cache.candidates` JSON + T1 §3.1.4 `answer.candidates[]` 对齐）：

```
{
  "domain": <域名, ASCII>,
  "record_type": <A | SRV | TXT(did:dns:)>,
  "content": <IP / host:port / did:dns: 串>,
  "ttl": <候选 TTL 秒>,
  "expires_at": <过期 Unix 秒 | null>,
  "source": <manual | friend | flood>,
  "trust_weight": <-127~100, 引用 T3>,
  "hops": <该候选经过的转发跳数, int>,
  "candidate_type": <direct | relay, 见 §5>,
  "tunnel_id": <隧道标识 | null, 仅 relay 候选, 编码归波1 T7>
}
```

### 2.2 字段定义

| 字段 | 类型 | 含义 | 来源 |
|---|---|---|---|
| `domain` | str | 域名 | dns_hosts.domain / query qname |
| `record_type` | enum | A / SRV / TXT(did:dns:) | dns_hosts.record_type |
| `content` | str | IP（A）/ host:port（SRV）/ did:dns: 串（TXT） | dns_hosts.content |
| `ttl` | int | 候选 TTL 秒（用于排序 TTL DESC + 缓存过期） | dns_hosts.ttl |
| `expires_at` | int/null | 过期时间；null = 永不过期（manual） | dns_hosts.expires_at |
| `source` | enum | manual / friend / flood | dns_hosts.source |
| `trust_weight` | int | 信任权重 -127~100（**引用 T3**，路径权重 = min 聚合或本地权重） | T3 §4 |
| `hops` | int | 转发跳数（发起方=0，每经一跳+1） | T1 forward_chain.length - 1 |
| `candidate_type` | enum | direct（直连 IP:端口）/ relay（中继端点 + 隧道标识），见 §5 | 本文件 §5 |
| `tunnel_id` | str/null | 隧道标识，仅 relay 候选；编码归波 1 T7（实机验证） | 波 1 T7 |

### 2.3 与 answer 包的关系（T1 §3.1.4）

`answer` 包（T1）的 `candidates[]` 即本 schema 的数组；`answer.trust_weight`（路径权重）与 `candidates[].trust_weight`（候选本地权重）均纳入 T9 签名覆盖（引用 T9 §9.3.2，防权重篡改）。

---

## 3. 排序策略（与节点 FR7 一致）

### 3.1 排序键

候选按以下键**字典序排序**（02 篇 FR7）：

```
排序键 = (trust_weight DESC, hops ASC, TTL DESC)
```

| 优先级 | 键 | 方向 | 含义 |
|---|---|---|---|
| 1 | `trust_weight` | **DESC（降序）** | 权重高的候选优先（信任优先） |
| 2 | `hops` | **ASC（升序）** | 跳数少的候选优先（近的优先，降延迟） |
| 3 | `TTL` | **DESC（降序）** | TTL 大的候选优先（新鲜的优先，降过期风险） |

### 3.2 排序示例

```
候选 A: trust_weight=80, hops=2, ttl=300
候选 B: trust_weight=80, hops=1, ttl=200   ← B 优先（权重同，hops 少）
候选 C: trust_weight=90, hops=3, ttl=100   ← C 最优先（权重最高）
候选 D: trust_weight=80, hops=1, ttl=600   ← D 优先于 B（权重同 hops 同，ttl 大）

排序结果: [C, D, B, A]
```

### 3.3 -127 黑名单候选的处置

- `trust_weight=-127`（黑名单）的候选：**默认过滤**（不返回，02 篇 FR7「-127 不转发/不响应」），或返回时标记 `trust_weight=-127` 供客户端明确拒绝。
- 客户端策略（§4）：默认忽略 -127 候选；用户可显式选择查看（知情风险）。

---

## 4. 客户端选择策略（返回全部，不做唯一性裁决）

### 4.1 协议不裁决（§0 + FR8）

- **协议返回全部候选**（排序后数组），**不替客户端做唯一性裁决**。
- **纠纷留给法律**（§0 决策）：同名域名归属纠纷由法律途径解决，协议层只提供多候选 + 权重信息，不仲裁。

### 4.2 客户端默认策略（建议，非强制）

| 策略 | 说明 |
|---|---|
| **取排序首位** | 默认取排序第一的候选（权重最高 + 跳数最近 + TTL 最新） |
| **direct 优先** | 同等条件下优先 direct 候选（§5），relay 兜底 |
| **-127 忽略** | 黑名单候选默认忽略 |
| **用户可覆盖** | 用户可在客户端显式选择其他候选（知情风险） |

### 4.3 多记录类型共存

- 同一域名可同时有 A/SRV/TXT 多类记录候选；客户端按 `record_type` 分组，各组内独立排序与选择。
- TXT（did:dns:）候选用于身份验证（指纹链校验，did-dns-protocol §3）；A/SRV 候选用于连接。

---

## 5. direct / relay 候选类型（与节点 FR8/Node 文档 14 一致）

### 5.1 direct 候选（直连，权重优先）

| 字段 | 说明 |
|---|---|
| `candidate_type` | `direct` |
| `content` | `IP:port`（直连端点） |
| `tunnel_id` | `null` |
| 适用 | 公网可达节点（有公网 IP / 端口转发） |
| 权重倾向 | direct 候选**默认权重优先**（直连低延迟、无中继依赖） |

### 5.2 relay 候选（中继兜底）

| 字段 | 说明 |
|---|---|
| `candidate_type` | `relay` |
| `content` | 中继端点（relay endpoint，如 `relay.example.com:443`） |
| `tunnel_id` | 隧道标识（具体编码归波 1 T7 实机验证，本文件不定型 wire 格式） |
| 适用 | NAT 后节点（无公网 IP），**仅能提供 relay 候选**（02 篇 FR8） |
| 权重倾向 | relay 候选权重通常低于 direct（中继增加延迟与依赖） |

### 5.3 回退顺序（direct → relay，FR8）

客户端按 **direct → relay** 顺序回退：

```
1. 优先尝试 direct 候选（排序后的 direct 列表，权重高→低）
   ├─ direct 可达 → 使用 direct（结束）
   └─ direct 全部不可达 → 回退 relay
2. 回退 relay 候选（排序后的 relay 列表，权重高→低）
   ├─ relay 可达 → 使用 relay（结束）
   └─ relay 全部不可达 → 解析失败（返回错误，fail-closed 不静默兜底到伪节点）
```

### 5.4 NAT 后节点的候选约束（02 篇 FR8）

- NAT 后节点**只能提供 relay 候选**（无公网 IP，无法 direct）。
- 客户端解析此类节点时，候选数组中 `candidate_type` 全为 `relay`，按 §5.3 跳过 direct 步骤。

---

## 6. 与 T1/T3/T9 的互引

### 6.1 消费 T1（answer 包）

- T4 候选 schema 与 T1 §3.1.4 `answer.candidates[]` 字段逐项一致。
- `hops` = T1 `forward_chain.length - 1`（发起方为 0 跳）。

### 6.2 消费 T3（trust_weight）

- T4 排序键消费 T3 权重值（路径权重 min 聚合 / 本地权重）。
- T3 定义权重值与取值域，T4 定义排序应用（不重定义权重）。

### 6.3 引用 T9（候选权重签名）

- 候选 `trust_weight` 字段**MUST 纳入 T9 签名覆盖范围**（T9 §9.3.2 第 5 项），防候选权重被中转篡改。
- **引用 T9 草案·未会签·单边定稿无效**，P-FLOOD 不重定义签名覆盖。

---

## 7. 自测门禁（交付前自查）

| # | 门禁项 | 本草案结论 |
|---|---|---|
| T4-1 | 排序键与节点 FR7 字段顺序一致（`trust_weight DESC, hops ASC, TTL DESC`） | ✅ §3.1（逐字段方向与 FR7 一致） |
| T4-2 | direct/relay 类型与节点 FR8/Node 文档 14 一致 | ✅ §5（direct=IP:port，relay=中继端点+tunnel_id，NAT 后仅 relay） |
| T4-3 | 不做唯一性裁决（返回全部候选） | ✅ §4（协议不裁决，纠纷留法律，客户端自行选择） |
| T4-4 | 候选 schema 与节点 answer 包/dns_resolve_cache 对齐 | ✅ §2（字段与 02 篇 §4 + T1 §3.1.4 逐项一致） |
| T4-5 | 候选权重在 T9 签名覆盖内（引用 T9 不重定义） | ✅ §6.3（引用 T9 §9.3.2） |
| T4-6 | `grep -ri aura` 零残留 | ✅ |
| T4-7 | 引用编号一致（FR7/FR8/T1/T3/T4/T7/T9） | ✅ |

---

## 8. 待会签 / 待定稿项（标注「草案」）

| 项 | 归属 | 状态 |
|---|---|---|
| answer 包 wire（candidates 承载） | T1 / P-FLOOD | **引用 T1 草案·未会签** |
| trust_weight 取值与聚合 | T3 / P-FLOOD | **引用 T3 草案·未会签** |
| 候选权重签名覆盖 | T9 / P-ARCH | **引用 T9 草案·未会签** |
| relay tunnel_id wire 编码 | 已在 relay_protocol.md 定型（KNET-CC-013，2026-08-24 会签） | 本文件不定型，引用不重定义 |
| 客户端默认策略（取首位/direct优先） | T4 会签定稿 | 草案建议，待会签 |

---

## 9. 版本与变更

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-08-08 | P-FLOOD 首版草案：候选 schema（§2，与 02 篇 answer/dns_resolve_cache 对齐）+ 排序键（§3，`(trust_weight DESC, hops ASC, TTL DESC)` 与 FR7 一致）+ 客户端选择（§4，返回全部不做唯一性裁决，纠纷留法律）+ direct/relay 类型（§5，direct 权重优先 ↔ relay 中继兜底，NAT 后仅 relay，direct→relay 回退，与 FR8 一致）+ 与 T1/T3/T9 互引（§6，候选权重纳入 T9 签名覆盖）。**未会签·单边定稿无效**。 |

---

*本文件为 T4 多候选解析格式草案 v0.1。强制会签项，须经节点 PM 会签（KNET-CC）后方可标「定稿」。候选 schema 引用 T1 answer 包、权重引用 T3、签名覆盖引用 T9、relay tunnel 编码留波 1 T7，均不重定义。*
