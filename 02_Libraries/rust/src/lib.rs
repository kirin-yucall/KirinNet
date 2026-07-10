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

use serde::Deserialize;
use thiserror::Error;
use trust_dns_resolver::config::{ResolverConfig, ResolverOpts};
use trust_dns_resolver::TokioAsyncResolver;

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
}
