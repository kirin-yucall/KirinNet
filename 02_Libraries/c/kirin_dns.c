/*
 * kirin_dns.c — KirinDNS Resolution Protocol (ADRP) v2.0 C Implementation
 *
 * Uses res_query() from libresolv for DNS SRV and TXT queries.
 * SRV: T_SRV (ns_t_srv from arpa/nameser_compat.h)
 * TXT identity: semicolon-separated key=value format
 * Legacy ADRP JSON TXT parser preserved for backward compatibility.
 *
 * Build:  gcc -c kirin_dns.c -lresolv
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include "kirin_dns.h"

#include <arpa/inet.h>
#include <arpa/nameser.h>
#include <arpa/nameser_compat.h>
#include <netinet/in.h>
#include <resolv.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>

/* ---- internal helpers ------------------------------------------------ */

/* Minimal JSON integer parser for legacy ADRP records.
 * ADRP format: {"key":int,"key":int,...}
 * Returns the parsed port, or 0 on error. */
static uint16_t json_get_uint16(const char *json, const char *key)
{
    size_t keylen = strlen(key);
    const char *p = json;

    while (*p) {
        p = strchr(p, '"');
        if (!p) return 0;
        p++;
        if (strncmp(p, key, keylen) == 0 && p[keylen] == '"') {
            p += keylen + 1;
            p = strchr(p, ':');
            if (!p) return 0;
            p++;
            while (*p == ' ' || *p == '\t') p++;
            char *end;
            long val = strtol(p, &end, 10);
            if (end == p) return 0;
            if (val < 1 || val > 65535) return 0;
            return (uint16_t)val;
        }
        p++;
    }
    return 0;
}

/* Check if a TXT record is a valid legacy ADRP JSON object. */
static int parse_adrp_txt(const char *txt, KirinPorts *ports)
{
    if (!txt || txt[0] != '{') return 0;

    int found = 0;
    uint16_t v;

    v = json_get_uint16(txt, "http");
    if (v > 0) { ports->http = v; found = 1; }
    v = json_get_uint16(txt, "https");
    if (v > 0) { ports->https = v; found = 1; }
    v = json_get_uint16(txt, "ws");
    if (v > 0) { ports->ws = v; found = 1; }
    v = json_get_uint16(txt, "wss");
    if (v > 0) { ports->wss = v; found = 1; }

    return found;
}

/* Perform a DNS query using res_query().
 * Returns malloc'd buffer with raw response, or NULL on failure.
 * Caller must free(). */
static unsigned char *query_dns(const char *domain, int qtype, int *len)
{
    unsigned char buf[4096];
    int ret = res_query(domain, C_IN, qtype, buf, sizeof(buf));
    if (ret < 0) return NULL;

    unsigned char *copy = malloc((size_t)ret);
    if (!copy) return NULL;
    memcpy(copy, buf, (size_t)ret);
    *len = ret;
    return copy;
}

/* ---- legacy TXT extraction (ADRP JSON) -------------------------------- */

/* Extract TXT strings from a raw DNS response. */
static char *extract_txt_string(const unsigned char *response, int response_len)
{
    ns_msg handle;
    if (ns_initparse(response, response_len, &handle) < 0) return NULL;

    ns_rr rr;
    int count = ns_msg_count(handle, ns_s_an);
    if (count < 1) return NULL;

    for (int i = 0; i < count; i++) {
        if (ns_parserr(&handle, ns_s_an, i, &rr) < 0) continue;
        if (ns_rr_type(rr) != ns_t_txt) continue;

        const unsigned char *rdata = ns_rr_rdata(rr);
        int rdlen = ns_rr_rdlen(rr);
        if (rdlen < 1) continue;

        int txtlen = (int)rdata[0];
        if (txtlen < 1 || txtlen > rdlen - 1) continue;

        char *txt = malloc((size_t)txtlen + 1);
        if (!txt) continue;
        memcpy(txt, rdata + 1, (size_t)txtlen);
        txt[txtlen] = '\0';
        return txt;
    }

    return NULL;
}

/* ---- v2 SRV helpers --------------------------------------------------- */

