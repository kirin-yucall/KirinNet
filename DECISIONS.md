# KirinNet 关键决策记录 — 协议

> 整理自 2026-07-09 ~ 2026-07-10 对话。记录协议层架构决策、命名变更、设计取舍。
> **节点相关决策（存储/Docker/认证/探索系统）已随 Node 仓库迁移至 [kirin-yucall/KirinNet-Node](https://github.com/kirin-yucall/KirinNet-Node)。**

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
- `01_Standard/spec_v1.md` 与 `did-dns-protocol.md` 的密钥体系/TXT 格式冲突（见 `需求设计文档.md` 第 9 章）
