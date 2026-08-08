package kirindns

import (
	"crypto/sha256"
	"encoding/base64"
	"net"
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

// ---------------------------------------------------------------------------
// v2 SRV selection (RFC 2782 priority/weight) — covers the fake-green gap.
// Previously only ResolveService(nonexistent) was tested (always returns nil),
// so the selection logic was never exercised by CI. These tests cover it
// directly via selectBestSrv without touching the network.
// ---------------------------------------------------------------------------

func TestSelectBestSrvLowestPriority(t *testing.T) {
	addrs := []*net.SRV{
		{Target: "high.kirinnet.org.", Port: 9000, Priority: 5, Weight: 0},
		{Target: "low.kirinnet.org.", Port: 8080, Priority: 1, Weight: 0},
		{Target: "mid.kirinnet.org.", Port: 3000, Priority: 3, Weight: 0},
	}
	got := selectBestSrv(addrs)
	if got == nil || got.Target != "low.kirinnet.org" || got.Port != 8080 {
		t.Fatalf("expected low/8080, got %+v", got)
	}
}

func TestSelectBestSrvHighestWeightWithinPriority(t *testing.T) {
	addrs := []*net.SRV{
		{Target: "a.kirinnet.org.", Port: 8081, Priority: 1, Weight: 10},
		{Target: "b.kirinnet.org.", Port: 8082, Priority: 1, Weight: 50},
		{Target: "c.kirinnet.org.", Port: 8083, Priority: 1, Weight: 30},
	}
	got := selectBestSrv(addrs)
	if got == nil || got.Target != "b.kirinnet.org" || got.Port != 8082 {
		t.Fatalf("expected b/8082 (highest weight), got %+v", got)
	}
}

func TestSelectBestSrvTrimsTrailingDot(t *testing.T) {
	addrs := []*net.SRV{
		{Target: "alice.kirinnet.org.", Port: 8082, Priority: 0, Weight: 0},
	}
	got := selectBestSrv(addrs)
	if got == nil || got.Target != "alice.kirinnet.org" {
		t.Fatalf("expected trailing dot stripped, got %+v", got)
	}
}

func TestSelectBestSrvEmpty(t *testing.T) {
	if selectBestSrv(nil) != nil {
		t.Fatal("expected nil for empty input")
	}
}

func TestSelectBestSrvSingle(t *testing.T) {
	addrs := []*net.SRV{
		{Target: "only.kirinnet.org.", Port: 443, Priority: 10, Weight: 5},
	}
	got := selectBestSrv(addrs)
	if got == nil || got.Port != 443 {
		t.Fatalf("expected 443, got %+v", got)
	}
}

// ---------------------------------------------------------------------------
// did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)
// Mirrors the Python/JS golden vectors.
// ---------------------------------------------------------------------------

// didDnsGolden builds the canonical 3-record set with a deterministic 32-byte
// key + its real fingerprint, plus optional overrides.
func didDnsGolden(t *testing.T, overrides map[string]string) ([]string, string, string) {
	t.Helper()
	pkBytes := make([]byte, 32)
	for i := range pkBytes {
		pkBytes[i] = byte(i)
	}
	pkB64 := base64.RawURLEncoding.EncodeToString(pkBytes)
	digest := sha256.Sum256(pkBytes)
	fp := base64.RawURLEncoding.EncodeToString(digest[:didDnsFingerprintBytes])
	now := int64(1_700_000_000)

	iat, ok := overrides["iat"]
	if !ok {
		iat = ""
	}
	if iat == "" {
		iat = "" // omit
	}
	exp, ok := overrides["exp"]
	if !ok {
		exp = ""
	}

	decl := "did:dns:v=1;fp=" + fp
	if v, ok := overrides["useFp"]; ok {
		decl = "did:dns:v=1;fp=" + v
	}
	if v, ok := overrides["n"]; ok {
		decl += ";n=" + v
	}
	if v, ok := overrides["g"]; ok {
		decl += ";g=" + v
	}
	if iat == "" {
		decl += ";iat=" + itoa64(now)
	} else {
		decl += ";iat=" + iat
	}
	if exp == "" {
		decl += ";exp=" + itoa64(now+3600)
	} else {
		decl += ";exp=" + exp
	}

	recs := []string{"v=spf1 include:_spf.kirinnet.org -all", decl}
	kty := "ed25519"
	if v, ok := overrides["kty"]; ok {
		kty = v
	}
	pkVal := pkB64
	if v, ok := overrides["pk"]; ok {
		pkVal = v
	}
	recs = append(recs, "did:dns:pk;kty="+kty+";pk="+pkVal)
	if v, ok := overrides["black"]; ok {
		recs = append(recs, "did:dns:black;fp="+v)
	}
	if v, ok := overrides["noise"]; ok {
		recs = append(recs, v)
	}
	return recs, fp, pkB64
}

func itoa64(n int64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func TestParseDidDnsFull(t *testing.T) {
	recs, fp, pkB64 := didDnsGolden(t, map[string]string{"n": "QWxpY2U", "g": "F"})
	id := ParseDidDnsIdentity(recs)
	if id == nil {
		t.Fatal("expected identity, got nil")
	}
	if id.Version != 1 {
		t.Errorf("version = %d, want 1", id.Version)
	}
	if id.Fingerprint != fp {
		t.Errorf("fp = %q, want %q", id.Fingerprint, fp)
	}
	if id.KeyType != "ed25519" {
		t.Errorf("kty = %q, want ed25519", id.KeyType)
	}
	if id.PublicKeyB64 != pkB64 {
		t.Errorf("pk = %q, want %q", id.PublicKeyB64, pkB64)
	}
	if !id.FingerprintChainOk() {
		t.Error("fingerprint chain should hold")
	}
}

func TestParseDidDnsRecordsAnyOrder(t *testing.T) {
	recs, fp, _ := didDnsGolden(t, nil)
	// reverse
	for i, j := 0, len(recs)-1; i < j; i, j = i+1, j-1 {
		recs[i], recs[j] = recs[j], recs[i]
	}
	id := ParseDidDnsIdentity(recs)
	if id == nil || id.Fingerprint != fp {
		t.Fatalf("expected fp=%q in any order", fp)
	}
}

func TestParseDidDnsNoiseIgnored(t *testing.T) {
	recs, _, _ := didDnsGolden(t, map[string]string{"noise": "v=DKIM1; k=rsa; p=MIGfMA0"})
	id := ParseDidDnsIdentity(recs)
	if id == nil || !id.FingerprintChainOk() {
		t.Fatal("SPF/DKIM noise must not break parsing")
	}
}

func TestParseDidDnsMissingDeclaration(t *testing.T) {
	if ParseDidDnsIdentity([]string{"did:dns:pk;kty=ed25519;pk=abc"}) != nil {
		t.Error("expected nil when declaration missing")
	}
}

func TestParseDidDnsMissingPk(t *testing.T) {
	if ParseDidDnsIdentity([]string{"did:dns:v=1;fp=x;iat=1;exp=2"}) != nil {
		t.Error("expected nil when pk missing")
	}
}

func TestParseDidDnsNoDidDns(t *testing.T) {
	// Legacy id=;key= must NOT be misclassified as did:dns
	if ParseDidDnsIdentity([]string{"id=foo;key=bar;nick=Alice"}) != nil {
		t.Error("legacy id= TXT must not be treated as did:dns")
	}
	if ParseDidDnsIdentity([]string{"v=spf1 -all", "random"}) != nil {
		t.Error("no did:dns records → nil")
	}
}

func TestParseDidDnsBlacklist(t *testing.T) {
	recs, _, _ := didDnsGolden(t, map[string]string{"black": "OldAaaa,OldBbbb"})
	id := ParseDidDnsIdentity(recs)
	if id == nil {
		t.Fatal("expected identity")
	}
	if len(id.Blacklist) != 2 || id.Blacklist[0] != "OldAaaa" {
		t.Errorf("blacklist = %v, want [OldAaaa OldBbbb]", id.Blacklist)
	}
}

func TestDidDnsFingerprintChainBreaksOnTamperedPk(t *testing.T) {
	wrong := base64.RawURLEncoding.EncodeToString(bytes32(0xff))
	recs, _, _ := didDnsGolden(t, map[string]string{"pk": wrong})
	id := ParseDidDnsIdentity(recs)
	if id == nil {
		t.Fatal("expected identity")
	}
	if id.FingerprintChainOk() {
		t.Error("tampered pk must break the fingerprint chain")
	}
}

func TestDidDnsComputeFingerprintMatchesSpec(t *testing.T) {
	pkBytes := make([]byte, 32)
	for i := range pkBytes {
		pkBytes[i] = byte(i)
	}
	id := &DidDnsIdentity{PublicKeyB64: base64.RawURLEncoding.EncodeToString(pkBytes)}
	got, err := id.ComputeFingerprint()
	if err != nil {
		t.Fatalf("computeFingerprint error: %v", err)
	}
	if len(got) != 16 {
		t.Errorf("fingerprint len = %d, want 16", len(got))
	}
	digest := sha256.Sum256(pkBytes)
	want := base64.RawURLEncoding.EncodeToString(digest[:didDnsFingerprintBytes])
	if got != want {
		t.Errorf("fingerprint = %q, want %q", got, want)
	}
}

func TestDidDnsIsValidPolicy(t *testing.T) {
	now := int64(1_700_000_000)

	// Fresh ed25519 valid
	recs, _, _ := didDnsGolden(t, nil)
	id := ParseDidDnsIdentity(recs)
	if id == nil || !id.IsValid(now) {
		t.Fatal("fresh ed25519 identity must be valid")
	}

	// RSA kty rejected
	recsRSA, _, _ := didDnsGolden(t, map[string]string{"kty": "rsa"})
	idRSA := ParseDidDnsIdentity(recsRSA)
	if idRSA.KeyType != "rsa" || idRSA.IsValid(now) {
		t.Fatal("rsa kty must be rejected by IsValid")
	}

	// Revoked rejected — blacklist the real fingerprint so the identity is revoked
	recsForFp, fp, _ := didDnsGolden(t, nil)
	_ = recsForFp // only used to obtain fp; rebuild with that fp in blacklist
	recsRev, _, _ := didDnsGolden(t, map[string]string{"black": fp})
	idRev := ParseDidDnsIdentity(recsRev)
	if idRev == nil || !idRev.IsRevoked() || idRev.IsValid(now) {
		t.Fatalf("revoked identity must be rejected; id=%+v", idRev)
	}

	// Expired rejected
	recsExp, _, _ := didDnsGolden(t, map[string]string{"exp": itoa64(now - 1)})
	idExp := ParseDidDnsIdentity(recsExp)
	if idExp == nil || !idExp.IsExpired(now) || idExp.IsValid(now) {
		t.Fatal("expired identity must be rejected")
	}

	// Stale iat flagged
	recsStale, _, _ := didDnsGolden(t, map[string]string{"iat": itoa64(now - 600)})
	idStale := ParseDidDnsIdentity(recsStale)
	if idStale == nil || !idStale.IsStale(now) {
		t.Fatal("stale iat must be flagged")
	}
}

func TestDidDnsNicknameDecode(t *testing.T) {
	recs, _, _ := didDnsGolden(t, map[string]string{"n": "QWxpY2U"})
	id := ParseDidDnsIdentity(recs)
	if id == nil {
		t.Fatal("expected identity")
	}
	if id.NicknameDecoded() != "Alice" {
		t.Errorf("nickname = %q, want Alice", id.NicknameDecoded())
	}
	// absent
	recsNoNick, _, _ := didDnsGolden(t, nil)
	idNoNick := ParseDidDnsIdentity(recsNoNick)
	if idNoNick.NicknameDecoded() != "" {
		t.Errorf("absent nickname should decode to empty, got %q", idNoNick.NicknameDecoded())
	}
}

// bytes32 returns a 32-byte slice filled with v.
func bytes32(v byte) []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = v
	}
	return b
}
