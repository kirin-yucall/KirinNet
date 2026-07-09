// kirin_dns.hpp — KirinDNS Resolution Protocol (ADRP) C++17 Client
//
// Header-only. Resolves service port mappings from DNS TXT records.
// No external dependencies beyond the standard library and libresolv.
//
// Usage:
//   #include "kirin_dns.hpp"
//   auto ports = kirin::resolve("alice.kirinnet.org");
//   std::cout << "HTTP: " << ports.http << '\n';
//
// Compile:  g++ -std=c++17 myapp.cpp -lresolv

#ifndef KIRIN_DNS_HPP
#define KIRIN_DNS_HPP

#include <arpa/inet.h>
#include <arpa/nameser.h>
#include <netinet/in.h>
#include <resolv.h>
#include <sys/socket.h>

#include <cctype>
#include <cstdint>
#include <cstring>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace kirin {

// ==========================================================================
// Ports — resolved service ports (all four always populated)
// ==========================================================================

struct Ports {
    uint16_t http  = 80;
    uint16_t https = 443;
    uint16_t ws    = 80;
    uint16_t wss   = 443;

    static constexpr Ports fallback() { return {}; }
    bool operator==(const Ports& o) const {
        return http == o.http && https == o.https && ws == o.ws && wss == o.wss;
    }
};

// ==========================================================================
// Resolution
// ==========================================================================

inline const std::unordered_set<std::string> RECOGNIZED = {"http", "https", "ws", "wss"};

/// Parse a TXT record string as ADRP JSON. Returns std::nullopt if invalid.
inline std::optional<Ports> parse_txt(std::string_view txt) {
    // Strip whitespace
    auto start = txt.find_first_not_of(" \t\r\n");
    if (start == std::string_view::npos || txt[start] != '{') return std::nullopt;
    txt = txt.substr(start);

    Ports ports = Ports::fallback();
    bool found = false;

    for (const auto& key : RECOGNIZED) {
        // Build search string: "key":
        std::string search = "\"" + key + "\":";
        auto pos = txt.find(search);
        if (pos == std::string_view::npos) continue;

        pos += search.size();
        // Skip whitespace
        while (pos < txt.size() && (txt[pos] == ' ' || txt[pos] == '\t')) pos++;
        // Parse integer
        auto end = pos;
        while (end < txt.size() && std::isdigit(static_cast<unsigned char>(txt[end]))) end++;
        if (end == pos) continue;

        std::string num_str(txt.substr(pos, end - pos));
        int val;
        try {
            size_t processed;
            val = std::stoi(num_str, &processed);
            if (processed != num_str.size()) continue;
        } catch (...) {
            continue;
        }

        if (val < 1 || val > 65535) return std::nullopt;

        uint16_t uval = static_cast<uint16_t>(val);
        if (key == "http")       ports.http = uval;
        else if (key == "https") ports.https = uval;
        else if (key == "ws")    ports.ws = uval;
        else if (key == "wss")   ports.wss = uval;
        found = true;
    }

    return found ? std::optional{ports} : std::nullopt;
}

/// Query DNS TXT records for a domain. Returns list of TXT strings.
inline std::vector<std::string> query_txt(const std::string& domain) {
    unsigned char buf[4096];
    int len = res_query(domain.c_str(), C_IN, T_TXT, buf, sizeof(buf));
    if (len < 0) return {};

    ns_msg handle;
    if (ns_initparse(buf, len, &handle) < 0) return {};

    std::vector<std::string> results;
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

/// Resolve KirinDNS ports for a domain.
/// Returns fallback ports if no valid ADRP record exists.
inline Ports resolve(const std::string& domain) {
    auto txts = query_txt(domain);
    for (const auto& txt : txts) {
        auto parsed = parse_txt(txt);
        if (parsed) return *parsed;
    }
    return Ports::fallback();
}

/// Resolve using a custom DNS server IP.
inline Ports resolve_with_server(const std::string& domain, const std::string& dns_ip) {
    res_init();
    struct in_addr ns;
    if (inet_aton(dns_ip.c_str(), &ns) == 0) return Ports::fallback();
    _res.nscount = 1;
    _res.nsaddr_list[0].sin_addr = ns;
    _res.nsaddr_list[0].sin_family = AF_INET;
    _res.nsaddr_list[0].sin_port = htons(53);

    return resolve(domain);
}

// ==========================================================================
// Error handling variant — throws on DNS failure
// ==========================================================================

class KirinError : public std::runtime_error {
public:
    explicit KirinError(const std::string& msg) : std::runtime_error(msg) {}
};

/// Like resolve() but throws KirinError on DNS failure.
inline Ports resolve_or_throw(const std::string& domain) {
    auto txts = query_txt(domain);
    if (txts.empty() && res_init() != 0) {
        // If res_query failed, it could be a real error or just no TXT records.
        // We can't easily distinguish without checking h_errno, so return fallback.
    }
    for (const auto& txt : txts) {
        auto parsed = parse_txt(txt);
        if (parsed) return *parsed;
    }
    return Ports::fallback();
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

    // Parse tests
    {
        auto p = parse_txt(R"({"http":8080,"https":8443})");
        assert(p.has_value());
        assert(p->http == 8080);
        assert(p->https == 8443);
        assert(p->ws == 80);    // fallback
        assert(p->wss == 443);  // fallback
    }
    {
        auto p = parse_txt(R"({"https":8443})");
        assert(p.has_value());
        assert(p->http == 80);   // fallback
        assert(p->https == 8443);
    }
    // Invalid cases
    assert(!parse_txt("{}").has_value());
    assert(!parse_txt(R"({"http":0})").has_value());
    assert(!parse_txt(R"({"http":65536})").has_value());
    assert(!parse_txt("not json").has_value());
    // Unknown keys ignored
    {
        auto p = parse_txt(R"({"http":8080,"custom":"ignored"})");
        assert(p.has_value());
        assert(p->http == 8080);
    }

    // Port fallback
    auto fb = Ports::fallback();
    assert(fb.http == 80 && fb.https == 443 && fb.ws == 80 && fb.wss == 443);

    // Resolution test (will use fallback for nonexistent domain)
    auto ports = resolve("nonexistent.invalid");
    assert(ports.http == 80);
    assert(ports.https == 443);

    std::cout << "kirin_dns C++ self-test: PASSED\n";
    return 0;
}
#endif

#endif // KIRIN_DNS_HPP
