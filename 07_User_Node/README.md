# 🦄 KirinNet 麒麟网 — 用户节点

**⚠️ 架构声明：这是 KirinNet 唯一的镜像。08/09 的功能已全部整合进本节点。**

**去中心化内容平台** — 自包含 P2P 节点，去中心化身份，内容主权完全自控。

---

## 快速启动

```bash
# 构建镜像
docker build -t kirinnet-node:latest .

# 运行
docker run -d --name kirin-node \
  -p 8080:8080 \
  -v /path/to/data:/app/data \
  --restart unless-stopped \
  kirinnet-node:latest
```

首次访问 `http://localhost:8080` → 初始化向导 → 设置密码和域名 → 登录 → 进入管理面板。

> **密码无法找回，请在初始化时用纸笔记下。**

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | HTTP 服务端口 |
| `DATA_DIR` | `/app/data` | 持久化数据目录（DuckDB + 媒体文件） |
| `NODE_ENV` | `production` | 运行模式 |

### 数据目录结构

```
/app/data/
├── duckdb/              # DuckDB 数据库文件
│   └── kirinnet_user_node.db
└── media/               # 上传的媒体文件
    ├── im/              #   聊天附件 (图片/语音/文件)
    └── *.uuid.ext       #   内容文件
```

---

## Docker 部署

```bash
# 构建 (需在 07_User_Node 目录执行)
cd KirinNet_Project/07_User_Node
DOCKER_BUILDKIT=0 docker build -t kirinnet-node:latest .

# 基础部署
docker run -d --name kirin-node \
  -p 8080:8080 \
  -v /srv/kirin-data:/app/data \
  --restart unless-stopped \
  kirinnet-node:latest

# 自定义端口
docker run -d --name kirin-node \
  -p 9090:9090 \
  -e PORT=9090 \
  -v /srv/kirin-data:/app/data \
  --restart unless-stopped \
  kirinnet-node:latest

# 查看日志
docker logs -f kirin-node

# 停止/重启
docker stop kirin-node
docker start kirin-node
```

**镜像信息**: `node:20-slim` 基础镜像，~300MB 构建后大小。DuckDB 预编译二进制，无重型构建依赖。

---

## 核心设计

- **去中心化身份** — 域名即身份，无邮箱/手机号注册
- **内容主权** — 所有数据（文章/视频/音频/商品）存储在本节点
- **粉丝加密** — 粉丝提供公钥 → 节点发布时自动加密推送，端到端不可窃听
- **DNS 信任** — 客户端 DOH 验证域名所有权，无中心化 CA 依赖
- **开放索引** — 可选开启公共索引，其他节点通过 DNS 发现
- **单镜像全能力** — 一个 Docker 镜像包含全部功能，无需外部数据库

---

## 功能模块

### 📡 展示
| 子页面 | 说明 |
|---|---|
| 内容广场 | 浏览聚合内容 |
| 广告展示 | 竞价广告位展示 |
| 🔍 探索 | 方向驱动探索，主动发现内容（替代搜索） |
| 方向设置 | 管理探索方向：9 个预设 + 自定义 |
| 🚫 过滤 | 黑名单关键词过滤（恐怖/血腥/暴力…） |
| 分类浏览 | 按文章/商品/帖子/视频分类查看 |

### 📝 内容
| 子页面 | 说明 |
|---|---|
| 发布内容 | 文件上传 + 纯文本，支持标签系统 |
| 我的内容 | 查看/管理已发布内容 |
| 草稿箱 | 保存未发布草稿，编辑/发布 |
| 回收站 | 已删除内容恢复/永久删除 |
| 足迹 | 浏览历史，支持清空 |
| 订阅管理 | 管理关注的节点 |
| 粉丝管理 | 管理关注者 |
| 评论管理 | 查看/删除本节点所有评论 |

### 💰 交易
| 子页面 | 说明 |
|---|---|
| 广告位竞价 | 出价竞投页面广告位 |
| 卖出订单 | 管理售出订单（待付款→已发货→已完成） |
| 购买订单 | 管理购买订单 |
| 购物车 | 购物车管理 |
| 我的收藏 | 收藏内容管理 |
| 优惠卡券 | 创建/验证/使用优惠券 |
| 支付设置 | 支付宝/微信/银行/PayPal/加密货币 |
| 收款设置 | 收款账户管理 |
| 地址管理 | 收货地址 |
| 积分VIP | 积分发放/消费 + VIP 订阅 |