/* Map service name string to SRV prefix.
 * Returns NULL for unknown services. */
static const char *srv_prefix(const char *service)
{
    if (strcmp(service, "http") == 0)  return "_kirinnet-http._tcp";
    if (strcmp(service, "https") == 0) return "_kirinnet-https._tcp";
    if (strcmp(service, "ws") == 0)    return "_kirinnet-ws._tcp";
    return NULL;
}

/* Parse SRV rdata (RFC 2782):
 *   2 bytes priority
 *   2 bytes weight
 *   2 bytes port
 *   variable-length compressed target name
 *
 * Fills `result` on success. Returns KIRIN_OK or KIRIN_ERR_PARSE.
 * `response` points to the full DNS response buffer (needed for
 * ns_name_uncompress to resolve compression pointers).
 */
static int parse_srv_rdata(const unsigned char *rdata, int rdlen,
                           const unsigned char *response, int response_len,
                           KirinSRVResult *result)
{
    if (rdlen < 7) return KIRIN_ERR_PARSE; /* minimum: priority+weight+port+1 byte name */

    uint16_t priority = (uint16_t)((rdata[0] << 8) | rdata[1]);
    uint16_t weight   = (uint16_t)((rdata[2] << 8) | rdata[3]);
    uint16_t port     = (uint16_t)((rdata[4] << 8) | rdata[5]);

    (void)priority;
    (void)weight;

    /* Uncompress the target domain name */
    char target[KIRIN_MAX_TARGET];
    int expanded = ns_name_uncompress(response,
                                      response + response_len,
                                      rdata + 6,
                                      target,
                                      sizeof(target));
    if (expanded < 0) return KIRIN_ERR_PARSE;

    /* Strip trailing dot if present */
    size_t tlen = strlen(target);
    if (tlen > 0 && target[tlen - 1] == '.') {
        target[tlen - 1] = '\0';
    }

    strncpy(result->target, target, KIRIN_MAX_TARGET - 1);
    result->target[KIRIN_MAX_TARGET - 1] = '\0';
    result->port = port;

    return KIRIN_OK;
}

/* Extract and parse SRV records from a raw DNS response.
 * Returns KIRIN_OK if at least one valid SRV record was found and parsed.
 * Picks the best record per RFC 2782 (lowest priority, then highest weight). */
static int extract_srv(const unsigned char *response, int response_len,
                       KirinSRVResult *result)
{
    ns_msg handle;
    if (ns_initparse(response, response_len, &handle) < 0) return KIRIN_ERR_PARSE;

    ns_rr rr;
    int count = ns_msg_count(handle, ns_s_an);
    if (count < 1) return KIRIN_ERR_DNS;

    /* Collect all SRV records, find best by priority/weight */
    int best_idx = -1;
    uint16_t best_priority = 0xFFFF;
    uint16_t best_weight = 0;

    for (int i = 0; i < count; i++) {
        if (ns_parserr(&handle, ns_s_an, i, &rr) < 0) continue;
        if (ns_rr_type(rr) != ns_t_srv) continue;

        const unsigned char *rdata = ns_rr_rdata(rr);
        int rdlen = ns_rr_rdlen(rr);
        if (rdlen < 7) continue;

        uint16_t priority = (uint16_t)((rdata[0] << 8) | rdata[1]);
        uint16_t weight   = (uint16_t)((rdata[2] << 8) | rdata[3]);

        if (best_idx < 0 ||
            priority < best_priority ||
            (priority == best_priority && weight > best_weight)) {
            best_idx = i;
            best_priority = priority;
            best_weight = weight;
        }
    }

    if (best_idx < 0) return KIRIN_ERR_DNS;

    /* Re-parse the best record to fill the result */
    if (ns_parserr(&handle, ns_s_an, best_idx, &rr) < 0) return KIRIN_ERR_PARSE;
    return parse_srv_rdata(ns_rr_rdata(rr), ns_rr_rdlen(rr),
                           response, response_len, result);
}

/* ---- v2 identity TXT helpers ------------------------------------------ */

/* Extract all TXT strings from a raw DNS response.
 * Returns concatenated strings joined by null separators, or NULL.
 * Caller must free(). */
