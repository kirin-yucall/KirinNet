# KirinNet 节点规格说明书

**版本:** 2.7.0
**日期:** 2026-07-10
**存储:** DuckDB + 本地文件系统

---

## 1. 核心理念

每个节点是 KirinNet 去中心化生态的完整运行单元。一个 Docker 镜像包含全部能力：
内容管理、IM 通信、交易密钥、广告位竞价、粉丝订阅、积分/VIP 体系、公共索引、域名黑名单、DNS 管理。

**一个镜像，全部内置：**

- 关掉公共索引 → 私人内容站，安静自用
- 打开公共索引 → 接收推送，搜索全网内容，赚广告费
- 无论哪种，内容和收入永远归节点主人

所有控制项都在 settings 表中，Web UI 实时切换，重启不丢。

---

## 2. 访问流程

| 状态 | 访问 `/` | 说明 |
|:--|:--|:--|
| 未初始化 | → `init.html` | 设置密码、域名、DNS |
| 已初始化 | → `login.html` | 每次打开都需输入管理密码 |
| 登录成功 | → `/app` | 进入主界面（展示/内容/交易/中心） |

密码以 bcryptjs 哈希存储，Bearer Token 认证。登录态仅存在于浏览器 sessionStorage，关闭标签页即失效。

---

## 3. 架构

```
┌─────────────────────────────────────────┐
│           kirinnet-node (Docker)         │
│  ┌───────────────────────────────────┐  │
│  │         Express API Server         │  │
│  │  ┌─────┬──────┬──────┬─────────┐  │  │
│  │  │内容 │ IM   │广告位│ 粉丝/VIP │  │  │
│  │  │管理 │ 交易 │竞价  │ 变现     │  │  │
│  │  ├─────┴──────┴──────┴─────────┤  │  │
│  │  │   公共索引 + 黑名单 + DNS    │  │  │
│  │  └─────────────────────────────┘  │  │
│  ┌───────────────────────────────────┐  │
│  │     DuckDB (columnar, single file)│  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │   /app/data/media/  静态文件存储   │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

- 单容器，无需外部数据库
- DuckDB 列式存储，所有表在一个文件
- 数据挂载 `/app/data` 持久化

---

## 4. 部署

```bash
docker run -d --name my-node \
  --restart unless-stopped \
  -p 8080:8080 \
  -v ./data:/app/data \
  kirinnet-node
```

| 环境变量 | 默认值 | 说明 |
|:--|:--|:--|
| `PORT` | `8080` | 监听端口 |
| `DOMAIN` | — | 节点域名（首次默认） |
| `ENABLE_INDEXING` | `true` | 初始索引开关（仅首次启动） |

---

## 5. 设置系统

所有运行时控制都存储在 `settings` 表中，通过 Web UI 或 API 操作：

```
GET    /api/settings           → 当前值
GET    /api/settings/describe  → 字段说明
PATCH  /api/settings           → 修改 { "key": "value" }
```

| 设置项 | 类型 | 默认 | 说明 |
|:--|:--|:--|:--|
| `public_indexing` | bool | true | 公共索引开关 |
| `ad_slots_per_page` | int | 2 | 每页广告位数量 |
| `ad_reserve_days` | int | 7 | 广告位提前预定天数 |
| `ad_max_duration_days` | int | 30 | 广告位单次最长天数 |
| `node_domain` | text | — | 节点域名（改后需重启） |
| `node_port` | number | 8080 | 监听端口（改后需重启） |
| `dns_provider` | select | — | DNS 服务商（12 家可选） |
| `dns_api_key` | password | — | DNS API Key |

---

## 6. 功能模块

### 6.1 内容管理

上传、展示、评论、删除内容。支持评论权限控制：
- `all` — 所有人可评论
- `followers` — 仅粉丝可评论
- `none` — 禁止评论

支持积分/VIP 付费墙：`required_points` / `required_vip`。

### 6.2 粉丝系统

单向订阅：粉丝提供公钥，节点自动用 RSA-OAEP 加密公开内容推送给粉丝。

### 6.3 积分与 VIP

节点主人发行的经济体系：
- 发放积分 → 消费积分解锁内容
- VIP 等级订阅，按时间过期

### 6.4 广告位竞价

每页可配置 N 个广告位，任意域名竞拍，出价高者得：
- 提前 N 天生成广告位商品
- 竞价截止前 N 天停止出价
- 收入归节点主人

### 6.5 公共索引

开启后，其他节点可推送内容到本节点：
- `POST /api/indexer/publish` — 接收内容（自动过滤黑名单域名）
- `GET /api/indexer/search` — 全文搜索
- `GET /api/indexer/swipe` — 滑动浏览
- `GET /api/indexer/ads` — 展示当前页面广告

关闭后以上接口返回 403。

### 6.6 内容审核

管理后台可隐藏/恢复索引内容、管理域名黑名单：
- `POST /api/indexer/hide/:id` — 隐藏内容
- `POST /api/indexer/show/:id` — 恢复显示
- `POST /api/indexer/blacklist` — 拉黑域名（自动隐藏该域名所有内容）
- `DELETE /api/indexer/blacklist/:domain` — 解封

### 6.7 IM 分组与交易密钥

- 创建分组（好友/交易/自定义）
- 发送临时交易密钥（90 天过期）
- 接受密钥 → 自动创建交易分组

### 6.8 地址簿

多地址管理（收货/付款）。

### 6.9 DNS 管理

- 支持 12 家 DNS 服务商
- Cloudflare API 已完整实现（list zones、update DNS records）
- `POST /api/dns/update` — 自动更新 DNS A/SRV 记录
- `GET /api/dns/status` — 检查配置状态

### 6.10 推送到其他节点

通过 DNS-over-HTTPS 验证目标节点后推送内容。

### 6.11 政府 CA 证书

上传 `.pem` 格式 CA 证书。上传后需重启生效。

### 6.12 重启

`POST /api/restart` → 优雅关闭 → Docker 自动重启（需 `--restart unless-stopped`）。

---

## 7. 数据库

DuckDB，所有表在 `/app/data/duckdb/kirinnet_user_node.db`：

| 表 | 用途 |
|:--|:--|
| `node` | 节点基本信息（ID, 昵称, 头像, 密码哈希） |
| `settings` | 运行时配置（K-V） |
| `content` | 本节点内容 |
| `comments` | 评论 |
| `im_groups` / `im_group_members` | IM 分组 |
| `im_temp_keys` | 临时交易密钥 |
| `marketplace_addresses` | 收货/付款地址 |
| `followers` | 粉丝公钥 |
| `encrypted_pushes` | 加密推送记录 |
| `points_accounts` / `points_transactions` | 积分系统 |
| `vip_accounts` | VIP 订阅 |
| `ad_slot_products` / `ad_slot_bids` | 广告位竞价 |
| `indexed_content` / `ingestion_log` | 索引器内容 |
| `push_blacklist` | 推送域名黑名单 |

---

## 8. 认证

- 未初始化时所有 API 免认证
- 初始化后使用 Bearer Token：`Authorization: Bearer <密码>`
- Web 端：login.html 验证后将密码存入 sessionStorage，关闭标签页失效
- 密码用 bcryptjs 哈希存储

---

## 9. 相关文档

- [完整 API 文档](./api.md)
- [安全模型](../01_Standard/security_model_v1.md)
- [协议规格](../01_Standard/spec_v1.md)
