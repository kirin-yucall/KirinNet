//! KirinNet DNS Resolution — Rust Client Library (v2)
//!
//! Service discovery via SRV records + identity via TXT records.
//! Maintains backward compatibility with the v1 ADRP JSON TXT protocol.
//!
//! # v2 API — SRV service discovery + TXT identity
//!
//! ```rust,no_run
//! use kirin_dns::ResolvedPorts;
//!
//! # async fn example() {
//! // Resolve a specific service via SRV
//! if let Some(srv) = ResolvedPorts::resolve_service("example.com", "http").await {
//!     println!("HTTP service at {}:{}", srv.target, srv.port);
//! }
//!
//! // Resolve identity via TXT
//! if let Some(id) = ResolvedPorts::resolve_identity("example.com").await {
//!     println!("Node: {}", id.nick.as_deref().unwrap_or("unknown"));
//! }
//!
//! // Resolve all services at once
//! let all = ResolvedPorts::resolve_all_services("example.com").await;
//! for srv in &all {
//!     println!("{} -> {}:{} (prio={}, weight={})",
//!         srv.service, srv.target, srv.port, srv.priority, srv.weight);
//! }
//! # }
//! ```
//!
//! # v1 API — legacy ADRP JSON TXT
//!
//! ```rust,no_run
//! use kirin_dns::ResolvedPorts;
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let ports = ResolvedPorts::resolve("example.com").await?;
//! println!("HTTP:  {}", ports.http());
//! println!("HTTPS: {}", ports.https());
//! println!("WS:    {}", ports.ws());
//! println!("WSS:   {}", ports.wss());
//! # Ok(())
//! # }
//! ```

use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use trust_dns_resolver::config::{ResolverConfig, ResolverOpts};
use trust_dns_resolver::TokioAsyncResolver;

/// Base64URL encoder without padding (RFC 4648 §5 / did-dns-protocol §2).
const B64URL_NO_PAD: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// SRV service prefixes for v2 service discovery.
const SRV_SERVICES: &[(&str, &str)] = &[
    ("http", "_kirinnet-http._tcp"),
    ("https", "_kirinnet-https._tcp"),
    ("ws", "_kirinnet-ws._tcp"),
];

/// v1 fallback ports (IANA defaults).
const FALLBACK_HTTP: u16 = 80;
const FALLBACK_HTTPS: u16 = 443;
const FALLBACK_WS: u16 = 80;
const FALLBACK_WSS: u16 = 443;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Error, Debug)]
pub enum KirinDnsError {
    #[error("DNS resolution failed: {0}")]
    DnsError(#[from] trust_dns_resolver::error::ResolveError),

    #[error("Invalid ADRP record: {0}")]
    InvalidRecord(String),
}

// ---------------------------------------------------------------------------
// SRVResult (v2)
// ---------------------------------------------------------------------------

/// Result of an SRV service lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SRVResult {
    /// Logical service name: "http", "https", or "ws".
    pub service: String,
    /// Target hostname from the SRV record (trailing dot stripped).
    pub target: String,
    /// Port number.
    pub port: u16,
    /// SRV priority (lower is more preferred).
    pub priority: u16,
    /// SRV weight (for load balancing within the same priority tier).
    pub weight: u16,
}

// ---------------------------------------------------------------------------
// Identity (v2)
// ---------------------------------------------------------------------------

/// Identity information resolved from a TXT record.
///
/// Parsed from TXT values in semicolon-delimited `key=value` format:
/// `id=<value>;key=<value>;nick=<value>;ipfs=<value>`
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    /// Node / peer identifier.
    pub id: Option<String>,
    /// Public key (hex or base64-encoded).
    pub key: Option<String>,
    /// Human-readable nickname.
    pub nick: Option<String>,
    /// IPFS content identifier.
    pub ipfs: Option<String>,
}

