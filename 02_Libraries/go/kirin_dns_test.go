package kirindns

import (
	"testing"
)

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

func TestParseTXTFull(t *testing.T) {
	p, ok := parseTXT(`{"http":8080,"https":8443,"ws":8080,"wss":8443}`)
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

func TestParseTXTPartial(t *testing.T) {
	p, ok := parseTXT(`{"https":8443}`)
	if !ok {
		t.Fatal("expected valid partial record")
	}
	if p["https"] != 8443 {
		t.Errorf("https = %d, want 8443", p["https"])
	}
}

func TestParseTXTEmpty(t *testing.T) {
	_, ok := parseTXT(`{}`)
	if ok {
		t.Error("expected invalid record for empty object")
	}
}

func TestParseTXTPortZero(t *testing.T) {
	_, ok := parseTXT(`{"http":0}`)
	if ok {
		t.Error("expected invalid record for port 0")
	}
}

func TestParseTXTPortOverflow(t *testing.T) {
	_, ok := parseTXT(`{"http":65536}`)
	if ok {
		t.Error("expected invalid record for overflow port")
	}
}

func TestParseTXTNotJSON(t *testing.T) {
	_, ok := parseTXT("not json")
	if ok {
		t.Error("expected invalid record for non-JSON")
	}
}

func TestParseTXTIgnoresUnknown(t *testing.T) {
	p, ok := parseTXT(`{"http":8080,"custom":"ignored"}`)
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
