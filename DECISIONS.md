# KirinNet 关键决策记录

> 整理自 2026-07-09 ~ 2026-07-10 对话。记录架构决策、命名变更、设计取舍。

---

## 1. 命名与品牌

| 决策 | 内容 |
|---|---|
| 项目名 | KirinNet（麒麟网），取自用户名字音译 |
| 协议名 | KirinDNS (ADRP) |
| 包名 | `kirin-dns`（PyPI / npm） |
| 组织 | `kirin-yucall`（GitHub） |
| 旧名 | AuraDNS / AuraNet（已全量替换） |

---

## 2. 架构：单节点 = 全部功能

**2026-07-10 用户明确指令**：
> "没有两个平台 只有一个用户节点包含所有功能"
> "第八第九部分整合在第七部分的用户节点里"

- 07_User_Node 是唯一的用户节点镜像 `kirinnet-node:latest`
- 08_KirinNet（索引器）和 09_Pub_Aggregator（爬虫）功能已整合进 07
- 不存在独立的"平台"镜像
- 单镜像全能力，功能通过 settings 表开关控制

---

## 3. 存储：DuckDB + 本地 FS

- DuckDB 嵌入式列式 OLAP，替代 SQLite
- 数据库文件 `/app/data/duckdb/kirinnet_user_node.db`
- 媒体文件 `/app/data/media/`
- 无需外部数据库服务
- DuckDB 语法注意：`ON CONFLICT DO UPDATE SET col=excluded.col`，时间戳用 `now()`，序列用 `CREATE SEQUENCE` + `nextval()`

---

## 4. Docker 部署

```bash
docker run -d --name kirin-node --restart unless-stopped \
  -p 8080:8080 -v ./data:/app/data \
  kirinnet-node:latest
```

- 基础镜像 `node:20-slim`
- 不依赖外部服务
- 数据通过 volume 持久化
- `DOCKER_BUILDKIT=0` 构建（镜像仓库兼容）
- Dockerfile 新增文件须加 COPY 行，否则运行时崩溃

---

## 5. 认证与密码找回

### 认证
- 域名即身份，无邮箱/手机注册
- bcryptjs 哈希存储密码
- Bearer Token 认证
- localStorage 持久化 72h，24h 自动续期，48h 无操作需重登

### 密码找回（2026-07-10 新增）
- 用户要求：可通过 docker exec 终端操作找回，不可通过 Web UI
- 实现：`POST /api/request-recovery`（仅 localhost 可访问）+ `POST /api/reset-password`（公网验证恢复码）
- 恢复码 6 位，10 分钟有效，一次性消费
- 外部访问返回 403

---

## 6. 探索系统替代搜索

- 方向驱动主动探知（非被动搜索）
- 9 个预设方向 + 自定义
- 弹性分段 SHA-256 哈希去重
- 内置黑名单关键词过滤

---

## 7. 协议：TXT vs SRV 未完结

**2026-07-10 审计结论**：
- 所有文档（spec、IETF draft、im_protocol）仍描述 TXT 记录
- 所有代码实现未使用 SRV
- 声称的 TXT→SRV 转换实际未执行
- 此问题待用户决策

---

## 8. 15 语言客户端库

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

## 9. IETF 标准化

- 已生成 `draft-kirin-yucall-kirindns-adrp-00.txt`
- 因 TXT/SRV 未定，尚未提交
- 占位日期需替换真实值后提交

---

## 10. 安全模型

- 两阶段好友请求（请求不含密钥，接受后交换公钥）
- 政府 CA 仅证明"物理身份=域名"，不做信任推荐
- 攻击单节点 = 物理攻击一个人的代价
- 粉丝公钥加密推送，端到端不可窃听
- 分布式入侵检测（心跳信号+流量骤降）

---

## 11. 去中心化原则

- 不需要限流（每个用户自跑节点）
- 域名 = 身份，DNS = 信任锚点
- 客户端 DOH 验证
- 所有用户可控设置进 settings 表，Web UI + API 控制

---

## 12. 文档规范

- 文档通过 patch 逐节迭代（不整篇重写）
- 中文文档，中文注释
- API 路径/变量名/注释必须用 `kirin`（零 `aura` 引用）
- 数据库文件 `kirinnet_user_node.db`