static char *extract_all_txt(const unsigned char *response, int response_len)
{
    ns_msg handle;
    if (ns_initparse(response, response_len, &handle) < 0) return NULL;

    ns_rr rr;
    int count = ns_msg_count(handle, ns_s_an);
    if (count < 1) return NULL;

    /* First pass: calculate total size needed */
    size_t total = 0;
    int ntxt = 0;
    for (int i = 0; i < count; i++) {
        if (ns_parserr(&handle, ns_s_an, i, &rr) < 0) continue;
        if (ns_rr_type(rr) != ns_t_txt) continue;

        const unsigned char *rdata = ns_rr_rdata(rr);
        int rdlen = ns_rr_rdlen(rr);
        if (rdlen < 1) continue;

        /* TXT can have multiple character-strings */
        int pos = 0;
        while (pos < rdlen) {
            int chunklen = (int)rdata[pos];
            if (chunklen < 1 || pos + 1 + chunklen > rdlen) break;
            total += (size_t)chunklen + 1; /* +1 for null separator */
            ntxt++;
            pos += 1 + chunklen;
        }
    }

    if (ntxt == 0) return NULL;

    char *buf = malloc(total + 1);
    if (!buf) return NULL;

    /* Second pass: copy data */
    size_t off = 0;
    for (int i = 0; i < count; i++) {
        if (ns_parserr(&handle, ns_s_an, i, &rr) < 0) continue;
        if (ns_rr_type(rr) != ns_t_txt) continue;

        const unsigned char *rdata = ns_rr_rdata(rr);
        int rdlen = ns_rr_rdlen(rr);
        int pos = 0;
        while (pos < rdlen) {
            int chunklen = (int)rdata[pos];
            if (chunklen < 1 || pos + 1 + chunklen > rdlen) break;
            memcpy(buf + off, rdata + pos + 1, (size_t)chunklen);
            off += (size_t)chunklen;
            buf[off++] = '\0'; /* null separator between strings */
            pos += 1 + chunklen;
        }
    }
    buf[total] = '\0';

    return buf;
}

/* ---- v2 public API ---------------------------------------------------- */

int kirin_parse_identity_txt(const char *txt, KirinIdentity *identity)
{
    if (!txt || !identity) return KIRIN_ERR_PARSE;

    /* Must start with "id=" */
    if (strncmp(txt, "id=", 3) != 0) return KIRIN_ERR_PARSE;

    /* Initialize result */
    memset(identity, 0, sizeof(*identity));
    identity->ipfs = -1; /* not set */

    /* Make a mutable copy to tokenize */
    char *copy = strdup(txt);
    if (!copy) return KIRIN_ERR_MEMORY;

    int has_id = 0, has_key = 0;
    char *saveptr;
    char *pair = strtok_r(copy, ";", &saveptr);

    while (pair) {
        char *eq = strchr(pair, '=');
        if (eq) {
            *eq = '\0';
            char *key = pair;
            char *val = eq + 1;

            /* Trim leading whitespace from key */
            while (*key == ' ' || *key == '\t') key++;

            /* Trim trailing whitespace from key */
            char *kend = key + strlen(key) - 1;
            while (kend >= key && (*kend == ' ' || *kend == '\t')) {
                *kend = '\0';
                kend--;
            }

            /* Trim whitespace from val */
            while (*val == ' ' || *val == '\t') val++;
            char *vend = val + strlen(val) - 1;
            while (vend >= val && (*vend == ' ' || *vend == '\t')) {
                *vend = '\0';
                vend--;
            }

            if (strcmp(key, "id") == 0 && *val) {
                strncpy(identity->id, val, sizeof(identity->id) - 1);
                identity->id[sizeof(identity->id) - 1] = '\0';
                has_id = 1;
            } else if (strcmp(key, "key") == 0 && *val) {
                strncpy(identity->key, val, sizeof(identity->key) - 1);
                identity->key[sizeof(identity->key) - 1] = '\0';
                has_key = 1;
            } else if (strcmp(key, "nick") == 0 && *val) {
                strncpy(identity->nick, val, sizeof(identity->nick) - 1);
                identity->nick[sizeof(identity->nick) - 1] = '\0';
            } else if (strcmp(key, "ipfs") == 0 && *val) {
                if (strcmp(val, "true") == 0) {
                    identity->ipfs = 1;
                } else if (strcmp(val, "false") == 0) {
                    identity->ipfs = 0;
                }
            }
        }
        pair = strtok_r(NULL, ";", &saveptr);
    }

    free(copy);

    if (!has_id || !has_key) return KIRIN_ERR_PARSE;

    return KIRIN_OK;
}

