// kirin_dns.hpp — KirinDNS Resolution Protocol (ADRP) v2.0 C++17 Client
//
// Header-only. Implements ADRP as defined in 01_Standard/spec_v1.md.
//
// Architecture:
//   SRV records for service port discovery (_kirinnet-http._tcp, etc.)
//   TXT records for identity metadata (id=;key=;nick=;ipfs=)
//
// No external dependencies beyond the standard library and libresolv.
//
// Usage:
//   #include "kirin_dns.hpp"
//   auto srv = kirin::resolveService("alice.kirinnet.org", "ws");
//   if (srv) std::cout << srv->target << ":" << srv->port << '\n';
//   auto id = kirin::resolveIdentity("alice.kirinnet.org");
//   if (id) std::cout << id->id << '\n';
//
// Compile:  g++ -std=c++17 myapp.cpp -lresolv

#ifndef KIRIN_DNS_HPP
#define KIRIN_DNS_HPP

#include <arpa/inet.h>
#include <arpa/nameser.h>
#include <netinet/in.h>
#include <resolv.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace kirin {

// ==========================================================================
// Constants (spec Section 2.2)
// ==========================================================================

const std::map<std::string, std::string> SRV_SERVICES = {
    {"http",  "_kirinnet-http._tcp"},
    {"https", "_kirinnet-https._tcp"},
    {"ws",    "_kirinnet-ws._tcp"},
};

const std::map<std::string, uint16_t> FALLBACK_PORTS = {
    {"http",  80},
    {"https", 443},
    {"ws",    80},
    {"wss",   443},
};

// ==========================================================================
// Types
// ==========================================================================

/// Resolved SRV service target.
struct SrvResult {
    std::string target;
    uint16_t port = 0;
};

/// Parsed identity from TXT record.
struct Identity {
    std::string id;
    std::string key;
    std::string nick;
    bool ipfs = false;

    bool has_nick() const { return !nick.empty(); }
    bool has_ipfs() const { return ipfs; }
};

// ==========================================================================
// DNS query helpers
// ==========================================================================

/// Query DNS for a given type. Returns raw answer records.
inline std::vector<unsigned char> query_dns(const std::string& name, int qtype) {
    unsigned char buf[4096];
    int len = res_query(name.c_str(), C_IN, qtype, buf, sizeof(buf));
    if (len < 0) return {};

    ns_msg handle;
    if (ns_initparse(buf, len, &handle) < 0) return {};

    // Return the raw buffer for further parsing
    return std::vector<unsigned char>(buf, buf + len);
}

/// Parse TXT records from a DNS response.
inline std::vector<std::string> parse_txt_response(const std::vector<unsigned char>& buf) {
    std::vector<std::string> results;

    ns_msg handle;
    if (ns_initparse(buf.data(), static_cast<int>(buf.size()), &handle) < 0)
        return results;

    int count = ns_msg_count(handle, ns_s_an);
    for (int i = 0; i < count; i++) {
        ns_rr rr;
        if (ns_parserr(&handle, ns_s_an, i, &rr) < 0) continue;
        if (ns_rr_type(rr) != ns_t_txt) continue;

        const unsigned char* rdata = ns_rr_rdata(rr);
        int rdlen = ns_rr_rdlen(rr);
        if (rdlen < 1) continue;

        int txtlen = static_cast<int>(rdata[0]);
        if (txtlen < 1 || txtlen > rdlen - 1) continue;

        results.emplace_back(reinterpret_cast<const char*>(rdata + 1),
                             static_cast<size_t>(txtlen));
    }
    return results;
}

