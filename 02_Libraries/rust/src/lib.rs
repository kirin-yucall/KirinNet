//! KirinDNS Resolution Protocol (ADRP) — Rust Client Library
//!
//! Resolves service port mappings from DNS TXT records as defined in
//! `01_Standard/spec_v1.md`.  The protocol name was formerly "AuraDNS".
//!
//! # Resolution algorithm
//!
//! 1. Query TXT records for the target domain.
//! 2. Attempt to parse each TXT record as JSON.
//! 3. The first valid record containing at least one recognized key
//!    (`http`, `https`, `ws`, `wss`) is the ADRP response.
//! 4. If no valid record is found, return the standard fallback ports.
//!
//! # Example
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
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;
use thiserror::Error;
use trust_dns_resolver::config::{ResolverConfig, ResolverOpts};
use trust_dns_resolver::TokioAsyncResolver;

// ---------------------------------------------------------------------------
// Recognized keys and fallback ports (spec §3.2, Step 5)
// ---------------------------------------------------------------------------

const RECOGNIZED_KEYS: [&str; 4] = ["http", "https", "ws", "wss"];

const FALLBACK_HTTP: u16 = 80;
const FALLBACK_HTTPS: u16 = 443;
const FALLBACK_WS: u16 = 80;
const FALLBACK_WSS: u16 = 443;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors that can occur during KirinDNS resolution.
#[derive(Error, Debug)]
pub enum KirinDnsError {
    /// DNS resolution itself failed (network error, timeout, etc.).
    #[error("DNS resolution failed: {0}")]
    DnsError(#[from] trust_dns_resolver::error::ResolveError),

    /// The TXT record contained invalid JSON or an invalid ADRP payload.
    #[error("Invalid ADRP record: {0}")]
    InvalidRecord(String),
}

// ---------------------------------------------------------------------------
// Resolved ports
// ---------------------------------------------------------------------------

/// Holds the resolved service port mapping.
///
/// All four recognized protocols always have a value — either from a valid
/// ADRP record or the standard IANA fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPorts {
    http: u16,
    https: u16,
    ws: u16,
    wss: u16,
}

impl ResolvedPorts {
    /// Create a `ResolvedPorts` with all fallback values.
    fn fallback() -> Self {
        Self {
            http: FALLBACK_HTTP,
            https: FALLBACK_HTTPS,
            ws: FALLBACK_WS,
            wss: FALLBACK_WSS,
        }
    }

    /// Resolve KirinDNS ports for *domain* using the system DNS resolver.
    ///
    /// Returns `Ok(ResolvedPorts)` with either the ADRP-record values or
    /// the standard fallbacks if no valid record was found.
    pub async fn resolve(domain: &str) -> Result<Self, KirinDnsError> {
        let resolver = TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default())?;
        Self::resolve_with(domain, &resolver).await
    }

    /// Resolve using a pre-configured resolver (useful for testing).
    pub async fn resolve_with(
        domain: &str,
        resolver: &TokioAsyncResolver,
    ) -> Result<Self, KirinDnsError> {
        let mut ports = Self::fallback();

        // Query TXT records
        let lookup = match resolver.txt_lookup(domain).await {
            Ok(l) => l,
            Err(_) => return Ok(ports), // NXDOMAIN, no TXT, etc. → fallback
        };

        // "First valid" rule (spec §3.1.2)
        for record in lookup.iter() {
            let txt: String = record
                .iter()
                .flat_map(|b| std::str::from_utf8(b).ok())
                .collect();

            if let Some(parsed) = parse_txt_value(&txt) {
                // Overwrite only recognized keys
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

    // -- Accessors --

    pub fn http(&self) -> u16 {
        self.http
    }
    pub fn https(&self) -> u16 {
        self.https
    }
    pub fn ws(&self) -> u16 {
        self.ws
    }
    pub fn wss(&self) -> u16 {
        self.wss
    }

    /// Return all ports as a tuple `(http, https, ws, wss)`.
    pub fn all(&self) -> (u16, u16, u16, u16) {
        (self.http, self.https, self.ws, self.wss)
    }
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/// Intermediate deserialization target — all fields are optional because a
/// partial record is valid per spec.
#[derive(Debug, Deserialize)]
struct AdrpRecord {
    http: Option<u16>,
    https: Option<u16>,
    ws: Option<u16>,
    wss: Option<u16>,
}

fn parse_txt_value(txt: &str) -> Option<AdrpRecord> {
    let record: AdrpRecord = serde_json::from_str(txt).ok()?;

    // At least one recognized key must be present
    if record.http.is_none()
        && record.https.is_none()
        && record.ws.is_none()
        && record.wss.is_none()
    {
        return None;
    }

    // All recognized values must be valid ports (1-65535); serde's u16
    // guarantees 0-65535, but we reject 0 here.
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

    #[test]
    fn fallback_ports() {
        let ports = ResolvedPorts::fallback();
        assert_eq!(ports.http(), 80);
        assert_eq!(ports.https(), 443);
        assert_eq!(ports.ws(), 80);
        assert_eq!(ports.wss(), 443);
    }

    #[test]
    fn parse_valid_full() {
        let record = parse_txt_value(r#"{"http":8080,"https":8443,"ws":8080,"wss":8443}"#);
        assert!(record.is_some());
        let r = record.unwrap();
        assert_eq!(r.http, Some(8080));
        assert_eq!(r.wss, Some(8443));
    }

    #[test]
    fn parse_valid_partial() {
        // Single key is valid per spec
        let record = parse_txt_value(r#"{"https":8443}"#);
        assert!(record.is_some());
    }

    #[test]
    fn parse_invalid_empty() {
        assert!(parse_txt_value(r#"{}"#).is_none());
    }

    #[test]
    fn parse_invalid_port_zero() {
        assert!(parse_txt_value(r#"{"http":0}"#).is_none());
    }

    #[test]
    fn parse_invalid_wrong_type() {
        assert!(parse_txt_value(r#"{"http":"8080"}"#).is_none());
    }

    #[test]
    fn parse_invalid_json() {
        assert!(parse_txt_value("not json").is_none());
    }

    #[test]
    fn parse_ignores_unknown_keys() {
        // Unknown keys are silently ignored per spec §3.1.1
        let record = parse_txt_value(r#"{"http":8080,"custom_field":"ignored"}"#);
        assert!(record.is_some());
        assert_eq!(record.unwrap().http, Some(8080));
    }
}