int kirin_resolve_service(const char *domain, const char *service,
                          KirinSRVResult *result)
{
    if (!domain || !service || !result) return KIRIN_ERR_PARSE;

    const char *prefix = srv_prefix(service);
    if (!prefix) return KIRIN_ERR_PARSE;

    /* Build full SRV name: _kirinnet-http._tcp.domain */
    size_t dlen = strlen(domain);
    size_t plen = strlen(prefix);
    size_t flen = plen + 1 + dlen + 1; /* prefix + '.' + domain + '\0' */
    char *full_name = malloc(flen);
    if (!full_name) return KIRIN_ERR_MEMORY;
    snprintf(full_name, flen, "%s.%s", prefix, domain);

    int response_len = 0;
    unsigned char *response = query_dns(full_name, ns_t_srv, &response_len);
    free(full_name);

    if (!response) return KIRIN_ERR_DNS;

    int err = extract_srv(response, response_len, result);
    free(response);
    return err;
}

int kirin_resolve_all_services(const char *domain,
                               KirinSRVResult results[3],
                               int found[3])
{
    if (!domain || !results || !found) return KIRIN_ERR_PARSE;

    static const char *services[] = {"http", "https", "ws"};

    for (int i = 0; i < 3; i++) {
        int err = kirin_resolve_service(domain, services[i], &results[i]);
        found[i] = (err == KIRIN_OK) ? 1 : 0;
    }

    return KIRIN_OK;
}

int kirin_resolve_identity(const char *domain, KirinIdentity *identity)
{
    if (!domain || !identity) return KIRIN_ERR_PARSE;

    int response_len = 0;
    unsigned char *response = query_dns(domain, ns_t_txt, &response_len);
    if (!response) return KIRIN_ERR_DNS;

    char *all_txt = extract_all_txt(response, response_len);
    free(response);

    if (!all_txt) return KIRIN_ERR_DNS;

    /* Walk through null-separated TXT strings, try each one */
    char *p = all_txt;
    int found = 0;
    while (*p) {
        int err = kirin_parse_identity_txt(p, identity);
        if (err == KIRIN_OK) {
            found = 1;
            break;
        }
        p += strlen(p) + 1;
    }

    free(all_txt);

    return found ? KIRIN_OK : KIRIN_ERR_DNS;
}

/* ---- legacy public API ------------------------------------------------ */

int kirin_resolve(const char *domain, KirinPorts *ports)
{
    return kirin_resolve_with_server(domain, NULL, ports);
}

int kirin_resolve_with_server(const char *domain, const char *dns_server,
                               KirinPorts *ports)
{
    if (!domain || !ports) return KIRIN_ERR_PARSE;

    /* Start with fallback ports */
    ports->http  = KIRIN_HTTP_DEFAULT;
    ports->https = KIRIN_HTTPS_DEFAULT;
    ports->ws    = KIRIN_WS_DEFAULT;
    ports->wss   = KIRIN_WSS_DEFAULT;

    /* Configure resolver if custom server provided */
    if (dns_server) {
        res_init();
        struct in_addr ns;
        if (inet_aton(dns_server, &ns) == 0) {
            return KIRIN_ERR_DNS;
        }
        _res.nscount = 1;
        _res.nsaddr_list[0].sin_addr = ns;
        _res.nsaddr_list[0].sin_family = AF_INET;
        _res.nsaddr_list[0].sin_port = htons(53);
    }

    int response_len = 0;
    unsigned char *response = query_dns(domain, ns_t_txt, &response_len);
    if (!response) return KIRIN_OK;

    char *txt = extract_txt_string(response, response_len);
    free(response);

    if (!txt) return KIRIN_OK;

    parse_adrp_txt(txt, ports);
    free(txt);

    return KIRIN_OK;
}

