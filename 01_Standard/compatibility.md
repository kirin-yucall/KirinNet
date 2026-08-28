# KirinDNS 兼容性规范（ADRP Compatibility）

> **Version:** 1.1
> **Status:** Draft
> **Date:** 2026-08-08（v1.1 修订 2026-08-28）
> **Scope:** KirinDNS Resolution Protocol (ADRP) 与存量 Web 基础设施的共存边界：HTTP/HTTPS 兼容、SRV/TXT 叠放、端口回退。
> **依据:** `spec_v1.md` §2.2/§2.5/§3.1/§3.3/§5.2、`dns_automation.md` §1/§2、`did-dns-protocol.md` §6。
> **裁决:** 甲方裁决纳入阶段一范围（`docs\协作记录.md` §COM-01，2026-08-08）。
> **注：** v1.1 为 KNET-CC-016 修订（§3 叠放规则同步 + 示例 owner 对齐；已会签定稿——2026-08-28 节点 PM 会签通过 + 协议 PM 合并 master 4b81db4 联合关闭）。

---

## 1. 设计原则：严格加性，向后兼容

KirinDNS (ADRP) 是一个**严格加性（strictly additive）**的发现层，不引入新的 DNS 记录类型、不修改 A/AAAA 解析、不占用新端口。它与存量 Web 基础设施共存时遵循一条核心原则：

> **未部署 ADRP 记录的域名，行为与部署前完全一致。**

这意味着：

- 没有 `_kirinnet-*` SRV 记录的域名 → 客户端回退标准端口（80/443），Web 照常访问。
- 没有 `did:dns:` TXT 记录的域名 → 客户端跳过身份验证，按普通网站处理。
- ADRP 记录与 SPF/DKIM/DMARC 等存量 TXT 记录**并存**，互不干扰。

ADRP 是正交于传统 DNS 的发现层，不要求存量 Web 做任何改动。

---

## 2. HTTP/HTTPS 兼容

### 2.1 SRV 服务名与存量端口的关系

ADRP 定义三个 SRV 服务名（见 `spec_v1.md` §2.2），仅在客户端**主动查询**这些服务名时生效，不影响 80/443 的默认行为：

| 服务 | SRV 名称 | 默认端口（无 SRV 时） | 说明 |
|---|---|---|---|
| HTTP | `_kirinnet-http._tcp` | 80 | REST API / HTTP 服务 |
| HTTPS | `_kirinnet-https._tcp` | 443 | TLS REST API（可选） |
| WebSocket | `_kirinnet-ws._tcp` | 80（WS）/ 443（WSS） | 实时消息 |

存量浏览器/Web 客户端**不查询** `_kirinnet-*` 记录，因此完全不受 ADRP 影响——它们继续连接 80/443。

### 2.2 Host 头与 SRV target

当客户端通过 SRV 发现非标准端口或不同 target 主机时（见 `spec_v1.md` §5.2）：

- **TCP 连接**目标：SRV 记录的 `<target>:<port>`（可能不同于原域名）。
- **HTTP `Host` 头**：MUST 携带**原始域名**（查询的域名），**不是** SRV target 主机名。

这一规则确保：反向代理、虚拟主机、CDN 等存量 Web 基础设施按原始域名路由请求，SRV 仅影响初始 TCP 连接的目标地址与端口，应用层协议行为不变。

```
; 客户端查询 alice.kirinnet.org 的 WebSocket 端口
_kirinnet-ws._tcp.alice.kirinnet.org.  300  IN  SRV  0 0 8082 node2.alice.kirinnet.org.

; 客户端连接 node2.alice.kirinnet.org:8082
; 但 WebSocket 握手 Host 头为 alice.kirinnet.org（原域名）
```

### 2.3 TLS 证书校验

对于 HTTPS/WSS 连接（见 `spec_v1.md` §4.1）：

- 客户端 MUST 校验 TLS 证书，**无论端口是否由 SRV 发现**。
- 证书的 Subject Alternative Name (SAN) MUST 匹配**原始域名**，**不是** SRV target 主机名。

这保证 SRV 重定向不会绕过证书校验——即使 SRV 被劫持指向攻击者主机，证书 SAN 不匹配会导致 TLS 握手失败。

---

## 3. SRV/TXT 叠放（共存）

### 3.1 同一域名多记录并存

KirinDNS 节点的 DNS 区文件中，SRV 记录（服务发现）与 TXT 记录（身份验证）与存量记录**叠放共存**（见 `dns_automation.md` §1、`did-dns-protocol.md` §6）：

