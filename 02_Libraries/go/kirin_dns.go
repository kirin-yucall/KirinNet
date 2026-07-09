// Package kirindns implements the KirinDNS Resolution Protocol (ADRP).
//
// Resolves service port mappings from DNS TXT records as defined in
// 01_Standard/spec_v1.md.
//
// Example:
//
//	ports, err := kirindns.Resolve("example.com")
//	fmt.Printf("HTTP: %d\n", ports.HTTP)
package kirindns

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"time"
)

var recognizedKeys = map[string]bool{
	"http": true, "https": true, "ws": true, "wss": true,
}

const (
	DefaultHTTP  = 80
	DefaultHTTPS = 443
	DefaultWS    = 80
	DefaultWSS   = 443
)

var DefaultTimeout = 5 * time.Second

// ResolvedPorts holds service port mappings for a KirinDNS domain.
type ResolvedPorts struct {
	HTTP, HTTPS, WS, WSS uint16
}

// Fallback returns a ResolvedPorts with all standard IANA fallback values.
func Fallback() ResolvedPorts {
	return ResolvedPorts{DefaultHTTP, DefaultHTTPS, DefaultWS, DefaultWSS}
}

// Resolve queries DNS TXT records for domain and returns resolved ports.
// Returns fallback ports if no valid ADRP record is found.
func Resolve(domain string) (ResolvedPorts, error) {
	ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancel()
	return resolve(ctx, domain, "")
}

// ResolveWithResolver uses a custom DNS resolver address (e.g. "8.8.8.8:53").
func ResolveWithResolver(domain, resolverAddr string) (ResolvedPorts, error) {
	ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancel()
	return resolve(ctx, domain, resolverAddr)
}

func resolve(ctx context.Context, domain, resolverAddr string) (ResolvedPorts, error) {
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
		return ports, nil // NXDOMAIN / no TXT → fallback
	}

	for _, txt := range txts {
		parsed, ok := parseTXT(txt)
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

func parseTXT(txt string) (map[string]uint16, bool) {
	txt = strings.TrimSpace(txt)

	var raw map[string]any
	if err := json.Unmarshal([]byte(txt), &raw); err != nil {
		return nil, false
	}

	result := make(map[string]uint16)
	hasKey := false
	for key, val := range raw {
		if !recognizedKeys[key] {
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