/// Parse SRV records from a DNS response.
inline std::vector<SrvResult> parse_srv_response(const std::vector<unsigned char>& buf) {
    std::vector<SrvResult> results;

    ns_msg handle;
    if (ns_initparse(buf.data(), static_cast<int>(buf.size()), &handle) < 0)
        return results;

    int count = ns_msg_count(handle, ns_s_an);
    for (int i = 0; i < count; i++) {
        ns_rr rr;
        if (ns_parserr(&handle, ns_s_an, i, &rr) < 0) continue;
        if (ns_rr_type(rr) != ns_t_srv) continue;

        const unsigned char* rdata = ns_rr_rdata(rr);
        int rdlen = ns_rr_rdlen(rr);
        if (rdlen < 6) continue;  // SRV RDATA minimum: pri(2)+weight(2)+port(2)

        uint16_t priority = ns_get16(rdata);
        uint16_t weight   = ns_get16(rdata + 2);
        uint16_t port     = ns_get16(rdata + 4);

        // Uncompress target name
        char target_name[256];
        int compressed = ns_name_uncompress(
            ns_msg_base(handle), ns_msg_end(handle),
            rdata + 6, target_name, sizeof(target_name));
        if (compressed < 0) continue;

        std::string target(target_name);
        // Strip trailing dot
        if (!target.empty() && target.back() == '.')
            target.pop_back();

        SrvResult srv;
        srv.target = target;
        srv.port = port;
        // Store priority/weight for sorting — use a simple index approach
        results.push_back(srv);
        // Note: we lose priority/weight after this struct. We'll sort separately.
    }

    return results;
}

/// Parse SRV records with priority/weight for sorting.
struct SrvRecordRaw {
    uint16_t priority;
    uint16_t weight;
    SrvResult result;
};

inline std::vector<SrvRecordRaw> parse_srv_raw(const std::vector<unsigned char>& buf) {
    std::vector<SrvRecordRaw> results;

    ns_msg handle;
    if (ns_initparse(buf.data(), static_cast<int>(buf.size()), &handle) < 0)
        return results;

    int count = ns_msg_count(handle, ns_s_an);
    for (int i = 0; i < count; i++) {
        ns_rr rr;
        if (ns_parserr(&handle, ns_s_an, i, &rr) < 0) continue;
        if (ns_rr_type(rr) != ns_t_srv) continue;

        const unsigned char* rdata = ns_rr_rdata(rr);
        int rdlen = ns_rr_rdlen(rr);
        if (rdlen < 6) continue;

        SrvRecordRaw raw;
        raw.priority = ns_get16(rdata);
        raw.weight   = ns_get16(rdata + 2);
        raw.result.port = ns_get16(rdata + 4);

        char target_name[256];
        int compressed = ns_name_uncompress(
            ns_msg_base(handle), ns_msg_end(handle),
            rdata + 6, target_name, sizeof(target_name));
        if (compressed < 0) continue;

        raw.result.target = std::string(target_name);
        if (!raw.result.target.empty() && raw.result.target.back() == '.')
            raw.result.target.pop_back();

        results.push_back(raw);
    }
    return results;
}

// ==========================================================================
// Service Resolution (SRV)
// ==========================================================================

/// Resolve a single service port via SRV.
///
/// Returns SrvResult if found, std::nullopt if no SRV record.
inline std::optional<SrvResult> resolveService(const std::string& domain,
                                                const std::string& service) {
    auto it = SRV_SERVICES.find(service);
    if (it == SRV_SERVICES.end()) {
        throw std::invalid_argument(
            "Unknown service: " + service + ". Recognized: http, https, ws");
    }

    std::string fullName = it->second + "." + domain;
    auto buf = query_dns(fullName, ns_t_srv);
    if (buf.empty()) return std::nullopt;

    auto records = parse_srv_raw(buf);
    if (records.empty()) return std::nullopt;

    // RFC 2782: sort by priority asc, then weight desc
    std::sort(records.begin(), records.end(),
              [](const SrvRecordRaw& a, const SrvRecordRaw& b) {
                  if (a.priority != b.priority) return a.priority < b.priority;
                  return a.weight > b.weight;
              });

    return records[0].result;
}

/// Resolve all SRV services for a domain.
inline std::map<std::string, std::optional<SrvResult>>
resolveAllServices(const std::string& domain) {
    std::map<std::string, std::optional<SrvResult>> results;
    for (const auto& [svc, _] : SRV_SERVICES) {
        results[svc] = resolveService(domain, svc);
    }
    return results;
}

// ==========================================================================
// Identity Resolution (TXT)
// ==========================================================================