void kirin_cleanup(void)
{
    res_close();
}

/* ---- self-test (compile with -DTEST) -------------------------------- */
#ifdef TEST_KIRIN_DNS
#include <assert.h>

int main(void)
{
    KirinPorts p;
    KirinSRVResult srv;
    KirinIdentity id;
    int err;

    /* ---- legacy tests ---- */

    /* Test fallback */
    p.http = 0;
    err = kirin_resolve("nonexistent.invalid", &p);
    assert(err == KIRIN_OK);
    assert(p.http  == 80);
    assert(p.https == 443);
    assert(p.ws    == 80);
    assert(p.wss   == 443);

    /* Test JSON parser */
    KirinPorts parsed = {0, 0, 0, 0};
    assert(parse_adrp_txt("{\"http\":8080,\"https\":8443}", &parsed) == 1);
    assert(parsed.http  == 8080);
    assert(parsed.https == 8443);

    /* Invalid */
    assert(parse_adrp_txt("not json", &p) == 0);
    assert(parse_adrp_txt("{}", &p) == 0);
    assert(parse_adrp_txt("{\"http\":0}", &p) == 0);
    assert(parse_adrp_txt("{\"http\":65536}", &p) == 0);

    printf("kirin_dns legacy tests: PASSED\n");

    /* ---- v2 SRV tests ---- */

    /* Non-existent domain should return error */
    err = kirin_resolve_service("nonexistent.invalid", "ws", &srv);
    assert(err == KIRIN_ERR_DNS);

    /* Unknown service */
    err = kirin_resolve_service("example.com", "bogus", &srv);
    assert(err == KIRIN_ERR_PARSE);

    printf("kirin_dns SRV tests: PASSED\n");

    /* ---- v2 identity tests ---- */

    /* Valid full identity */
    err = kirin_parse_identity_txt(
        "id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false",
        &id);
    assert(err == KIRIN_OK);
    assert(strcmp(id.id, "550e8400-e29b-41d4-a716-446655440000") == 0);
    assert(strcmp(id.key, "04abc") == 0);
    assert(strcmp(id.nick, "Alice") == 0);
    assert(id.ipfs == 0);

    /* Minimal identity */
    err = kirin_parse_identity_txt("id=test-id;key=0x00", &id);
    assert(err == KIRIN_OK);
    assert(strcmp(id.id, "test-id") == 0);
    assert(strcmp(id.key, "0x00") == 0);
    assert(id.nick[0] == '\0');
    assert(id.ipfs == -1);

    /* Invalid */
    assert(kirin_parse_identity_txt("not an identity", &id) == KIRIN_ERR_PARSE);
    assert(kirin_parse_identity_txt("v=spf1 include:_spf.example.com", &id) == KIRIN_ERR_PARSE);
    assert(kirin_parse_identity_txt("", &id) == KIRIN_ERR_PARSE);
    assert(kirin_parse_identity_txt(NULL, &id) == KIRIN_ERR_PARSE);

    /* Missing required key */
    assert(kirin_parse_identity_txt("id=foo;nick=Bar", &id) == KIRIN_ERR_PARSE);
    assert(kirin_parse_identity_txt("key=bar;nick=Foo", &id) == KIRIN_ERR_PARSE);

    /* Resolve identity for non-existent domain */
    err = kirin_resolve_identity("nonexistent.invalid", &id);
    assert(err == KIRIN_ERR_DNS);

    printf("kirin_dns identity tests: PASSED\n");

    /* ---- resolve all services ---- */
    KirinSRVResult results[3];
    int found[3];
    err = kirin_resolve_all_services("nonexistent.invalid", results, found);
    assert(err == KIRIN_OK);
    assert(found[0] == 0);
    assert(found[1] == 0);
    assert(found[2] == 0);

    printf("kirin_dns resolve_all_services test: PASSED\n");

    printf("\nkirin_dns C self-test: ALL PASSED\n");
    return 0;
}
#endif