impl Identity {
    /// Parse a TXT record value in `key=value;...` semicolon-delimited format.
    ///
    /// Returns `None` if no recognized keys are present.
    pub fn parse(txt: &str) -> Option<Self> {
        let mut id = None;
        let mut key = None;
        let mut nick = None;
        let mut ipfs = None;

        for part in txt.split(';') {
            let part = part.trim();
            if let Some((k, v)) = part.split_once('=') {
                let k = k.trim();
                let v = v.trim().to_string();
                if v.is_empty() {
                    continue;
                }
                match k {
                    "id" => id = Some(v),
                    "key" => key = Some(v),
                    "nick" => nick = Some(v),
                    "ipfs" => ipfs = Some(v),
                    _ => {} // ignore unknown keys
                }
            }
        }

        if id.is_none() && key.is_none() && nick.is_none() && ipfs.is_none() {
            return None;
        }

        Some(Self { id, key, nick, ipfs })
    }
}

// ---------------------------------------------------------------------------
// did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)
// ---------------------------------------------------------------------------

/// did:dns protocol constants (spec §3.2.1 / did-dns-protocol §2).
const DID_DNS_PREFIX: &str = "did:dns:";
const DID_DNS_DECL_PREFIX: &str = "did:dns:v=";
const DID_DNS_PK_PREFIX: &str = "did:dns:pk;";
const DID_DNS_BLACK_PREFIX: &str = "did:dns:black;";
const DID_DNS_KTY_ED25519: &str = "ed25519";
const DID_DNS_FRESHNESS_WINDOW: i64 = 5 * 60;          // ±5 minutes (spec §3.2.1)
const DID_DNS_FINGERPRINT_BYTES: usize = 12;           // SHA-256[0:12]

/// A parsed did:dns identity (declaration + public key, optional blacklist).
///
/// The tamper-evident fingerprint chain (`fp == Base64URL(SHA-256(pk)[0:12])`)
/// is checked by [`DidDnsIdentity::fingerprint_chain_ok`]; the caller applies
/// trust policy via [`DidDnsIdentity::is_valid`] (fail-closed default).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DidDnsIdentity {
    /// Protocol version (fixed 1).
    pub version: u32,
    /// Declared fingerprint (must equal recomputed fingerprint over pk).
    pub fingerprint: String,
    /// Nickname, Base64URL(UTF-8) encoded (may be empty).
    pub nickname: String,
    /// Gender (M/F/O/X, may be empty).
    pub gender: String,
    /// Issued-at Unix seconds (0 if absent).
    pub issued_at: i64,
    /// Expires-at Unix seconds (0 if absent).
    pub expires_at: i64,
    /// Key type (must be ed25519).
    pub key_type: String,
    /// Public key, Base64URL encoded.
    pub public_key_b64url: String,
    /// Blacklisted fingerprints.
    pub blacklist: Vec<String>,
    /// Raw declaration record (diagnostics).
    pub raw_declaration: String,
    /// Raw public-key record (diagnostics).
    pub raw_public_key: String,
}

impl DidDnsIdentity {
    /// Decode the Base64URL public key into bytes.
    pub fn public_key_bytes(&self) -> Result<Vec<u8>, base64::DecodeError> {
        B64URL_NO_PAD.decode(&self.public_key_b64url)
    }

    /// Recompute fp = Base64URL(SHA-256(pk)[0:12]).
    pub fn compute_fingerprint(&self) -> Result<String, base64::DecodeError> {
        let pk = self.public_key_bytes()?;
        let mut hasher = Sha256::new();
        hasher.update(&pk);
        let digest = hasher.finalize();
        Ok(B64URL_NO_PAD.encode(&digest[..DID_DNS_FINGERPRINT_BYTES]))
    }

    /// True iff declared fp matches recomputed fp over the pk bytes.
    pub fn fingerprint_chain_ok(&self) -> bool {
        if self.fingerprint.is_empty() {
            return false;
        }
        match self.compute_fingerprint() {
            Ok(got) => got == self.fingerprint,
            Err(_) => false,
        }
    }

    /// True iff the declaration fingerprint appears in the blacklist.
    pub fn is_revoked(&self) -> bool {
        self.blacklist.iter().any(|f| f == &self.fingerprint)
    }

    /// True iff exp <= now (0 ExpiresAt means no expiry check).
    pub fn is_expired(&self, now: i64) -> bool {
        self.expires_at != 0 && now >= self.expires_at
    }