/// Parse a semicolon-separated key=value TXT string into an Identity.
///
/// Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
/// (spec Section 3.2)
///
/// Returns std::nullopt if not a valid identity record.
inline std::optional<Identity> parseIdentityTxt(std::string_view txt) {
    // Trim
    auto start = txt.find_first_not_of(" \t\r\n");
    if (start == std::string_view::npos) return std::nullopt;
    txt = txt.substr(start);

    if (txt.size() < 3 || txt.substr(0, 3) != "id=") return std::nullopt;

    Identity id;
    bool has_id = false, has_key = false;

    size_t pos = 0;
    while (pos < txt.size()) {
        auto semi = txt.find(';', pos);
        std::string_view pair = (semi == std::string_view::npos)
            ? txt.substr(pos) : txt.substr(pos, semi - pos);

        auto eq = pair.find('=');
        if (eq != std::string_view::npos) {
            std::string key(pair.substr(0, eq));
            std::string val(pair.substr(eq + 1));
            // Trim key
            auto ks = key.find_first_not_of(" \t");
            auto ke = key.find_last_not_of(" \t");
            if (ks != std::string::npos) key = key.substr(ks, ke - ks + 1);
            // Trim val
            auto vs = val.find_first_not_of(" \t");
            auto ve = val.find_last_not_of(" \t");
            if (vs != std::string::npos) val = val.substr(vs, ve - vs + 1);

            if (key == "id")   { id.id = val; has_id = true; }
            if (key == "key")  { id.key = val; has_key = true; }
            if (key == "nick") { id.nick = val; }
            if (key == "ipfs") { id.ipfs = (val == "true"); }
        }

        if (semi == std::string_view::npos) break;
        pos = semi + 1;
    }

    if (!has_id || !has_key) return std::nullopt;
    return id;
}

/// Resolve identity metadata from TXT record.
inline std::optional<Identity> resolveIdentity(const std::string& domain) {
    auto buf = query_dns(domain, ns_t_txt);
    if (buf.empty()) return std::nullopt;

    auto txts = parse_txt_response(buf);
    for (const auto& txt : txts) {
        auto identity = parseIdentityTxt(txt);
        if (identity) return identity;
    }

    return std::nullopt;
}

// ==========================================================================
// did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)
// ==========================================================================
//
// Tamper-evident fingerprint chain: fp == Base64URL(SHA-256(pk)[0:12]).
// Pure, dependency-free (SHA-256 + Base64URL implemented inline below) so the
// self-test runs without linking a crypto library. Mirrors the Python/JS/Rust
// golden vectors.

