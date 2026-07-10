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
    return 0;
}
#endif

#endif // KIRIN_DNS_HPP
