# KirinNet 细节填充任务规划

> 主体框架已就绪：Docker 单镜像，30 表 DuckDB，22 路由模块，6 前端页面。
> 以下为细节填充清单，按优先级排列。

---

## P0 — 稳定性（当前未处理异常会导致服务器崩溃）

### D01 — 17 个路由添加 try/catch 错误处理

**问题**：无 try/catch 的路由，DuckDB 异常或意外输入会直接 crash 整个 Express 进程。

**涉及文件**：
addresses.js, cart.js, contacts.js, coupons.js, dns.js, drafts.js, explore.js,
favorites.js, followers.js, history.js, im.js, im_messages.js, indexer.js,
monetize.js, notifications.js, payment_methods.js, settings.js

**方案**：每个路由处理函数包裹 `try { ... } catch(err) { res.status(500).json({error:err.message}) }`

---

### D02 — 19 个路由添加输入参数校验

**问题**：空 body、错误类型、缺失字段直接穿透到 DuckDB，产生难以调试的错误。

**涉及文件**：同上（除 kirin.js / addresses.js 已有部分校验）

**方案**：
- POST/PUT 端点检查必填字段存在性
- 数值类型检查 `typeof x === 'number'` 或 `parseInt`
- 字符串长度限制（防 DoS）
- 返回 400 + 明确错误信息

---

## P1 — 前端页面完善

### D03 — pages_display.js 完善（当前 104 行）

**缺口**：分类浏览页面极简，4 个 tab（文章/商品/帖子/视频）切换逻辑存在但内容渲染稀疏。

**需补充**：
- 各 tab 下实际数据加载和渲染
- 加载状态/空状态
- 分页或无限滚动
- 缩略图/CID 展示格式

---

### D04 — pages_center.js 完善（当前 185 行）

**缺口**：关于页/统计页/日志页内容较少。

**需补充**：
- 统计数据真实查询 API 并渲染图表式摘要
- 关于页展示版本号、运行时间、数据库大小
- 日志页对接 Docker logs 或应用日志

---

### D05 — 前端错误提示统一

**问题**：各页面 showToast/消息提示格式不一致，部分 API 调用无错误处理。

**方案**：
- 统一 toast 组件样式和位置
- 每个 fetch 调用添加 `.catch()` 
- 网络错误 vs 业务错误区分展示

---

## P2 — 协议层

### D06 — SRV/TXT 文档和代码对齐

**用户决策**：SRV 存端口信息，TXT 存基础身份信息。

**需更新**：
- `01_Standard/spec_v1.md` — 明确 SRV(端口) + TXT(身份) 双记录模型
- `02_Libraries/` 各语言实现 — 同时查询 SRV + TXT
- IETF draft — 更新协议描述
- `07_User_Node/routes/dns.js` — SRV 记录管理端点

---

### D07 — 02_Libraries 补齐实测

**当前**：15 语言中仅 Python/JS/C/C++ 实测通过。

**需补充**：
- Go/Rust 单元测试
- 其余 9 语言至少 smoke test
- 跨语言一致性验证脚本

---

## P3 — 操作体验

### D08 — 初始化向导增强

**问题**：init.html 仅设密码和域名，缺少帮助和验证。

**需补充**：
- 域名格式实时校验
- DNS 服务商选择下拉（12 家）而非自由文本
- 初始化后自动跳转 + 登录状态设置

---

### D09 — 移动端适配

**问题**：所有页面无响应式设计，手机上不可用。

**方案**：
- CSS media queries（主要断点：768px）
- 导航折叠为汉堡菜单
- 表格横向滚动

---

### D10 — 探索爬虫实际接入

**问题**：explore.js 方向管理和爬取触发端点存在，但实际爬取逻辑依赖外部网络，当前未接入真实数据源。

**方案**：
- 实现 `crawlDirection(direction)` 实际 HTTP 请求 + 解析
- 连接 `09_Pub_Aggregator/crawler.js` 或独立实现
- 爬取频率限制（rate limit per direction）

---

## P4 — 文档

### D11 — spec.md 版本更新至 v2.8

**需更新**：
- 密码找回流程
- SRV+TXT 双记录模型
- 探索系统说明
- 弹性分段哈希说明

---

### D12 — api.md 补充遗漏端点

**需补充**：
- `POST /api/request-recovery`（密码找回触发）
- `POST /api/reset-password`（密码重置）
- 探索相关端点
- 购物车/订单/优惠券等交易端点
- 联系人/通知端点

---

## 任务执行建议

| 批次 | 任务 | 预计工作量 | 依赖 |
|---|---|---|---|
| 第一批 | D01 + D02 | 较重（17+19 文件） | 无 |
| 第二批 | D03 + D04 + D05 | 中等（3 文件 + 全局） | 无 |
| 第三批 | D06 | 中等（跨模块） | 无 |
| 第四批 | D08 + D09 + D10 + D11 + D12 | 较重 | 前批次 |
| 可选 | D07 | 独立 | 无 |

**每个任务完成后重建 Docker 镜像 + 冒烟测试。**