namespace detail {

constexpr const char* DID_DNS_PREFIX       = "did:dns:";
constexpr const char* DID_DNS_DECL_PREFIX  = "did:dns:v=";
constexpr const char* DID_DNS_PK_PREFIX    = "did:dns:pk;";
constexpr const char* DID_DNS_BLACK_PREFIX = "did:dns:black;";
constexpr const char* DID_DNS_KTY_ED25519  = "ed25519";
constexpr int DID_DNS_FP_BYTES = 12;  // -> 16 base64url chars

// ---- SHA-256 (FIPS 180-4) ----
inline void sha256(const unsigned char* data, size_t len, unsigned char out[32]) {
    static const unsigned int K[64] = {
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,
        0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
        0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,
        0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
        0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
        0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,
        0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,
        0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
        0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 };
    auto ROTR = [](unsigned x, int n){ return (x >> n) | (x << (32 - n)); };
    unsigned h[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                     0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    std::vector<unsigned char> msg(data, data+len);
    uint64_t bitlen = (uint64_t)len * 8;
    msg.push_back(0x80);
    while (msg.size() % 64 != 56) msg.push_back(0);
    for (int i=7; i>=0; i--) msg.push_back((bitlen >> (i*8)) & 0xff);
    for (size_t off=0; off<msg.size(); off+=64) {
        unsigned m[64];
        for (int i=0;i<16;i++) m[i] = (msg[off+i*4]<<24)|(msg[off+i*4+1]<<16)|
                                     (msg[off+i*4+2]<<8)|msg[off+i*4+3];
        for (int i=16;i<64;i++){
            unsigned s0=ROTR(m[i-15],7)^ROTR(m[i-15],18)^(m[i-15]>>3);
            unsigned s1=ROTR(m[i-2],17)^ROTR(m[i-2],19)^(m[i-2]>>10);
            m[i]=m[i-16]+s0+m[i-7]+s1;
        }
        unsigned a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
        for (int i=0;i<64;i++){
            unsigned S1=ROTR(e,6)^ROTR(e,11)^ROTR(e,25);
            unsigned ch=(e&f)^((~e)&g);
            unsigned t1=hh+S1+ch+K[i]+m[i];
            unsigned S0=ROTR(a,2)^ROTR(a,13)^ROTR(a,22);
            unsigned maj=(a&b)^(a&c)^(b&c);
            unsigned t2=S0+maj;
            hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
        }
        h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
    }
    for (int i=0;i<8;i++){ out[i*4]=(h[i]>>24)&0xff;out[i*4+1]=(h[i]>>16)&0xff;
                           out[i*4+2]=(h[i]>>8)&0xff;out[i*4+3]=h[i]&0xff; }
}

// ---- Base64URL (RFC 4648 §5, no padding) ----
inline const char* B64URL_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

inline std::string base64urlEncode(const unsigned char* data, size_t len) {
    std::string out;
    int val=0, valb=-6;
    for (size_t i=0;i<len;i++){
        val=(val<<8)|data[i]; valb+=8;
        while (valb>=0){ out.push_back(B64URL_ALPHABET[(val>>valb)&0x3f]); valb-=6; }
    }
    if (valb>-6) out.push_back(B64URL_ALPHABET[((val<<8)>>(valb+8))&0x3f]);
    return out;
}

inline bool base64urlDecode(const std::string& in, std::vector<unsigned char>& out) {
    static int rev[256]; static bool init=false;
    if (!init){ for (int i=0;i<256;i++) rev[i]=-1;
                for (int i=0;i<64;i++) rev[(unsigned char)B64URL_ALPHABET[i]]=i; init=true; }
    int val=0, valb=-8;
    for (char ch : in){
        if (ch=='=') continue;
        int d = rev[(unsigned char)ch];
        if (d<0) return false;
        val=(val<<6)|d; valb+=6;
        if (valb>=0){ out.push_back((val>>valb)&0xff); valb-=8; }
    }
    return true;
}

inline std::map<std::string,std::string> parseDidDnsKv(const std::string& seg) {
    std::map<std::string,std::string> out;
    size_t pos=0;
    while (pos < seg.size()) {
        auto semi = seg.find(';', pos);
        std::string pair = (semi==std::string::npos) ? seg.substr(pos) : seg.substr(pos, semi-pos);
        auto eq = pair.find('=');
        if (eq != std::string::npos) {
            std::string k = pair.substr(0,eq), v = pair.substr(eq+1);
            auto trim=[](std::string& s){ auto a=s.find_first_not_of(" \t");
                auto b=s.find_last_not_of(" \t"); if(a!=std::string::npos) s=s.substr(a,b-a+1); };
            trim(k); trim(v);
            out[k]=v;
        }
        if (semi==std::string::npos) break;
        pos = semi+1;
    }
    return out;
}

} // namespace detail

/// Verified did:dns identity (declaration + public key, optional blacklist).
struct DidDnsIdentity {
    unsigned version = 1;
    std::string fingerprint;
    std::string nickname;   // Base64URL(UTF-8)
    std::string gender;     // M/F/O/X
    long long issued_at = 0;
    long long expires_at = 0;
    std::string key_type = detail::DID_DNS_KTY_ED25519;
    std::string public_key_b64url;
    std::vector<std::string> blacklist;

