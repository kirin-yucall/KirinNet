// Package kirindns implements the KirinDNS Resolution Protocol (ADRP) v2.0.
//
// Architecture:
//
//	SRV records for service port discovery (_kirinnet-http._tcp, etc.)
//	TXT records for identity metadata (id=;key=;nick=;ipfs=)
//
// Example:
//
//	srv, err := kirindns.ResolveService("alice.kirinnet.org", "ws")
//	fmt.Printf("WS: %s:%d\n", srv.Target, srv.Port)
//
//	id, err := kirindns.ResolveIdentity("alice.kirinnet.org")
//	fmt.Printf("ID: %s, Nick: %s\n", id.ID, id.Nick)
package kirindns

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// SRVResult holds a resolved SRV service target and port.
type SRVResult struct {
	Target string
	Port   uint16
}

// Identity holds parsed identity metadata from a TXT record.
type Identity struct {
	ID   string
	Key  string
	Nick string // optional
	IPFS bool   // optional, defaults to false
}

// ---------------------------------------------------------------------------
// did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)
// ---------------------------------------------------------------------------

// DidDnsIdentity holds a parsed did:dns identity (declaration + public key,
// optional blacklist). Trust policy is applied by the caller via IsValid
// (fail-closed default): version 1 + ed25519 + fingerprint chain + not revoked
// + not expired.
type DidDnsIdentity struct {
	Version       int
	Fingerprint   string
	Nickname      string // Base64URL(UTF-8), may be empty
	Gender        string // M/F/O/X, may be empty
	IssuedAt      int64  // Unix seconds, 0 if absent
	ExpiresAt     int64
	KeyType       string
	PublicKeyB64  string
	Blacklist     []string
	RawDeclaration string
	RawPublicKey   string
}

const (
	didDnsPrefix       = "did:dns:"
	didDnsDeclPrefix   = "did:dns:v="
	didDnsPkPrefix     = "did:dns:pk;"
	didDnsBlackPrefix  = "did:dns:black;"
	didDnsKtyEd25519   = "ed25519"
	didDnsFingerprintBytes = 12
	didDnsFreshnessWindow  = 5 * 60 // ±5 minutes (spec §3.2.1)
)

// PublicKeyBytes decodes the Base64URL public key.
func (d *DidDnsIdentity) PublicKeyBytes() ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(d.PublicKeyB64)
}

// ComputeFingerprint recomputes fp = Base64URL(SHA-256(pk)[0:12]).
func (d *DidDnsIdentity) ComputeFingerprint() (string, error) {
	pk, err := d.PublicKeyBytes()
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(pk)
	return base64.RawURLEncoding.EncodeToString(digest[:didDnsFingerprintBytes]), nil
}

// FingerprintChainOk reports whether the declared fp matches the recomputed fp.
func (d *DidDnsIdentity) FingerprintChainOk() bool {
	if d.Fingerprint == "" {
		return false
	}
	got, err := d.ComputeFingerprint()
	return err == nil && got == d.Fingerprint
}

// IsRevoked reports whether the declaration fingerprint appears in the blacklist.
func (d *DidDnsIdentity) IsRevoked() bool {
	for _, f := range d.Blacklist {
		if f == d.Fingerprint {
			return true
		}
	}
	return false
}

// IsExpired reports whether exp <= now (0 ExpiresAt means no expiry check).
func (d *DidDnsIdentity) IsExpired(now int64) bool {
	if d.ExpiresAt == 0 {
		return false
	}
	return now >= d.ExpiresAt
}

// IsStale reports whether iat is outside ±5min of now.
func (d *DidDnsIdentity) IsStale(now int64) bool {
	if d.IssuedAt == 0 {
		return false
	}
	diff := now - d.IssuedAt
	if diff < 0 {
		diff = -diff
	}
	return diff > didDnsFreshnessWindow
}

// IsValid is the composite policy check (fail-closed).
func (d *DidDnsIdentity) IsValid(now int64) bool {
	return d.Version == 1 &&
		d.KeyType == didDnsKtyEd25519 &&
		d.FingerprintChainOk() &&
		!d.IsRevoked() &&
		!d.IsExpired(now)
}