    /// True iff iat is outside ±5min of now.
    pub fn is_stale(&self, now: i64) -> bool {
        if self.issued_at == 0 {
            return false;
        }
        (now - self.issued_at).abs() > DID_DNS_FRESHNESS_WINDOW
    }

    /// Composite policy: version 1 + ed25519 + chain holds + not revoked + not expired.
    pub fn is_valid(&self, now: i64) -> bool {
        self.version == 1
            && self.key_type == DID_DNS_KTY_ED25519
            && self.fingerprint_chain_ok()
            && !self.is_revoked()
            && !self.is_expired(now)
    }

    /// Decode the Base64URL(UTF-8) nickname, or None if absent/invalid.
    pub fn nickname_decoded(&self) -> Option<String> {
        if self.nickname.is_empty() {
            return None;
        }
        let bytes = B64URL_NO_PAD.decode(&self.nickname).ok()?;
        String::from_utf8(bytes).ok()
    }
}

/// Classify TXT records by did:dns: sub-type and assemble an identity.
///
/// Returns `None` if no did:dns records are found, or declaration+pk missing.
/// Pure function (no network) — usable for tests.
pub fn parse_did_dns_identity(txt_records: &[String]) -> Option<DidDnsIdentity> {
    let mut decl_raw: Option<&str> = None;
    let mut pk_raw: Option<&str> = None;
    let mut black_raw: Option<&str> = None;

    for raw in txt_records {
        let s = raw.trim();
        if s.starts_with(DID_DNS_DECL_PREFIX) && decl_raw.is_none() {
            decl_raw = Some(s);
        } else if s.starts_with(DID_DNS_PK_PREFIX) && pk_raw.is_none() {
            pk_raw = Some(s);
        } else if s.starts_with(DID_DNS_BLACK_PREFIX) && black_raw.is_none() {
            black_raw = Some(s);
        }
    }

    let decl_raw = decl_raw?;
    let pk_raw = pk_raw?;

    let decl = parse_did_dns_kv(&decl_raw[DID_DNS_PREFIX.len()..]);
    let pk = parse_did_dns_kv(&pk_raw[DID_DNS_PREFIX.len()..]);

    let mut identity = DidDnsIdentity {
        version: decl.get("v").and_then(|v| v.parse().ok()).unwrap_or(1),
        fingerprint: decl.get("fp").cloned().unwrap_or_default(),
        nickname: decl.get("n").cloned().unwrap_or_default(),
        gender: decl.get("g").cloned().unwrap_or_default(),
        issued_at: decl.get("iat").and_then(|v| v.parse().ok()).unwrap_or(0),
        expires_at: decl.get("exp").and_then(|v| v.parse().ok()).unwrap_or(0),
        key_type: pk.get("kty").cloned().unwrap_or_else(|| DID_DNS_KTY_ED25519.to_string()),
        public_key_b64url: pk.get("pk").cloned().unwrap_or_default(),
        raw_declaration: decl_raw.to_string(),
        raw_public_key: pk_raw.to_string(),
        blacklist: Vec::new(),
    };

    if let Some(black) = black_raw {
        let kv = parse_did_dns_kv(&black[DID_DNS_PREFIX.len()..]);
        if let Some(fp_field) = kv.get("fp") {
            identity.blacklist = fp_field
                .split(',')
                .filter(|f| !f.is_empty())
                .map(String::from)
                .collect();
        }
    }

    Some(identity)
}

/// Resolve and assemble a did:dns identity for `domain`.
/// Returns `None` on NXDOMAIN / no TXT / no did:dns records (fail-closed).
pub async fn resolve_identity_did_dns(domain: &str) -> Option<DidDnsIdentity> {
    let resolver = default_resolver().await;
    resolve_identity_did_dns_with(domain, &resolver).await
}

async fn default_resolver() -> TokioAsyncResolver {
    TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default())
}

async fn resolve_identity_did_dns_with(
    domain: &str,
    resolver: &TokioAsyncResolver,
) -> Option<DidDnsIdentity> {
    let lookup = resolver.txt_lookup(domain).await.ok()?;
    let records: Vec<String> = lookup
        .iter()
        .map(|r| {
            r.iter()
                .flat_map(|b| std::str::from_utf8(b).ok())
                .collect::<String>()
        })
        .collect();
    parse_did_dns_identity(&records)
}

