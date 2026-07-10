# KirinNet 节点 API 接口文档

**版本:** 2.7.0 | **认证:** Bearer Token (`Authorization: Bearer <密码>`)

> 未初始化时所有接口免认证。初始化后需 Bearer Token。
> Web 端通过 `login.html` 验证密码，存入 sessionStorage。关闭标签页失效，每次打开都需重新登录。

---

## 0. 访问流程

| 端点 | 用途 |
|:--|:--|
| `/` | 根路由。未初始化→`init.html`，已初始化→`login.html` |
| `/init.html` | 首次设置密码、域名、DNS |
| `/login.html` | 每次打开输入管理密码 |
| `/app` | 主 SPA 界面（需已登录，通过 sessionStorage 校验） |

---

## 1. 初始化

| 方法 | 路径 | 认证 | 说明 |
|:--|:--|:--|:--|
| GET | `/api/init/status` | 否 | 查询是否已初始化。返回 `{ initialized: bool, domain, port }` |
| POST | `/api/init` | 否 | 首次设置密码和域名。`{ password, domain, dns_provider, dns_api_key }` |

---

## 2. 设置

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| GET | `/api/settings` | 获取当前所有设置值 |
| GET | `/api/settings/describe` | 获取设置项元数据（类型、默认值、描述） |
| PATCH | `/api/settings` | 修改设置。`{ public_indexing: "false", node_port: "9090" }` |

**可用设置项:** `public_indexing`, `ad_slots_per_page`, `ad_reserve_days`, `ad_max_duration_days`, `node_domain`, `node_port`, `dns_provider`, `dns_api_key`

---

## 3. 内容管理

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| POST | `/api/upload` | 上传内容（multipart）：body, description, comment_permission, required_points, required_vip |
| POST | `/api/content` | 发布纯文本内容（JSON）：`{ body, description, comment_permission, required_points, required_vip }` |
| GET | `/api/content` | 列出本节点内容 `?limit=&offset=&type=` |
| GET | `/api/content/:id` | 查看单条内容详情 |
| PUT | `/api/content/:id/comments/toggle` | 切换评论开关（all/followers/none） |
| DELETE | `/api/content/:id` | 删除内容 |

### 评论

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| GET | `/api/comments` | 查看本节点所有评论 |
| GET | `/api/content/:id/comments` | 查看某条内容的评论 |
| POST | `/api/content/:id/comments` | 发表评论 `{ body }` |
| DELETE | `/api/comments/:id` | 删除评论（owner 权限） |

---

## 4. 个人资料

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| GET | `/kirin/profile` | 获取节点资料 |
| PUT | `/kirin/profile` | 更新昵称/头像 `{ nickname, avatar }` |

---

## 5. IM 分组

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| GET | `/im/groups` | 列出所有分组 |
| POST | `/im/groups` | 创建分组 `{ name, type: "friends"|"trade"|"custom" }` |
| DELETE | `/im/groups/:id` | 删除分组 |

---

## 6. 临时交易密钥

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| POST | `/im/temp-key` | 生成临时密钥 `{ target_domain, key, expires_days: 90 }` |
| POST | `/im/temp-key/:id/accept` | 接受密钥（自动创建交易分组） |
| DELETE | `/im/temp-key/:id/revoke` | 撤销密钥 |

---

## 7. 地址管理

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| GET | `/marketplace/addresses` | 列出所有地址 |
| POST | `/marketplace/addresses` | 添加地址 `{ label, address, type, is_default }` |
| PUT | `/marketplace/addresses/:id` | 更新地址 |
| DELETE | `/marketplace/addresses/:id` | 删除地址 |

---

## 8. 粉丝系统

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| GET | `/followers/list` | 列出所有粉丝 |
| POST | `/followers/subscribe` | 关注 `{ domain, public_key }` |
| POST | `/followers/unsubscribe` | 取关 `{ domain }` |

---

## 9. 积分与 VIP

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| POST | `/points/grant` | 发放积分 `{ domain, amount, reason }` |
| POST | `/points/spend` | 消费积分 `{ domain, content_id, amount }` |
| GET | `/points/balance/:domain` | 查询某域名积分余额 |
| GET | `/points/transactions/:domain` | 查询某域名积分明细 |
| POST | `/vip/buy` | 购买 VIP `{ domain, level, duration_days }` |
| GET | `/vip/status/:domain` | 查询 VIP 状态 |
| GET | `/access/:contentId?domain=...` | 检查是否有权访问内容 |

---

## 10. 广告位竞价

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| POST | `/ad-slots/generate` | 生成广告位 `{ date, days, per_page }` |
| GET | `/ad-slots` | 列出所有广告位 |
| POST | `/ad-slots/:id/bid` | 出价 `{ domain, amount }` |
| GET | `/ad-slots/:id/bids` | 查看出价记录 |
| POST | `/ad-slots/:id/finalize` | 结算（收入归节点主人） |

---

## 11. 公共索引

> 受 `public_indexing` 设置控制。关闭时以下端点返回 403。

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| POST | `/indexer/publish` | 接收推送 `{ domain, content_id, url, title, description, type }` |
| POST | `/indexer/ingest` | 批量摄入 |
| GET | `/indexer/search` | 全文搜索 `?q=&limit=&offset=` |
| GET | `/indexer/swipe` | 滑动浏览 `?offset=&limit=` |
| GET | `/indexer/ads` | 展示当前已售广告 `?page=` |

### 管理审核

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| POST | `/indexer/hide/:id` | 隐藏内容 |
| POST | `/indexer/show/:id` | 恢复显示 |
| GET | `/indexer/admin/flagged` | 查看被标记内容 |
| POST | `/indexer/blacklist` | 拉黑域名 `{ domain, reason }`（自动隐藏该域名所有内容） |
| DELETE | `/indexer/blacklist/:domain` | 解封 |

---

## 12. 推送

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| POST | `/push/content` | 推送内容到目标节点（先 DOH 验证） |
| POST | `/push/product` | 推送商品 |
| POST | `/push/all` | 推送全部内容 |
| POST | `/push/ping` | 连通性测试 |

---

## 13. DNS 管理

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| POST | `/dns/update` | 自动检测公网 IP 并更新 DNS 记录 |
| GET | `/dns/status` | 查询 DNS 配置状态 |
| POST | `/dns/test` | 测试 DNS 提供商连通性 |

支持的 DNS 服务商：`cloudflare`, `aliyun`, `tencent`, `huaweicloud`, `aws-route53`, `google-domains`, `namecheap`, `godaddy`, `porkbun`, `namesilo`, `cloudns`, `he.net`

---

## 14. 系统

| 方法 | 路径 | 说明 |
|:--|:--|:--|
| POST | `/ca-cert` | 上传 CA 证书 `{ pem: "..." }`（需重启生效） |
| POST | `/restart` | 重启节点（依赖 Docker `--restart unless-stopped`） |
| GET | `/health` | 健康检查 `{ status, initialized, indexing_enabled, modules }` |
