package kirindns

import (
	"testing"
)

// ---------------------------------------------------------------------------
// v1 Legacy Tests (TXT JSON-based parser)
// ---------------------------------------------------------------------------

func TestFallback(t *testing.T) {
	p := Fallback()
	if p.HTTP != 80 {
		t.Errorf("HTTP = %d, want 80", p.HTTP)
	}
	if p.HTTPS != 443 {
		t.Errorf("HTTPS = %d, want 443", p.HTTPS)
	}
	if p.WS != 80 {
		t.Errorf("WS = %d, want 80", p.WS)
	}
	if p.WSS != 443 {
		t.Errorf("WSS = %d, want 443", p.WSS)
	}
}

func TestParseTxtV1Full(t *testing.T) {
	p, ok := parseTxtV1(`{"http":8080,"https":8443,"ws":8080,"wss":8443}`)
	if !ok {
		t.Fatal("expected valid record")
	}
	if p["http"] != 8080 {
		t.Errorf("http = %d, want 8080", p["http"])
	}
	if p["wss"] != 8443 {
		t.Errorf("wss = %d, want 8443", p["wss"])
	}
}

func TestParseTxtV1Partial(t *testing.T) {
	p, ok := parseTxtV1(`{"https":8443}`)
	if !ok {
		t.Fatal("expected valid partial record")
	}
	if p["https"] != 8443 {
		t.Errorf("https = %d, want 8443", p["https"])
	}
}

func TestParseTxtV1Empty(t *testing.T) {
	_, ok := parseTxtV1(`{}`)
	if ok {
		t.Error("expected invalid record for empty object")
	}
}

func TestParseTxtV1PortZero(t *testing.T) {
	_, ok := parseTxtV1(`{"http":0}`)
	if ok {
		t.Error("expected invalid record for port 0")
	}
}

func TestParseTxtV1PortOverflow(t *testing.T) {
	_, ok := parseTxtV1(`{"http":65536}`)
	if ok {
		t.Error("expected invalid record for overflow port")
	}
}

func TestParseTxtV1NotJSON(t *testing.T) {
	_, ok := parseTxtV1("not json")
	if ok {
		t.Error("expected invalid record for non-JSON")
	}
}

func TestParseTxtV1IgnoresUnknown(t *testing.T) {
	p, ok := parseTxtV1(`{"http":8080,"custom":"ignored"}`)
	if !ok {
		t.Fatal("expected valid record, unknown keys should be ignored")
	}
	if p["http"] != 8080 {
		t.Errorf("http = %d, want 8080", p["http"])
	}
}

func TestResolveNonexistent(t *testing.T) {
	ports, err := Resolve("nonexistent.invalid")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ports.HTTP != 80 {
		t.Errorf("expected fallback HTTP=80, got %d", ports.HTTP)
	}
	if ports.HTTPS != 443 {
		t.Errorf("expected fallback HTTPS=443, got %d", ports.HTTPS)
	}
}

// ---------------------------------------------------------------------------
// v2 Identity Parser Tests
// ---------------------------------------------------------------------------

func TestParseIdentityTxtFull(t *testing.T) {
	id := parseIdentityTxt("id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false")
	if id == nil {
		t.Fatal("expected valid identity")
	}
	if id.ID != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("id = %q, want 550e8400-e29b-41d4-a716-446655440000", id.ID)
	}
	if id.Key != "04abc" {
		t.Errorf("key = %q, want 04abc", id.Key)
	}
	if id.Nick != "Alice" {
		t.Errorf("nick = %q, want Alice", id.Nick)
	}
	if id.IPFS != false {
		t.Errorf("ipfs = %v, want false", id.IPFS)
	}
}

func TestParseIdentityTxtIPFSTrue(t *testing.T) {
	id := parseIdentityTxt("id=test;key=0x00;ipfs=true")
	if id == nil {
		t.Fatal("expected valid identity")
	}
	if id.IPFS != true {
		t.Errorf("ipfs = %v, want true", id.IPFS)
	}
}

func TestParseIdentityTxtMinimal(t *testing.T) {
	id := parseIdentityTxt("id=test-id;key=0x00")
	if id == nil {
		t.Fatal("expected valid minimal identity")
	}
	if id.ID != "test-id" {
		t.Errorf("id = %q, want test-id", id.ID)
	}
	if id.Key != "0x00" {
		t.Errorf("key = %q, want 0x00", id.Key)
	}
	if id.Nick != "" {
		t.Errorf("nick = %q, want empty", id.Nick)
	}
}

func TestParseIdentityTxtNoID(t *testing.T) {
	id := parseIdentityTxt("key=0x00")
	if id != nil {
		t.Error("expected nil for missing id")
	}
}

func TestParseIdentityTxtNoKey(t *testing.T) {
	id := parseIdentityTxt("id=test")
	if id != nil {
		t.Error("expected nil for missing key")
	}
}