    /// Recompute fp = Base64URL(SHA-256(pk)[0:12]).
    std::string computeFingerprint() const {
        std::vector<unsigned char> pk;
        if (!detail::base64urlDecode(public_key_b64url, pk) || pk.empty()) return "";
        unsigned char digest[32];
        detail::sha256(pk.data(), pk.size(), digest);
        return detail::base64urlEncode(digest, detail::DID_DNS_FP_BYTES);
    }
    /// True iff declared fp matches recomputed fp over the pk bytes.
    bool fingerprintChainOk() const {
        return !fingerprint.empty() && fingerprint == computeFingerprint();
    }
    bool isRevoked() const {
        return std::find(blacklist.begin(), blacklist.end(), fingerprint) != blacklist.end();
    }
    bool isExpired(long long now) const {
        return expires_at != 0 && now >= expires_at;
    }
    /// Composite policy: v1 + ed25519 + chain + not revoked + not expired.
    bool isValid(long long now) const {
        return version==1 && key_type==detail::DID_DNS_KTY_ED25519
            && fingerprintChainOk() && !isRevoked() && !isExpired(now);
    }
    /// Decode the Base64URL(UTF-8) nickname, or "" if absent/invalid.
    std::string nicknameDecoded() const {
        if (nickname.empty()) return "";
        std::vector<unsigned char> bytes;
        if (!detail::base64urlDecode(nickname, bytes)) return "";
        return std::string(bytes.begin(), bytes.end());
    }
};

/// Classify TXT records by did:dns: sub-type; assemble an identity.
/// Returns std::nullopt if no did:dns records / declaration+pk missing.
inline std::optional<DidDnsIdentity> parseDidDnsIdentity(
        const std::vector<std::string>& txtRecords) {
    const std::string* declRaw=nullptr; const std::string* pkRaw=nullptr;
    const std::string* blackRaw=nullptr;
    for (const auto& raw : txtRecords) {
        std::string s = raw;
        auto ns = s.find_first_not_of(" \t");
        if (ns!=std::string::npos) s = s.substr(ns);
        if      (!declRaw  && s.rfind(detail::DID_DNS_DECL_PREFIX,0)==0)  declRaw=&raw;
        else if (!pkRaw    && s.rfind(detail::DID_DNS_PK_PREFIX,0)==0)    pkRaw=&raw;
        else if (!blackRaw && s.rfind(detail::DID_DNS_BLACK_PREFIX,0)==0) blackRaw=&raw;
    }
    if (!declRaw || !pkRaw) return std::nullopt;

    auto decl = detail::parseDidDnsKv(declRaw->substr(std::string(detail::DID_DNS_PREFIX).size()));
    auto pk   = detail::parseDidDnsKv(pkRaw->substr(std::string(detail::DID_DNS_PREFIX).size()));

    DidDnsIdentity id;
    id.version = decl.count("v") ? std::stoul(decl["v"]) : 1;
    id.fingerprint = decl.count("fp") ? decl["fp"] : "";
    id.nickname = decl.count("n") ? decl["n"] : "";
    id.gender = decl.count("g") ? decl["g"] : "";
    id.issued_at  = decl.count("iat") ? std::stoll(decl["iat"]) : 0;
    id.expires_at = decl.count("exp") ? std::stoll(decl["exp"]) : 0;
    id.key_type = pk.count("kty") ? pk["kty"] : detail::DID_DNS_KTY_ED25519;
    id.public_key_b64url = pk.count("pk") ? pk["pk"] : "";

    if (blackRaw) {
        auto bkv = detail::parseDidDnsKv(blackRaw->substr(std::string(detail::DID_DNS_PREFIX).size()));
        if (bkv.count("fp")) {
            std::string fp = bkv["fp"]; size_t pos=0;
            while (pos < fp.size()) {
                auto c = fp.find(',', pos);
                std::string tok = (c==std::string::npos)? fp.substr(pos) : fp.substr(pos, c-pos);
                if (!tok.empty()) id.blacklist.push_back(tok);
                if (c==std::string::npos) break; pos=c+1;
            }
        }
    }
    return id;
}

// ==========================================================================
// Legacy Compatibility Wrapper
// ==========================================================================

/// Full resolution: SRV + TXT + identity (legacy wrapper).
///
/// New code should use resolveService() and resolveIdentity() directly.
struct KirinDnsResult {
    std::string domain;
    SrvResult ws;
    std::optional<SrvResult> http;
    std::optional<SrvResult> https;
    std::optional<Identity> identity;
};

inline KirinDnsResult resolve_kirin_dns(const std::string& domain) {
    KirinDnsResult result;
    result.domain = domain;

    auto ws = resolveService(domain, "ws");
    if (ws) {
        result.ws = *ws;
    } else {
        result.ws.target = domain;
        result.ws.port = FALLBACK_PORTS.at("ws");
    }

    result.http = resolveService(domain, "http");
    result.https = resolveService(domain, "https");
    result.identity = resolveIdentity(domain);

    return result;
}

} // namespace kirin

// ==========================================================================
// Self-test (compile with -DTEST_KIRIN_DNS)
// ==========================================================================
#ifdef TEST_KIRIN_DNS
#include <cassert>
#include <iostream>