// NicknameDecoded decodes the Base64URL(UTF-8) nickname, or "" if absent/invalid.
func (d *DidDnsIdentity) NicknameDecoded() string {
	if d.Nickname == "" {
		return ""
	}
	b, err := base64.RawURLEncoding.DecodeString(d.Nickname)
	if err != nil {
		return ""
	}
	return string(b)
}

// ParseDidDnsIdentity classifies TXT records by did:dns: sub-type and assembles
// an identity. Returns nil if no did:dns records or declaration+pk are missing.
// Pure function (no network) — usable for tests.
func ParseDidDnsIdentity(txtRecords []string) *DidDnsIdentity {
	var declRaw, pkRaw, blackRaw string
	for _, raw := range txtRecords {
		s := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(s, didDnsDeclPrefix) && declRaw == "":
			declRaw = s
		case strings.HasPrefix(s, didDnsPkPrefix) && pkRaw == "":
			pkRaw = s
		case strings.HasPrefix(s, didDnsBlackPrefix) && blackRaw == "":
			blackRaw = s
		}
	}
	if declRaw == "" || pkRaw == "" {
		return nil
	}

	decl := parseDidDnsKv(strings.TrimPrefix(declRaw, didDnsPrefix))
	pk := parseDidDnsKv(strings.TrimPrefix(pkRaw, didDnsPrefix))

	id := &DidDnsIdentity{
		Version:        didDnsAtoi(decl["v"], 1),
		Fingerprint:    decl["fp"],
		Nickname:       decl["n"],
		Gender:         decl["g"],
		KeyType:        pk["kty"],
		PublicKeyB64:   pk["pk"],
		RawDeclaration: declRaw,
		RawPublicKey:   pkRaw,
	}
	if pk["kty"] == "" {
		id.KeyType = didDnsKtyEd25519
	}
	if v, ok := decl["iat"]; ok {
		id.IssuedAt = didDnsAtoi64(v, 0)
	}
	if v, ok := decl["exp"]; ok {
		id.ExpiresAt = didDnsAtoi64(v, 0)
	}

	if blackRaw != "" {
		black := parseDidDnsKv(strings.TrimPrefix(blackRaw, didDnsPrefix))
		for _, f := range strings.Split(black["fp"], ",") {
			if f != "" {
				id.Blacklist = append(id.Blacklist, f)
			}
		}
	}
	return id
}

func parseDidDnsKv(text string) map[string]string {
	out := map[string]string{}
	for _, pair := range strings.Split(text, ";") {
		eq := strings.Index(pair, "=")
		if eq < 0 {
			continue
		}
		out[strings.TrimSpace(pair[:eq])] = strings.TrimSpace(pair[eq+1:])
	}
	return out
}

func didDnsAtoi(s string, def int) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	if s == "" {
		return def
	}
	return n
}

func didDnsAtoi64(s string, def int64) int64 {
	var n int64
	seen := false
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int64(c-'0')
		seen = true
	}
	if !seen {
		return def
	}
	return n
}

// FullResolution is the legacy wrapper result containing all services + identity.
type FullResolution struct {
	Domain   string
	WS       *SRVResult
	HTTP     *SRVResult
	HTTPS    *SRVResult
	Identity *Identity
}

// ResolvedPorts holds service port mappings (v1 legacy type).
type ResolvedPorts struct {
	HTTP, HTTPS, WS, WSS uint16
}

// ---------------------------------------------------------------------------
// Constants (spec Section 2.2)
// ---------------------------------------------------------------------------

// SRV service name prefixes.
const (
	SRVServiceHTTP  = "kirinnet-http"
	SRVServiceHTTPS = "kirinnet-https"
	SRVServiceWS    = "kirinnet-ws"
	SRVProto        = "tcp"
)

// Recognized service keys for resolveService.
var recognizedServices = map[string]string{
	"http":  SRVServiceHTTP,
	"https": SRVServiceHTTPS,
	"ws":    SRVServiceWS,
}

// Fallback ports (spec Section 3.3.1, Step 4)
const (
	DefaultHTTP  = 80
	DefaultHTTPS = 443
	DefaultWS    = 80
	DefaultWSS   = 443
)