func TestParseIdentityTxtEmpty(t *testing.T) {
	id := parseIdentityTxt("")
	if id != nil {
		t.Error("expected nil for empty string")
	}
}

func TestParseIdentityTxtNotIdentity(t *testing.T) {
	id := parseIdentityTxt("not an identity")
	if id != nil {
		t.Error("expected nil for non-identity string")
	}
}

func TestParseIdentityTxtSPFRecord(t *testing.T) {
	id := parseIdentityTxt("v=spf1 include:_spf.example.com")
	if id != nil {
		t.Error("expected nil for SPF record")
	}
}

func TestParseIdentityTxtWhitespace(t *testing.T) {
	id := parseIdentityTxt("  id=foo ; key=bar ; nick=Baz  ")
	if id == nil {
		t.Fatal("expected valid identity with whitespace")
	}
	if id.ID != "foo" {
		t.Errorf("id = %q, want foo", id.ID)
	}
	if id.Key != "bar" {
		t.Errorf("key = %q, want bar", id.Key)
	}
	if id.Nick != "Baz" {
		t.Errorf("nick = %q, want Baz", id.Nick)
	}
}

// ---------------------------------------------------------------------------
// v2 Service Error Tests
// ---------------------------------------------------------------------------

func TestResolveServiceUnknownService(t *testing.T) {
	_, err := ResolveService("example.com", "wss")
	if err == nil {
		t.Fatal("expected error for unknown service")
	}
	svcErr, ok := err.(*ServiceError)
	if !ok {
		t.Fatalf("expected *ServiceError, got %T", err)
	}
	if svcErr.Service != "wss" {
		t.Errorf("service = %q, want wss", svcErr.Service)
	}
}

// ---------------------------------------------------------------------------
// v2 SRV Resolution Tests (uses DNS, skipped if no network)
// ---------------------------------------------------------------------------

func TestResolveServiceNonexistent(t *testing.T) {
	srv, err := ResolveService("nonexistent.invalid", "ws")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if srv != nil {
		t.Errorf("expected nil SRV for nonexistent domain, got %+v", srv)
	}
}

func TestResolveIdentityNonexistent(t *testing.T) {
	id, err := ResolveIdentity("nonexistent.invalid")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != nil {
		t.Errorf("expected nil identity for nonexistent domain, got %+v", id)
	}
}

// ---------------------------------------------------------------------------
// v2 ResolveAllServices Tests
// ---------------------------------------------------------------------------

func TestResolveAllServicesNonexistent(t *testing.T) {
	all := ResolveAllServices("nonexistent.invalid")
	if len(all) != 3 {
		t.Errorf("expected 3 services, got %d", len(all))
	}
	for _, svc := range []string{"http", "https", "ws"} {
		if srv, ok := all[svc]; !ok {
			t.Errorf("missing key %q in result map", svc)
		} else if srv != nil {
			t.Errorf("expected nil for %q on nonexistent domain, got %+v", svc, srv)
		}
	}
}

// ---------------------------------------------------------------------------
// Legacy Wrapper Tests
// ---------------------------------------------------------------------------

func TestResolveKirinDNSNonexistent(t *testing.T) {
	full, err := ResolveKirinDNS("nonexistent.invalid")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if full.Domain != "nonexistent.invalid" {
		t.Errorf("domain = %q, want nonexistent.invalid", full.Domain)
	}
	if full.WS == nil {
		t.Fatal("expected non-nil WS (fallback)")
	}
	if full.WS.Port != DefaultWS {
		t.Errorf("WS port = %d, want %d", full.WS.Port, DefaultWS)
	}
	if full.WS.Target != "nonexistent.invalid" {
		t.Errorf("WS target = %q, want nonexistent.invalid", full.WS.Target)
	}
	if full.HTTP != nil {
		t.Errorf("expected nil HTTP for nonexistent domain, got %+v", full.HTTP)
	}
	if full.HTTPS != nil {
		t.Errorf("expected nil HTTPS for nonexistent domain, got %+v", full.HTTPS)
	}
	if full.Identity != nil {
		t.Errorf("expected nil Identity for nonexistent domain, got %+v", full.Identity)
	}
}

// ---------------------------------------------------------------------------
// Constants Tests
// ---------------------------------------------------------------------------

func TestRecognizedServices(t *testing.T) {
	expected := map[string]string{
		"http":  "kirinnet-http",
		"https": "kirinnet-https",
		"ws":    "kirinnet-ws",
	}
	for svc, prefix := range expected {
		got, ok := recognizedServices[svc]
		if !ok {
			t.Errorf("missing recognized service %q", svc)
		} else if got != prefix {
			t.Errorf("service %q prefix = %q, want %q", svc, got, prefix)
		}
	}
}

func TestServiceErrorFormat(t *testing.T) {
	err := &ServiceError{Service: "wss"}
	expected := "unknown service: wss. Recognized: http, https, ws"
	if err.Error() != expected {
		t.Errorf("error = %q, want %q", err.Error(), expected)
	}
}