int main() {
    using namespace kirin;

    // SRV nonexistent domain
    {
        auto ws = resolveService("nonexistent.invalid", "ws");
        assert(!ws.has_value());
    }

    // TXT identity nonexistent domain
    {
        auto id = resolveIdentity("nonexistent.invalid");
        assert(!id.has_value());
    }

    // Identity parser
    {
        auto parsed = parseIdentityTxt(
            "id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false");
        assert(parsed.has_value());
        assert(parsed->id == "550e8400-e29b-41d4-a716-446655440000");
        assert(parsed->key == "04abc");
        assert(parsed->nick == "Alice");
        assert(parsed->ipfs == false);
    }

    {
        auto minimal = parseIdentityTxt("id=test-id;key=0x00");
        assert(minimal.has_value());
        assert(minimal->id == "test-id");
        assert(minimal->key == "0x00");
        assert(!minimal->has_nick());
    }

    // Invalid TXT
    assert(!parseIdentityTxt("v=spf1 include:_spf.example.com").has_value());
    assert(!parseIdentityTxt("").has_value());
    assert(!parseIdentityTxt("not an identity").has_value());

    // Fallback ports
    assert(FALLBACK_PORTS.at("ws") == 80);
    assert(FALLBACK_PORTS.at("http") == 80);
    assert(FALLBACK_PORTS.at("https") == 443);

    // Legacy wrapper
    {
        auto full = resolve_kirin_dns("nonexistent.invalid");
        assert(full.domain == "nonexistent.invalid");
        assert(full.ws.port == 80);
        assert(!full.http.has_value());
        assert(!full.identity.has_value());
    }

    std::cout << "kirin_dns C++ self-test: PASSED\n";

    // ---- did:dns three-record identity model (C-1 baseline) ----
    {
        // Deterministic 32-byte key = bytes 0..31 (matches the golden vector).
        std::vector<unsigned char> pkBytes(32);
        for (int i=0;i<32;i++) pkBytes[i]=(unsigned char)i;
        std::string pkB64 = detail::base64urlEncode(pkBytes.data(), 32);
        unsigned char dg[32]; detail::sha256(pkBytes.data(), 32, dg);
        std::string fpCalc = detail::base64urlEncode(dg, detail::DID_DNS_FP_BYTES);
        long long now = 1700000000LL;

        std::vector<std::string> recs = {
            "v=spf1 include:_spf.kirinnet.org -all",
            "did:dns:v=1;fp="+fpCalc+";n=QWxpY2U;g=F;iat="+std::to_string(now)+";exp="+std::to_string(now+3600),
            "did:dns:pk;kty=ed25519;pk="+pkB64,
            "did:dns:black;fp=RevokedAaaa,RevokedBbbb",
        };
        auto id = parseDidDnsIdentity(recs);
        assert(id.has_value());
        assert(id->version == 1);
        assert(id->fingerprint == fpCalc);
        assert(id->key_type == "ed25519");
        assert(id->fingerprintChainOk());
        assert(id->isValid(now));
        assert(id->nicknameDecoded() == "Alice");
        assert(!id->isRevoked());

        // Tampered pk -> chain breaks
        std::vector<unsigned char> wrong(32, 0xff);
        std::string wrongB64 = detail::base64urlEncode(wrong.data(), 32);
        auto tampered = recs;
        tampered[2] = "did:dns:pk;kty=ed25519;pk="+wrongB64;
        auto broken = parseDidDnsIdentity(tampered);
        assert(broken.has_value() && !broken->fingerprintChainOk());

        // Missing pk -> nullopt
        assert(!parseDidDnsIdentity({recs[1]}).has_value());
        // No did:dns -> nullopt (legacy id= ignored)
        assert(!parseDidDnsIdentity({"v=spf1 -all","id=foo;key=bar"}).has_value());
        // Wrong kty -> invalid
        auto rsaRecs = std::vector<std::string>{recs[1], "did:dns:pk;kty=rsa;pk="+pkB64};
        auto rsaId = parseDidDnsIdentity(rsaRecs);
        assert(rsaId.has_value() && rsaId->key_type=="rsa" && !rsaId->isValid(now));
    }
    std::cout << "kirin_dns C++ did:dns self-test: PASSED (fingerprint chain)\n";

    return 0;
}
#endif

#endif // KIRIN_DNS_HPP