// DefaultTimeout is the DNS query timeout.
var DefaultTimeout = 5 * time.Second

// ---------------------------------------------------------------------------
// Legacy v1 API (kept for backward compatibility)
// ---------------------------------------------------------------------------

// Fallback returns a ResolvedPorts with all standard IANA fallback values.
func Fallback() ResolvedPorts {
	return ResolvedPorts{DefaultHTTP, DefaultHTTPS, DefaultWS, DefaultWSS}
}

// Resolve queries DNS and returns resolved ports (v1 TXT-based API).
// Deprecated: Use ResolveService and ResolveIdentity for v2 SRV-based resolution.
func Resolve(domain string) (ResolvedPorts, error) {
	return ResolveWithResolver(domain, "")
}

// ResolveWithResolver uses a custom DNS resolver address (v1 API).
// Deprecated: Use ResolveService and ResolveIdentity for v2 SRV-based resolution.
func ResolveWithResolver(domain, resolverAddr string) (ResolvedPorts, error) {
	ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancel()
	return resolveV1(ctx, domain, resolverAddr)
}

func resolveV1(ctx context.Context, domain, resolverAddr string) (ResolvedPorts, error) {
	ports := Fallback()
	if !strings.HasSuffix(domain, ".") {
		domain += "."
	}

	var r *net.Resolver
	if resolverAddr != "" {
		r = &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
				d := net.Dialer{Timeout: DefaultTimeout}
				return d.DialContext(ctx, network, resolverAddr)
			},
		}
	} else {
		r = net.DefaultResolver
	}

	txts, err := r.LookupTXT(ctx, domain)
	if err != nil {
		return ports, nil
	}

	for _, txt := range txts {
		parsed, ok := parseTxtV1(txt)
		if !ok {
			continue
		}
		if v, e := parsed["http"]; e {
			ports.HTTP = v
		}
		if v, e := parsed["https"]; e {
			ports.HTTPS = v
		}
		if v, e := parsed["ws"]; e {
			ports.WS = v
		}
		if v, e := parsed["wss"]; e {
			ports.WSS = v
		}
		return ports, nil
	}
	return ports, nil
}

// ---------------------------------------------------------------------------
// Service Resolution (SRV) — v2 API
// ---------------------------------------------------------------------------

// ResolveService resolves a single service port via SRV.
//
// service must be one of: "http", "https", "ws".
// Returns nil, nil if no SRV record is found.
func ResolveService(domain, service string) (*SRVResult, error) {
	srvPrefix, ok := recognizedServices[service]
	if !ok {
		return nil, &ServiceError{Service: service}
	}

	ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancel()

	_, addrs, err := net.DefaultResolver.LookupSRV(ctx, srvPrefix, SRVProto, domain)
	if err != nil {
		return nil, nil // no SRV record
	}
	if len(addrs) == 0 {
		return nil, nil
	}

	return selectBestSrv(addrs), nil
}

// srvLike is the subset of net.SRV used by the selection algorithm; tests can
// construct these directly to cover RFC 2782 priority/weight selection without
// hitting the network.
type srvLike struct {
	Target   string
	Port     uint16
	Priority uint16
	Weight   uint16
}

// selectBestSrv applies RFC 2782 selection (lowest priority, then highest
// weight) and returns the chosen record as an *SRVResult. Exposed for tests.
func selectBestSrv(addrs []*net.SRV) *SRVResult {
	if len(addrs) == 0 {
		return nil
	}
	best := addrs[0]
	for _, a := range addrs[1:] {
		if a.Priority < best.Priority {
			best = a
		} else if a.Priority == best.Priority && a.Weight > best.Weight {
			best = a
		}
	}
	target := strings.TrimSuffix(best.Target, ".")
	return &SRVResult{Target: target, Port: best.Port}
}

// ResolveAllServices resolves all SRV services for a domain.
//
// Returns a map of service name -> SRVResult (nil if not found).
func ResolveAllServices(domain string) map[string]*SRVResult {
	result := make(map[string]*SRVResult, len(recognizedServices))
	for svc := range recognizedServices {
		srv, err := ResolveService(domain, svc)
		if err != nil {
			srv = nil
		}
		result[svc] = srv
	}
	return result
}

