/**
 * KirinDNS Resolution Protocol (ADRP) — TypeScript Type Definitions
 *
 * @module kirin-dns
 */

/** Recognized protocol keys in an ADRP TXT record. */
export type AdrpKey = 'http' | 'https' | 'ws' | 'wss';

/**
 * Resolved service ports for a KirinDNS-enabled domain.
 * All four keys are always present — either from a valid ADRP record
 * or the standard IANA fallback values.
 */
export interface ResolvedPorts {
  /** HTTP port (default 80). */
  http: number;
  /** HTTPS port (default 443). */
  https: number;
  /** WebSocket port (default 80). */
  ws: number;
  /** Secure WebSocket port (default 443). */
  wss: number;
}

/**
 * Standard IANA fallback ports.
 * Used when no valid ADRP TXT record is found for the domain.
 */
export const FALLBACK_PORTS: Readonly<ResolvedPorts>;

/**
 * Recognized ADRP keys.
 */
export const RECOGNIZED_KEYS: ReadonlySet<AdrpKey>;

/**
 * Validate a parsed JSON object as a valid ADRP record.
 *
 * Rules (spec §3.1):
 *  - All values for recognized keys MUST be integers in range [1, 65535].
 *  - At least one recognized key MUST be present.
 *  - Unknown keys are silently ignored.
 *
 * @param data - Parsed JSON object to validate.
 * @returns `true` if the record is a valid ADRP record.
 */
export function validateKirinDnsRecord(data: unknown): data is Partial<Record<AdrpKey, number>>;

/**
 * Parse a single TXT record string as JSON and validate it as an ADRP record.
 *
 * @param text - Raw TXT record string.
 * @returns Parsed record (only recognized keys), or `null` if invalid.
 */
export function parseTxtValue(text: string): Partial<Record<AdrpKey, number>> | null;

/**
 * Resolve the KirinDNS ports for a given domain.
 *
 * Queries DNS TXT records and returns the first valid ADRP record found.
 * Falls back to standard IANA ports if no valid record exists.
 *
 * @param domain - Domain name to query (e.g. "alice.kirinnet.org").
 * @returns Promise resolving to the port mapping.
 */
export function resolve_kirin_dns(domain: string): Promise<ResolvedPorts>;