fn parse_did_dns_kv(text: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for pair in text.split(';') {
        if let Some((k, v)) = pair.split_once('=') {
            out.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// ResolvedPorts
// ---------------------------------------------------------------------------

/// Holds resolved service port mappings (v1 ADRP protocol).
///
/// Also provides the v2 SRV + TXT Identity API as associated async functions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPorts {
    http: u16,
    https: u16,
    ws: u16,
    wss: u16,
}

impl ResolvedPorts {
    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    fn fallback() -> Self {
        Self {
            http: FALLBACK_HTTP,
            https: FALLBACK_HTTPS,
            ws: FALLBACK_WS,
            wss: FALLBACK_WSS,
        }
    }

    fn default_resolver() -> TokioAsyncResolver {
        TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default())
    }

    // ------------------------------------------------------------------
    // v2: SRV service discovery
    // ------------------------------------------------------------------

    /// Resolve a single KirinNet service via SRV DNS.
    ///
    /// `service` is one of `"http"`, `"https"`, `"ws"`.
    /// Returns the highest-priority SRV result, or `None` if not found.
    pub async fn resolve_service(domain: &str, service: &str) -> Option<SRVResult> {
        let resolver = Self::default_resolver();
        Self::resolve_service_with(domain, service, &resolver).await
    }

    /// Resolve a single service using a pre-configured resolver.
    pub async fn resolve_service_with(
        domain: &str,
        service: &str,
        resolver: &TokioAsyncResolver,
    ) -> Option<SRVResult> {
        let srv_name = srv_service_name(service)?;
        let fqdn = format!("{}.{}", srv_name, domain);
        let lookup = resolver.srv_lookup(&fqdn).await.ok()?;

        // RFC 2782: sort by priority ascending, then weight descending
        let mut records: Vec<_> = lookup.iter().collect();
        records.sort_by(|a, b| {
            a.priority()
                .cmp(&b.priority())
                .then_with(|| b.weight().cmp(&a.weight()))
        });

        records.first().map(|r| SRVResult {
            service: service.to_string(),
            target: r.target().to_string().trim_end_matches('.').to_string(),
            port: r.port(),
            priority: r.priority(),
            weight: r.weight(),
        })
    }

    /// Resolve all KirinNet services (`_kirinnet-http`, `_kirinnet-https`,
    /// `_kirinnet-ws`) for a domain.
    ///
    /// Returns all SRV records sorted by priority then weight (RFC 2782).
    pub async fn resolve_all_services(domain: &str) -> Vec<SRVResult> {
        let resolver = Self::default_resolver();
        Self::resolve_all_services_with(domain, &resolver).await
    }

    /// Resolve all services using a pre-configured resolver.
    pub async fn resolve_all_services_with(
        domain: &str,
        resolver: &TokioAsyncResolver,
    ) -> Vec<SRVResult> {
        let mut results = Vec::new();

        for &(service, _srv_base) in SRV_SERVICES {
            let srv_name = match srv_service_name(service) {
                Some(n) => n,
                None => continue,
            };
            let fqdn = format!("{}.{}", srv_name, domain);
            if let Ok(lookup) = resolver.srv_lookup(&fqdn).await {
                for record in lookup.iter() {
                    results.push(SRVResult {
                        service: service.to_string(),
                        target: record
                            .target()
                            .to_string()
                            .trim_end_matches('.')
                            .to_string(),
                        port: record.port(),
                        priority: record.priority(),
                        weight: record.weight(),
                    });
                }
            }
        }

        results.sort_by(|a, b| {
            a.priority
                .cmp(&b.priority)
                .then_with(|| b.weight.cmp(&a.weight))
        });

        results
    }

    // ------------------------------------------------------------------
    // v2: Identity via TXT
    // ------------------------------------------------------------------

    /// Resolve KirinNet identity from TXT records for `domain`.
    ///
    /// Queries TXT records and returns the first record matching the
    /// `id=;key=;nick=;ipfs=` semicolon-delimited format.
    pub async fn resolve_identity(domain: &str) -> Option<Identity> {
        let resolver = Self::default_resolver();
        Self::resolve_identity_with(domain, &resolver).await
    }

    /// Resolve identity using a pre-configured resolver.
    pub async fn resolve_identity_with(
        domain: &str,
        resolver: &TokioAsyncResolver,
    ) -> Option<Identity> {
        let lookup = resolver.txt_lookup(domain).await.ok()?;

        for record in lookup.iter() {
            let txt: String = record
                .iter()
                .flat_map(|b| std::str::from_utf8(b).ok())
                .collect();

            if let Some(identity) = Identity::parse(&txt) {
                return Some(identity);
            }
        }

        None
    }

    // ------------------------------------------------------------------
    // v1: Legacy ADRP JSON TXT resolution
    // ------------------------------------------------------------------

    /// Resolve KirinDNS ports using the v1 ADRP JSON TXT protocol.
    ///
    /// Returns `Ok(ResolvedPorts)` with either the ADRP-record values or
    /// the standard fallbacks if no valid record was found.
    pub async fn resolve(domain: &str) -> Result<Self, KirinDnsError> {
        let resolver = Self::default_resolver();
        Self::resolve_with(domain, &resolver).await
    }

    /// Resolve using a pre-configured resolver (useful for testing).
    pub async fn resolve_with(
        domain: &str,
        resolver: &TokioAsyncResolver,
    ) -> Result<Self, KirinDnsError> {
        let mut ports = Self::fallback();

        let lookup = match resolver.txt_lookup(domain).await {
            Ok(l) => l,
            Err(_) => return Ok(ports),
        };

        for record in lookup.iter() {
            let txt: String = record
                .iter()
                .flat_map(|b| std::str::from_utf8(b).ok())
                .collect();

            if let Some(parsed) = parse_adrp_json(&txt) {
                if let Some(v) = parsed.http {
                    ports.http = v;
                }
                if let Some(v) = parsed.https {
                    ports.https = v;
                }
                if let Some(v) = parsed.ws {
                    ports.ws = v;
                }
                if let Some(v) = parsed.wss {
                    ports.wss = v;
                }
                return Ok(ports);
            }
        }

        Ok(ports)
    }

    // ------------------------------------------------------------------
    // Accessors
    // ------------------------------------------------------------------

    /// HTTP port.
    pub fn http(&self) -> u16 {
        self.http
    }

    /// HTTPS port.
    pub fn https(&self) -> u16 {
        self.https
    }

    /// WebSocket port.
    pub fn ws(&self) -> u16 {
        self.ws
    }

    /// Secure WebSocket port.
    pub fn wss(&self) -> u16 {
        self.wss
    }

    /// Return all ports as a tuple `(http, https, ws, wss)`.
    pub fn all(&self) -> (u16, u16, u16, u16) {
        (self.http, self.https, self.ws, self.wss)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Map a short service name to its SRV record prefix.
fn srv_service_name(service: &str) -> Option<&'static str> {
    match service {
        "http" => Some("_kirinnet-http._tcp"),
        "https" => Some("_kirinnet-https._tcp"),
        "ws" => Some("_kirinnet-ws._tcp"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// v1 ADRP JSON parsing (legacy)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct AdrpRecord {
    http: Option<u16>,
    https: Option<u16>,
    ws: Option<u16>,
    wss: Option<u16>,
}

fn parse_adrp_json(txt: &str) -> Option<AdrpRecord> {
    let record: AdrpRecord = serde_json::from_str(txt).ok()?;

    if record.http.is_none()
        && record.https.is_none()
        && record.ws.is_none()
        && record.wss.is_none()
    {
        return None;
    }

    for val in [record.http, record.https, record.ws, record.wss]
        .iter()
        .flatten()
    {
        if *val == 0 {
            return None;
        }
    }

    Some(record)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // v1 legacy tests
    // ------------------------------------------------------------------

    #[test]
    fn fallback_ports() {
        let ports = ResolvedPorts::fallback();
        assert_eq!(ports.http(), 80);
        assert_eq!(ports.https(), 443);
        assert_eq!(ports.ws(), 80);
        assert_eq!(ports.wss(), 443);
    }

    #[test]
    fn parse_adrp_valid_full() {
        let record =
            parse_adrp_json(r#"{"http":8080,"https":8443,"ws":8080,"wss":8443}"#);
        assert!(record.is_some());
        let r = record.unwrap();
        assert_eq!(r.http, Some(8080));
        assert_eq!(r.wss, Some(8443));
    }

    #[test]
    fn parse_adrp_valid_partial() {
        let record = parse_adrp_json(r#"{"https":8443}"#);
        assert!(record.is_some());
    }

    #[test]
    fn parse_adrp_invalid_empty() {
        assert!(parse_adrp_json(r#"{}"#).is_none());
    }

    #[test]
    fn parse_adrp_invalid_port_zero() {
        assert!(parse_adrp_json(r#"{"http":0}"#).is_none());
    }

    #[test]
    fn parse_adrp_invalid_wrong_type() {
        assert!(parse_adrp_json(r#"{"http":"8080"}"#).is_none());
    }

    #[test]
    fn parse_adrp_invalid_json() {
        assert!(parse_adrp_json("not json").is_none());
    }

    #[test]
    fn parse_adrp_ignores_unknown_keys() {
        let record =
            parse_adrp_json(r#"{"http":8080,"custom_field":"ignored"}"#);
        assert!(record.is_some());
        assert_eq!(record.unwrap().http, Some(8080));
    }

    // ------------------------------------------------------------------
    // v2 Identity::parse tests
    // ------------------------------------------------------------------

    #[test]
    fn identity_parse_full() {
        let id =
            Identity::parse("id=abc123;key=0xdead;nick=alice;ipfs=QmTest");
        assert!(id.is_some());
        let id = id.unwrap();
        assert_eq!(id.id.as_deref(), Some("abc123"));
        assert_eq!(id.key.as_deref(), Some("0xdead"));
        assert_eq!(id.nick.as_deref(), Some("alice"));
        assert_eq!(id.ipfs.as_deref(), Some("QmTest"));
    }

    #[test]
    fn identity_parse_partial() {
        let id = Identity::parse("id=abc123;nick=alice");
        assert!(id.is_some());
        let id = id.unwrap();
        assert_eq!(id.id.as_deref(), Some("abc123"));
        assert_eq!(id.nick.as_deref(), Some("alice"));
        assert!(id.key.is_none());
        assert!(id.ipfs.is_none());
    }

    #[test]
    fn identity_parse_empty() {
        assert!(Identity::parse("").is_none());
        assert!(Identity::parse(";;;").is_none());
    }

    #[test]
    fn identity_parse_empty_values_skipped() {
        // "id=" with no value is not treated as a valid field
        let id = Identity::parse("id=;nick=alice");
        assert!(id.is_some());
        let id = id.unwrap();
        assert!(id.id.is_none());
        assert_eq!(id.nick.as_deref(), Some("alice"));
    }

    #[test]
    fn identity_parse_unknown_keys_ignored() {
        let id = Identity::parse("id=abc;foo=bar;nick=alice");
        assert!(id.is_some());
        let id = id.unwrap();
        assert_eq!(id.id.as_deref(), Some("abc"));
        assert_eq!(id.nick.as_deref(), Some("alice"));
    }

    #[test]
    fn identity_parse_whitespace() {
        let id =
            Identity::parse("id = abc123 ; key = 0xdead ; nick = alice");
        assert!(id.is_some());
        let id = id.unwrap();
        assert_eq!(id.id.as_deref(), Some("abc123"));
        assert_eq!(id.key.as_deref(), Some("0xdead"));
        assert_eq!(id.nick.as_deref(), Some("alice"));
    }

    #[test]
    fn identity_parse_single_field() {
        let id = Identity::parse("id=only-me");
        assert!(id.is_some());
        assert_eq!(id.unwrap().id.as_deref(), Some("only-me"));
    }

    // ------------------------------------------------------------------
    // srv_service_name helper
    // ------------------------------------------------------------------

    #[test]
    fn srv_name_mapping() {
        assert_eq!(srv_service_name("http"), Some("_kirinnet-http._tcp"));
        assert_eq!(srv_service_name("https"), Some("_kirinnet-https._tcp"));
        assert_eq!(srv_service_name("ws"), Some("_kirinnet-ws._tcp"));
        assert_eq!(srv_service_name("wss"), None);
        assert_eq!(srv_service_name("unknown"), None);
    }

    // ------------------------------------------------------------------
    // did:dns three-record identity model (C-1 baseline)
    // Mirrors the Python/JS golden vectors.
    // ------------------------------------------------------------------

    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;

    /// Build the canonical 3-record set with a deterministic 32-byte key +
    /// its real fingerprint (matching the golden vector in all languages).
    fn did_dns_golden(overrides: &DidDnsOverrides) -> (Vec<String>, String, String) {
        let pk_bytes: Vec<u8> = (0u8..32).collect();
        let pk_b64 = B64URL.encode(&pk_bytes);
        let mut hasher = Sha256::new();
        hasher.update(&pk_bytes);
        let digest = hasher.finalize();
        let fp = B64URL.encode(&digest[..DID_DNS_FINGERPRINT_BYTES]);
        let now: i64 = 1_700_000_000;

        let use_fp = overrides.use_fp.as_deref().unwrap_or(&fp);
        let mut decl = format!("did:dns:v=1;fp={}", use_fp);
        if let Some(n) = &overrides.n {
            decl.push_str(&format!(";n={}", n));
        }
        if let Some(g) = &overrides.g {
            decl.push_str(&format!(";g={}", g));
        }
        let iat = overrides.iat.unwrap_or(now);
        let exp = overrides.exp.unwrap_or(now + 3600);
        decl.push_str(&format!(";iat={};exp={}", iat, exp));

        let mut recs = vec!["v=spf1 include:_spf.kirinnet.org -all".to_string(), decl];
        let kty = overrides.kty.as_deref().unwrap_or("ed25519");
        let pk_val = overrides.pk.as_deref().unwrap_or(&pk_b64);
        recs.push(format!("did:dns:pk;kty={};pk={}", kty, pk_val));
        if let Some(black) = &overrides.black {
            recs.push(format!("did:dns:black;fp={}", black));
        }
        if let Some(noise) = &overrides.noise {
            recs.push(noise.clone());
        }
        (recs, fp, pk_b64)
    }

    #[derive(Default)]
    struct DidDnsOverrides {
        use_fp: Option<String>,
        n: Option<String>,
        g: Option<String>,
        iat: Option<i64>,
        exp: Option<i64>,
        kty: Option<String>,
        pk: Option<String>,
        black: Option<String>,
        noise: Option<String>,
    }

    #[test]
    fn did_dns_parse_full() {
        let (recs, fp, pk_b64) = did_dns_golden(&DidDnsOverrides {
            n: Some("QWxpY2U".into()),
            g: Some("F".into()),
            ..Default::default()
        });
        let id = parse_did_dns_identity(&recs).expect("identity");
        assert_eq!(id.version, 1);
        assert_eq!(id.fingerprint, fp);
        assert_eq!(id.key_type, "ed25519");
        assert_eq!(id.public_key_b64url, pk_b64);
        assert!(id.fingerprint_chain_ok());
    }

    #[test]
    fn did_dns_records_any_order() {
        let (mut recs, fp, _) = did_dns_golden(&DidDnsOverrides::default());
        recs.reverse();
        let id = parse_did_dns_identity(&recs).expect("identity");
        assert_eq!(id.fingerprint, fp);
    }

    #[test]
    fn did_dns_noise_ignored() {
        let (recs, _, _) = did_dns_golden(&DidDnsOverrides {
            noise: Some("v=DKIM1; k=rsa; p=MIGfMA0".into()),
            ..Default::default()
        });
        let id = parse_did_dns_identity(&recs).expect("identity");
        assert!(id.fingerprint_chain_ok());
    }

    #[test]
    fn did_dns_missing_declaration() {
        assert!(parse_did_dns_identity(&["did:dns:pk;kty=ed25519;pk=abc".into()]).is_none());
    }

    #[test]
    fn did_dns_missing_pk() {
        assert!(parse_did_dns_identity(&["did:dns:v=1;fp=x;iat=1;exp=2".into()]).is_none());
    }

    #[test]
    fn did_dns_no_did_dns() {
        // Legacy id=;key= must NOT be misclassified as did:dns
        assert!(parse_did_dns_identity(&["id=foo;key=bar;nick=Alice".into()]).is_none());
        assert!(parse_did_dns_identity(&["v=spf1 -all".into(), "random".into()]).is_none());
    }

    #[test]
    fn did_dns_blacklist() {
        let (recs, _, _) = did_dns_golden(&DidDnsOverrides {
            black: Some("OldAaaa,OldBbbb".into()),
            ..Default::default()
        });
        let id = parse_did_dns_identity(&recs).expect("identity");
        assert_eq!(id.blacklist, vec!["OldAaaa".to_string(), "OldBbbb".to_string()]);
    }

    #[test]
    fn did_dns_chain_breaks_on_tampered_pk() {
        let wrong_pk = B64URL.encode(vec![0xffu8; 32]);
        let (recs, _, _) = did_dns_golden(&DidDnsOverrides {
            pk: Some(wrong_pk),
            ..Default::default()
        });
        let id = parse_did_dns_identity(&recs).expect("identity");
        assert!(!id.fingerprint_chain_ok());
    }

    #[test]
    fn did_dns_compute_fingerprint_matches_spec() {
        let pk_bytes: Vec<u8> = (0u8..32).collect();
        let id = DidDnsIdentity {
            public_key_b64url: B64URL.encode(&pk_bytes),
            ..Default::default()
        };
        let got = id.compute_fingerprint().expect("fingerprint");
        assert_eq!(got.len(), 16);
        let mut hasher = Sha256::new();
        hasher.update(&pk_bytes);
        let digest = hasher.finalize();
        let want = B64URL.encode(&digest[..DID_DNS_FINGERPRINT_BYTES]);
        assert_eq!(got, want);
    }

    #[test]
    fn did_dns_is_valid_policy() {
        let now: i64 = 1_700_000_000;

        // Fresh ed25519 valid
        let (recs, _, _) = did_dns_golden(&DidDnsOverrides::default());
        let id = parse_did_dns_identity(&recs).expect("identity");
        assert!(id.is_valid(now));

        // RSA kty rejected
        let (recs_rsa, _, _) = did_dns_golden(&DidDnsOverrides {
            kty: Some("rsa".into()),
            ..Default::default()
        });
        let id_rsa = parse_did_dns_identity(&recs_rsa).expect("identity");
        assert_eq!(id_rsa.key_type, "rsa");
        assert!(!id_rsa.is_valid(now));

        // Revoked rejected
        let (recs_for_fp, fp, _) = did_dns_golden(&DidDnsOverrides::default());
        let _ = recs_for_fp;
        let (recs_rev, _, _) = did_dns_golden(&DidDnsOverrides {
            black: Some(fp.clone()),
            ..Default::default()
        });
        let id_rev = parse_did_dns_identity(&recs_rev).expect("identity");
        assert!(id_rev.is_revoked());
        assert!(!id_rev.is_valid(now));

        // Expired rejected
        let (recs_exp, _, _) = did_dns_golden(&DidDnsOverrides {
            exp: Some(now - 1),
            ..Default::default()
        });
        let id_exp = parse_did_dns_identity(&recs_exp).expect("identity");
        assert!(id_exp.is_expired(now));
        assert!(!id_exp.is_valid(now));

        // Stale iat flagged
        let (recs_stale, _, _) = did_dns_golden(&DidDnsOverrides {
            iat: Some(now - 600),
            ..Default::default()
        });
        let id_stale = parse_did_dns_identity(&recs_stale).expect("identity");
        assert!(id_stale.is_stale(now));
    }

    #[test]
    fn did_dns_nickname_decode() {
        let (recs, _, _) = did_dns_golden(&DidDnsOverrides {
            n: Some("QWxpY2U".into()),
            ..Default::default()
        });
        let id = parse_did_dns_identity(&recs).expect("identity");
        assert_eq!(id.nickname_decoded().as_deref(), Some("Alice"));

        let (recs_none, _, _) = did_dns_golden(&DidDnsOverrides::default());
        let id_none = parse_did_dns_identity(&recs_none).expect("identity");
        assert!(id_none.nickname_decoded().is_none());
    }
}