### 💬 消息
| 子页面 | 说明 |
|---|---|
| 群聊 | 分组群聊（好友/交易/临时联系人），支持图片/语音/文件 |
| 私聊 | 一对一聊天，媒体附件 |
| 通知 | 关注/订阅/系统通知，标记已读 |
| 分组管理 | 创建/删除 IM 分组，管理成员 |
| 交易密钥 | 生成临时 RSA 密钥对（90 天过期）|

### ⚙️ 中心
| 子页面 | 说明 |
|---|---|
| 节点设置 | 端口/域名/DNS/索引开关/CA 证书 |
| 个人资料 | 昵称/头像/域名 |
| 粉丝管理 | 查看所有粉丝 |
| 数据统计 | 内容数/粉丝数/访问量/收入摘要 |
| 运行日志 | Docker 日志查看指引 |
| 关于 | 版本/技术栈/GitHub |

---

## 探索系统 🔍

替代传统"搜索"的主动发现系统：

1. **设定方向** — 9 个预设方向（励志/中考/高考/考研/编程/修理/电路/音乐/冥想），可自定义关键词和图标
2. **主动探索** — 点击"开始探索"触发爬虫，按方向关键词匹配网络内容
3. **智能过滤** — 内置 6 个黑名单关键词（恐怖/血腥/暴力/犯罪/色情/赌博），可自定义扩展
4. **去重收录** — SHA-256 内容哈希，相似内容自动跳过
5. **结果管理** — 浏览/搜索/收藏/删除收录结果

```
内容发布 → 弹性分段哈希 → 相似度检测 → 同质化告警
探索触发 → 关键词搜索 → 黑名单过滤 → 哈希去重 → 收录进方向
```

---

## 弹性分段去重

发布内容时自动计算弹性分段 SHA-256 哈希：

| 内容大小 | 分段数 | 每段大小 |
|---|---|---|
| < 300 字 | 1 段 | ~300 |
| 300–1000 | 2–3 段 | ~300-500 |
| 1000–3000 | 4–6 段 | ~500 |
| 3000–10000 | 7–10 段 | ~500-1000 |
| > 10000 | 10 段（max）| ~1000+ |

每段记录哈希 + 前 200 字样本。Jaccard 相似度 > 70% 触发告警（不阻止发布）。

---

## 数据库

**DuckDB** (嵌入式 OLAP 引擎)，30 张表：

| 模块 | 表 |
|---|---|
| 节点 | `node`, `settings`, `dns_records` |
| 内容 | `content`, `content_segments`, `comments` |
| 探索 | `explore_directions`, `explore_results`, `explore_blacklist` |
| 社交 | `followers`, `encrypted_pushes`, `contacts`, `notifications` |
| IM | `im_groups`, `im_messages`, `im_temp_keys`, `im_group_members` |
| 交易 | `cart`, `favorites`, `history`, `drafts`, `orders`, `coupons`, `payment_methods`, `marketplace_addresses` |
| 积分/VIP | `points_accounts`, `points_transactions`, `vip_accounts` |
| 广告 | `ad_slot_products`, `ad_slot_bids` |
| 索引 | `indexed_content`, `ingestion_log`, `push_blacklist` |

---

## API 端点总览

**22 个路由模块，~134 个端点：**

| 模块 | 路由文件 | 主要端点 |
|---|---|---|
| 认证 | `kirin.js` | init, profile, login, restart, ca-cert |
| 内容 | `content.js` | upload, content CRUD, comments |
| 草稿 | `drafts.js` | drafts CRUD + publish |
| 购物车 | `cart.js` | cart CRUD + clear |
| 收藏 | `favorites.js` | favorites CRUD + check |
| 足迹 | `history.js` | history CRUD + clear |
| 订单 | `orders.js` | orders CRUD + status transition |
| 优惠券 | `coupons.js` | coupons CRUD + validate + use |
| 支付 | `payment_methods.js` | payment methods CRUD + set default |
| 联系人 | `contacts.js` | contacts CRUD + block/unblock |
| 通知 | `notifications.js` | notifications CRUD + read/unread |
| 消息 | `im.js` | groups CRUD + members |
| 消息 | `im_messages.js` | messages (group/private/history) |
| 地址 | `addresses.js` | marketplace addresses CRUD |
| 粉丝 | `followers.js` | followers subscribe/unsubscribe |
| 积分VIP | `monetize.js` | points + VIP accounts |
| 广告 | `ad-auction.js` | ad slot products + bids |
| 索引 | `indexer.js` | indexed content search/list |
| 推送 | `push.js` | push send/receive/delivery |
| 设置 | `settings.js` | runtime settings CRUD |
| DNS | `dns.js` | DNS record management |
| 探索 | `explore.js` | directions CRUD + crawl + results + blacklist |