```
; ===== A/AAAA — IP 地址（存量）=====
alice.kirinnet.org.      300  IN  A     203.0.113.10
alice.kirinnet.org.      300  IN  AAAA  2001:db8::1

; ===== SRV — 服务发现（ADRP）=====
_kirinnet-ws._tcp.alice.kirinnet.org.    300  IN  SRV  0 0 8082 alice.kirinnet.org.
_kirinnet-http._tcp.alice.kirinnet.org.  300  IN  SRV  0 0 8080 alice.kirinnet.org.
_kirinnet-https._tcp.alice.kirinnet.org. 300  IN  SRV  0 0 8443 alice.kirinnet.org.

; ===== TXT — 身份验证（ADRP DID-DNS 三记录；owner = _kirinnet.did.<域名>，见 did-dns-protocol §2.4 / KNET-CC-016 定稿）=====
_kirinnet.did.alice.kirinnet.org.  300  IN  TXT  "did:dns:v=1;fp=AbCdEf1234aaaa;n=QWxpY2U;g=F;iat=1712345678;exp=1712432078"
_kirinnet.did.alice.kirinnet.org.  300  IN  TXT  "did:dns:pk;kty=ed25519;pk=MCowBQYDK2VwAyEA..."
_kirinnet.did.alice.kirinnet.org.  300  IN  TXT  "did:dns:black;fp=OldKeyFp1,OldKeyFp2"
; （可选 MAY：apex alice.kirinnet.org. 双发同一组记录，解析方前缀名优先、apex 回退，见 did-dns-protocol §2.4）

; ===== TXT — 存量邮件/Web 记录（不受影响）=====
alice.kirinnet.org.  300  IN  TXT  "v=spf1 include:_spf.kirinnet.org ~all"
_dmarc.alice.kirinnet.org.  300  IN  TXT  "v=DMARC1; p=quarantine;"
```

### 3.2 解析时的前缀分类规则

同一域名可有多条 TXT 记录，客户端**按前缀分类提取**，不冲突（见 `did-dns-protocol.md` §6、`dns_automation.md` §3）：

| TXT 值前缀 | 归属 | 处理方式 |
|---|---|---|
| `did:dns:v=` | ADRP 身份声明 | DID-DNS 协议解析（提取 v/fp/n/g/iat/exp） |
| `did:dns:pk;` | ADRP 公钥 | DID-DNS 协议解析（提取 kty/pk，校验 fp） |
| `did:dns:black;` | ADRP 黑名单 | DID-DNS 协议解析（提取撤销指纹列表） |
| `v=spf1`、`v=DMARC1`、DKIM 等 | 存量邮件/Web | 按原有标准处理，ADRP 客户端忽略 |

**关键约束**：ADRP 客户端只识别 `did:dns:` 前缀的记录；非 `did:dns:` 记录静默忽略，不影响存量邮件/Web 系统。反之，存量 SPF/DKIM/DMARC 解析器不识别 `did:dns:` 前缀，按未知 TXT 记录处理，同样不受影响。

> **叠放规则同步（KNET-CC-016 已会签定稿，2026-08-28 节点 PM 会签通过 + 协议 PM 合并 master 4b81db4 联合关闭）：** 自本修订起，did:dns 身份 TXT 的 owner 名为 `_kirinnet.did.<域名>`（规范位置，`did-dns-protocol.md` §2.4）——与 apex 的 SPF/DKIM/DMARC 等存量 TXT **按 owner 名隔离叠放**，本节前缀分类规则不变（分类作用于所查 owner 名返回的 TXT 集合）；解析方 SHOULD 前缀名优先、无 `did:dns:` 记录时回退 apex（RECOMMENDED），回退查到的 TXT 同按 §3.2 分类表处理；SRV 记录 owner 不受影响。

### 3.3 单条 TXT ≤200 字节

DID-DNS 三类记录单条均 ≤200 字节（见 `DECISIONS.md` §9.2.4 实测核算：身份声明 73B / 公钥 69B / 黑名单 44B），远低于 DNS TXT 记录 255 字节 RDATA 上限，**不触发 UDP 分片**，与存量 DNS 解析器完全兼容。

---

## 4. 端口回退（无 SRV 时）

### 4.1 回退规则

当客户端查询某服务的 SRV 记录返回 **NXDOMAIN** 或 **NOERROR 且应答区为空**（即域名未部署 ADRP SRV 记录），客户端 MUST 回退到该服务的标准端口（见 `spec_v1.md` §2.5、§3.3.1 Step 4）：

| 服务 | 回退端口 |
|---|---|
| HTTP | 80 |
| HTTPS | 443 |
| WebSocket（WS） | 80 |
| WebSocket Secure（WSS） | 443 |