// ---------------------------------------------------------------------------
// Identity Resolution (TXT) — v2 API
// ---------------------------------------------------------------------------

// parseIdentityTxt parses a semicolon-separated key=value TXT string.
//
// Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
// Returns nil if the string is not a valid identity record.
func parseIdentityTxt(txt string) *Identity {
	txt = strings.TrimSpace(txt)
	if txt == "" || !strings.HasPrefix(txt, "id=") {
		return nil
	}

	result := &Identity{}
	for _, pair := range strings.Split(txt, ";") {
		eq := strings.Index(pair, "=")
		if eq == -1 {
			continue
		}
		key := strings.TrimSpace(pair[:eq])
		val := strings.TrimSpace(pair[eq+1:])

		switch key {
		case "id":
			result.ID = val
		case "key":
			result.Key = val
		case "nick":
			result.Nick = val
		case "ipfs":
			result.IPFS = val == "true"
		}
	}

	if result.ID == "" || result.Key == "" {
		return nil
	}
	return result
}

// ResolveIdentity resolves identity metadata from TXT records.
//
// Returns nil, nil if no identity TXT record is found.
func ResolveIdentity(domain string) (*Identity, error) {
	ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancel()

	txts, err := net.DefaultResolver.LookupTXT(ctx, domain)
	if err != nil {
		return nil, nil
	}

	for _, txt := range txts {
		id := parseIdentityTxt(txt)
		if id != nil {
			return id, nil
		}
	}
	return nil, nil
}

// ResolveIdentityDidDns resolves and assembles a did:dns identity for domain.
// Returns nil, nil on NXDOMAIN / no TXT / no did:dns records (fail-closed).
func ResolveIdentityDidDns(domain string) (*DidDnsIdentity, error) {
	ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancel()

	txts, err := net.DefaultResolver.LookupTXT(ctx, domain)
	if err != nil {
		return nil, nil
	}
	return ParseDidDnsIdentity(txts), nil
}

// ---------------------------------------------------------------------------
// Legacy Compatibility Wrapper — v2
// ---------------------------------------------------------------------------

// ResolveKirinDNS performs full resolution: SRV + TXT + identity.
//
// This is the legacy wrapper. New code should use ResolveService and
// ResolveIdentity directly.
func ResolveKirinDNS(domain string) (*FullResolution, error) {
	wsSrv, _ := ResolveService(domain, "ws")
	if wsSrv == nil {
		wsSrv = &SRVResult{Target: domain, Port: DefaultWS}
	}

	httpSrv, _ := ResolveService(domain, "http")
	httpsSrv, _ := ResolveService(domain, "https")
	identity, _ := ResolveIdentity(domain)

	return &FullResolution{
		Domain:   domain,
		WS:       wsSrv,
		HTTP:     httpSrv,
		HTTPS:    httpsSrv,
		Identity: identity,
	}, nil
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

// ServiceError is returned when an unrecognized service name is used.
type ServiceError struct {
	Service string
}

func (e *ServiceError) Error() string {
	return "unknown service: " + e.Service + ". Recognized: http, https, ws"
}

// ---------------------------------------------------------------------------
// v1 TXT parser (legacy, kept for backward compatibility)
// ---------------------------------------------------------------------------

var recognizedKeysV1 = map[string]bool{
	"http": true, "https": true, "ws": true, "wss": true,
}

func parseTxtV1(txt string) (map[string]uint16, bool) {
	txt = strings.TrimSpace(txt)

	var raw map[string]any
	if err := json.Unmarshal([]byte(txt), &raw); err != nil {
		return nil, false
	}

	result := make(map[string]uint16)
	hasKey := false
	for key, val := range raw {
		if !recognizedKeysV1[key] {
			continue
		}
		num, ok := val.(float64)
		if !ok || num < 1 || num > 65535 || num != float64(uint16(num)) {
			return nil, false
		}
		result[key] = uint16(num)
		hasKey = true
	}
	if !hasKey {
		return nil, false
	}
	return result, true
}