详见 [api.md](./api.md)

---

## 项目结构

```
07_User_Node/
├── server.js              # 入口，22 路由注册
├── Dockerfile             # 单镜像构建 (node:20-slim)
├── package.json
│
├── models/
│   └── database.js        # DuckDB 表定义（30 张表 + 序列）
│
├── routes/                # 22 个路由模块
│   ├── kirin.js           # 认证/初始化/个人资料
│   ├── content.js         # 内容发布 + 标签 + 分段哈希
│   ├── drafts.js          # 草稿箱
│   ├── cart.js            # 购物车
│   ├── favorites.js       # 收藏
│   ├── history.js         # 足迹
│   ├── orders.js          # 订单
│   ├── coupons.js         # 优惠券
│   ├── payment_methods.js # 支付方式
│   ├── contacts.js        # 联系人
│   ├── notifications.js   # 通知
│   ├── im.js              # IM 分组 + 成员管理
│   ├── im_messages.js     # 群聊 + 私聊消息
│   ├── addresses.js       # 收货地址
│   ├── followers.js       # 粉丝系统
│   ├── monetize.js        # 积分/VIP
│   ├── ad-auction.js      # 广告竞价
│   ├── indexer.js         # 公共索引
│   ├── push.js            # 推送
│   ├── settings.js        # 运行时设置
│   ├── dns.js             # DNS 管理
│   └── explore.js         # 探索（方向 + 爬取 + 黑名单）
│
├── lib/
│   └── segment-hash.js    # 弹性分段哈希 + 相似度检测 + 黑名单过滤
│
├── public/
│   ├── init.html          # 初始化向导
│   ├── login.html         # 登录页（72h 自动续期）
│   ├── index.html         # 主 SPA（36 子页面）
│   ├── pages_content.js   # 草稿/回收站/足迹/订阅/粉丝
│   ├── pages_trade.js     # 订单/购物车/收藏/卡券/支付/收款
│   ├── pages_im.js        # 私聊/通知/群成员管理
│   ├── pages_display.js   # 展示/分类浏览
│   ├── pages_center.js    # 统计/日志/关于
│   └── pages_explore.js   # 探索主页 + 方向设置 + 黑名单
│
├── spec.md                # 规格说明
└── api.md                 # API 文档
```

---

## 技术栈

| 层面 | 技术 |
|---|---|
| 运行时 | Node.js 20 |
| 数据库 | DuckDB（嵌入式 OLAP，列式存储） |
| 哈希 | SHA-256 (Node crypto) |
| 加密 | RSA-OAEP + bcrypt + AES-256-GCM |
| 文件存储 | 本地文件系统 |
| 文件上传 | multer |
| 容器 | Docker (node:20-slim) |
| 前端 | 原生 JS SPA（零框架，~40KB） |
| 认证 | Bearer Token + localStorage 72h 持久化 |

---

## 架构决策

- **DuckDB, 非 SQLite** — 列式 OLAP，分析查询快。INSERT 用 `RETURNING`，冲突用 `ON CONFLICT DO NOTHING`
- **单镜像，无模式切换** — 所有路由常驻，功能通过 `settings` 表开关控制
- **密码无找回** — 去中心化节点的设计代价：忘记密码 = 重置数据
- **登录态 72h** — localStorage 持久化，24h 自动续期，48h+ 重新打开页面需重登
- **探索 > 搜索** — 主动方向设定，避免算法投喂和刷抖音式入迷
- **弹性分段哈希** — 内容大小自适应分段数，Jaccard 相似度去重，发布时不阻止只告警

---

## GitHub

- 主仓库: [kirin-yucall/KirinNet](https://github.com/kirin-yucall/KirinNet)
- 子仓库: [kirin-yucall/kirin-dns-go](https://github.com/kirin-yucall/kirin-dns-go) (Go DNS 库)
- 子仓库: [kirin-yucall/kirin-dns-rs](https://github.com/kirin-yucall/kirin-dns-rs) (Rust DNS 库)
- npm: `kirin-dns`
