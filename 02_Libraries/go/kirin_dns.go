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

	// RFC 2782: lowest priority, then highest weight
	best := addrs[0]
	for _, a := range addrs[1:] {
		if a.Priority < best.Priority {
			best = a
		} else if a.Priority == best.Priority && a.Weight > best.Weight {
			best = a
		}
	}

	target := strings.TrimSuffix(best.Target, ".")
	return &SRVResult{Target: target, Port: best.Port}, nil
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