### 4.2 部分子集部署

域名 MAY 只为部分服务部署 SRV 记录（见 `spec_v1.md` §3.1.2）。例如，仅暴露 HTTPS 的域名可省略 `_kirinnet-http._tcp` 和 `_kirinnet-ws._tcp`：

```
; 仅部署 HTTPS SRV
_kirinnet-https._tcp.alice.kirinnet.org.  300  IN  SRV  0 0 443 alice.kirinnet.org.
; 未部署 _kirinnet-http 和 _kirinnet-ws → 客户端查询时回退 80
```

客户端对每个服务**独立**应用回退规则：缺失的服务回退标准端口，已部署的服务用 SRV 端口。

### 4.3 回退保证向后兼容

回退机制确保 ADRP 是**严格向后兼容**的：

- **存量域名**（无任何 `_kirinnet-*` 记录）：所有服务查询均回退 80/443，行为与部署 ADRP 前完全一致。
- **存量 Web 客户端**（不查询 SRV）：直接连接 80/443，不知道 ADRP 存在。
- **渐进部署**：域名可按需逐个服务添加 SRV 记录，未添加的服务保持标准端口，无需一次性迁移。

---

## 5. 加密 DNS 传输（DoH/DoT）兼容性

ADRP 强制要求 SRV/TXT 查询走 DoT（RFC 7858）或 DoH（RFC 8484），禁明文 53（见 `spec_v1.md` §4.3、`security_model_v1.md` §7.3）。此要求**仅适用于 ADRP 客户端的发现查询**，不约束存量 Web 的常规 A/AAAA 解析（存量解析器可继续用明文 53 解析 IP，ADRP 不干预）。

- 客户端不具备 DoH/DoT 能力时：身份记录解析失败，按 fail-closed 处理（降级告警/拒绝采信，见 `security_model_v1.md` §7.3），但**不影响**该域名的普通 Web 访问（Web 访问用 A/AAAA + 80/443，与 ADRP 无关）。

---

## 6. 兼容性矩阵

| 场景 | 域名侧 | 客户端侧 | 行为 |
|---|---|---|---|
| 完整 ADRP 部署 | SRV + did:dns TXT 齐全 | ADRP 客户端（DoH/DoT） | SRV 发现端口 + DID-DNS 身份验证 |
| 仅身份无 SRV | did:dns TXT 部署，无 SRV | ADRP 客户端 | 端口回退 80/443 + 身份验证 |
| 仅 SRV 无身份 | SRV 部署，无 did:dns TXT | ADRP 客户端 | SRV 发现端口，跳过身份验证（null identity） |
| 存量域名 | 无任何 ADRP 记录 | ADRP 客户端 | 端口回退 80/443，跳过身份验证 |
| ADRP 域名 + 存量客户端 | SRV + did:dns TXT 齐全 | 存量 Web 客户端（不查 SRV） | 直接 80/443，不知 ADRP 存在 |
| 邮件/Web 记录共存 | SPF/DKIM/DMARC + did:dns TXT | ADRP + 邮件客户端 | 前缀分类，互不干扰 |

---

## 7. 变更记录

| 版本 | 日期 | 变更 | 依据 |
|---|---|---|---|
| 1.0 | 2026-08-08 | 首版：存量 Web 兼容边界（HTTP/HTTPS 兼容、SRV/TXT 叠放、端口回退）；从 0 字节空文件填充 | 9.6 · 波0 · 甲方裁决（§COM-01） |
| 1.1 | 2026-08-28 | **§3 叠放规则同步（KNET-CC-016，后经会签定稿闭环：2026-08-28 节点 PM 会签通过 + 协议 PM 合并 master 4b81db4 联合关闭）**：§3.2 关键约束后新增同步段——did:dns 身份 TXT owner 名=`_kirinnet.did.<域名>`（与 apex SPF/DKIM/DMARC 按 owner 名隔离叠放，前缀分类规则不变；解析前缀名优先、apex 回退 RECOMMENDED；SRV owner 不受影响，权威定义 `did-dns-protocol.md` §2.4）。**冲突最小修订：**§3.1 示例三行身份 TXT owner `alice.kirinnet.org.` → `_kirinnet.did.alice.kirinnet.org.`（+可选双发注行；apex SPF/DMARC 行原样保留）。背景：波 2 对照表 CC-3 | KNET-CC-016（已会签定稿·联合关闭 2026-08-28 master 4b81db4）· 波2 对照表 CC-3 · 协议PM 裁定（2026-08-28 10:50）· 波2 |
