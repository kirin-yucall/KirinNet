/**
 * KirinDNS Resolution Protocol (ADRP) v2.0 — TypeScript Type Definitions
 *
 * 对齐 `kirin_dns.js` 真实导出（module.exports）。ADRP v2.0 = SRV 服务发现
 * + TXT 身份元数据（见 ../01_Standard/spec_v1.md）。
 *
 * @module kirin-dns
 */

// ---------------------------------------------------------------------------
// 常量（spec §2.2 / §2.5）
// ---------------------------------------------------------------------------

/** ADRP v2 支持的服务标识（用于 resolveService 的 service 参数）。 */
export type KirinService = 'http' | 'https' | 'ws';

/** SRV 服务名前缀 → 完整 SRV 查询名（`_kirinnet-<service>._tcp`）。 */
export const SRV_SERVICES: Readonly<Record<KirinService, string>>;

/** 回退端口（spec §2.5：SRV 缺失时使用 IANA 默认值）。 */
export interface FallbackPorts {
  http: 80;
  https: 443;
  ws: 80;
  wss: 443;
}
export const FALLBACK_PORTS: Readonly<FallbackPorts>;

// ---------------------------------------------------------------------------
// 结果类型（v2）
// ---------------------------------------------------------------------------

/** 单个服务的 SRV 解析结果。 */
export interface SrvResult {
  /** SRV target 主机名（已去掉尾点）。 */
  target: string;
  /** SRV 端口（1–65535）。 */
  port: number;
}

/**
 * 身份元数据（解析自 TXT 记录）。
 * `id` 与 `key` 必填；`nick` / `ipfs` 可选（仅当 TXT 中出现时存在）。
 */
export interface KirinIdentity {
  /** 必填：UUID v4 或 DID 格式唯一标识。 */
  id: string;
  /** 必填：十六进制编码长期公钥。 */
  key: string;
  /** 可选：人类可读昵称。 */
  nick?: string;
  /** 可选：是否启用 IPFS 网关（由 TXT 中 `ipfs=true|false` 解析）。 */
  ipfs?: boolean;
  /** 未知键按 spec §3.2 静默忽略，不出现在此对象中。 */
  [unknownKey: string]: unknown;
}

/**
 * v2 legacy 包装（resolve_kirin_dns）的返回结构。
 * `ws` 在 SRV 缺失时回退到 `{target: domain, port: 80}`；
 * `http` / `https` 缺失时为 null（调用方按需回退到 80 / 443）。
 */
export interface KirinDnsFullResult {
  /** 被解析的域名。 */
  domain: string;
  /** WebSocket 服务（始终有值，缺失则回退）。 */
  ws: SrvResult;
  /** HTTP 服务（无 SRV 记录时为 null）。 */
  http: SrvResult | null;
  /** HTTPS 服务（无 SRV 记录时为 null）。 */
  https: SrvResult | null;
  /** 身份元数据（无身份 TXT 时为 null）。 */
  identity: KirinIdentity | null;
}

// ---------------------------------------------------------------------------
// v2 主 API
// ---------------------------------------------------------------------------

/**
 * 解析单个服务的端口（SRV，RFC 2782）。
 *
 * 查询 `<SRV_SERVICES[service]>.<domain>` 的 SRV 记录，按 priority↑、
 * weight↓ 选最优，返回 `{target, port}`。
 *
 * fail-closed：NXDOMAIN / 空答案 / 查询异常 → 返回 **null**（调用方应
 * 回退到 `FALLBACK_PORTS[service]`）。未知 service → **抛错**（不静默）。
 *
 * @param domain  目标域名，如 `'alice.kirinnet.org'`。
 * @param service `'http' | 'https' | 'ws'`。
 */
export function resolveService(
  domain: string,
  service: KirinService,
): Promise<SrvResult | null>;

/**
 * 解析域名下全部 SRV 服务。
 *
 * @returns `{ http, https, ws }`，每个字段为 `SrvResult | null`（无记录即 null）。
 */
export function resolveAllServices(
  domain: string,
): Promise<Record<KirinService, SrvResult | null>>;

/**
 * 从 TXT 记录解析身份元数据（spec §3.2 / §3.3.2）。
 *
 * 扫描所有 TXT 记录，返回第一条以 `id=` 起首且含 `key=` 的记录。
 * 无匹配 / 查询失败 → 返回 **null**。
 */
export function resolveIdentity(domain: string): Promise<KirinIdentity | null>;

/**
 * 将单条 TXT 原始字符串解析为身份对象（spec §3.2）。
 *
 * 分号分隔的 `key=value`，以 `id=` 起首且同时含 `key=` 才视为身份记录。
 * 非身份记录 / 缺 `id` 或 `key` → 返回 **null**。
 */
export function parseIdentityTxt(txt: string): KirinIdentity | null;

// ---------------------------------------------------------------------------
// v1 legacy 包装
// ---------------------------------------------------------------------------

/**
 * 全量解析（legacy 包装）：SRV（ws/http/https）+ TXT 身份，一次性返回。
 *
 * 新代码请直接使用 `resolveService` / `resolveIdentity`。
 */
export function resolve_kirin_dns(domain: string): Promise<KirinDnsFullResult>;
