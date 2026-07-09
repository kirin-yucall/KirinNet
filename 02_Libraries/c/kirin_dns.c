/*
 * kirin_dns.c — KirinDNS Resolution Protocol (ADRP) C Implementation
 *
 * Uses res_query() from libresolv for DNS TXT queries.
 * Minimal hand-rolled JSON parser for ADRP records.
 *
 * Build:  gcc -c kirin_dns.c -lresolv
 */

#include "kirin_dns.h"

#include <arpa/inet.h>
#include <arpa/nameser.h>
#include <netinet/in.h>
#include <resolv.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>

/* ---- internal helpers ------------------------------------------------ */

/* Minimal JSON integer parser for ADRP records.
 * ADRP format is extremely constrained: {"key":int,"key":int,...}
 * Returns the parsed port, or 0 on error. */
static uint16_t json_get_uint16(const char *json, const char *key)
{
    /* Search for "key": */
    size_t keylen = strlen(key);
    const char *p = json;

    while (*p) {
        /* Find opening quote */
        p = strchr(p, '"');
        if (!p) return 0;
        p++;
        if (strncmp(p, key, keylen) == 0 && p[keylen] == '"') {
            p += keylen + 1;  /* skip key" */
            /* expect : */
            p = strchr(p, ':');
            if (!p) return 0;
            p++;
            /* skip whitespace */
            while (*p == ' ' || *p == '\t') p++;
            /* parse integer */
            char *end;
            long val = strtol(p, &end, 10);
            if (end == p) return 0;   /* no digits */
            if (val < 1 || val > 65535) return 0;
            return (uint16_t)val;
        }
        p++;
    }
    return 0;
}

/* Check if a TXT record is a valid ADRP JSON object.
 * Returns 1 if valid, 0 otherwise. Sets ports for recognized keys. */
static int parse_adrp_txt(const char *txt, KirinPorts *ports)
{
    /* Quick sanity: must start with { and contain at least one recognized key */
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

/* Perform a DNS TXT query using res_query().
 * Returns malloc'd buffer with raw response, or NULL on failure.
 * Caller must free(). */
static unsigned char *query_txt(const char *domain, int *len)
{
    unsigned char buf[4096];
    int ret = res_query(domain, C_IN, T_TXT, buf, sizeof(buf));
    if (ret < 0) return NULL;

    unsigned char *copy = malloc((size_t)ret);
    if (!copy) return NULL;
    memcpy(copy, buf, (size_t)ret);
    *len = ret;
    return copy;
}

/* Extract TXT strings from a raw DNS response.
 * Returns a newly allocated string (caller frees), or NULL. */
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

        /* TXT format: 1-byte length prefix + string data */
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

/* ---- public API ----------------------------------------------------- */

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
            return KIRIN_ERR_DNS;  /* invalid IP */
        }
        _res.nscount = 1;
        _res.nsaddr_list[0].sin_addr = ns;
        _res.nsaddr_list[0].sin_family = AF_INET;
        _res.nsaddr_list[0].sin_port = htons(53);
    }

    int response_len = 0;
    unsigned char *response = query_txt(domain, &response_len);
    if (!response) return KIRIN_OK;  /* no TXT → fallback is fine */

    char *txt = extract_txt_string(response, response_len);
    free(response);

    if (!txt) return KIRIN_OK;  /* no valid TXT → fallback */

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

    /* Test fallback */
    p.http = 0;
    int err = kirin_resolve("nonexistent.invalid", &p);
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

    printf("kirin_dns C self-test: PASSED\n");
    return 0;
}
#endif
