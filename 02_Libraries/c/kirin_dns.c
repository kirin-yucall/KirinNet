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

/* ======================================================================= */
/* did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)  */
/* ======================================================================= */
/*
 * Pure-C, dependency-free implementation of the tamper-evident fingerprint
 * chain (fp == Base64URL(SHA-256(pk)[0:12])).  SHA-256 is implemented inline
 * (FIPS 180-4) and Base64URL is RFC 4648 §5 (no padding) so the unit test
 * can run without linking a crypto library.
 */

#define DID_DNS_PREFIX        "did:dns:"
#define DID_DNS_DECL_PREFIX   "did:dns:v="
#define DID_DNS_PK_PREFIX     "did:dns:pk;"
#define DID_DNS_BLACK_PREFIX  "did:dns:black;"
#define DID_DNS_KTY_ED25519   "ed25519"
#define DID_DNS_FP_BYTES      12    /* SHA-256[0:12] -> 16 base64url chars */

/* ---- minimal SHA-256 (FIPS 180-4) ------------------------------------- */

typedef struct {
    unsigned int state[8];
    unsigned long long bitlen;
    unsigned char data[64];
    unsigned int datalen;
} sha256_ctx;

static const unsigned int SHA256_K[64] = {
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
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

#define SHA256_ROTR(a,b) (((a) >> (b)) | ((a) << (32 - (b))))

static void sha256_init(sha256_ctx *c) {
    c->datalen = 0; c->bitlen = 0;
    c->state[0]=0x6a09e667; c->state[1]=0xbb67ae85;
    c->state[2]=0x3c6ef372; c->state[3]=0xa54ff53a;
    c->state[4]=0x510e527f; c->state[5]=0x9b05688c;
    c->state[6]=0x1f83d9ab; c->state[7]=0x5be0cd19;
}

static void sha256_transform(sha256_ctx *c, const unsigned char *data) {
    unsigned int a,b,cc,d,e,f,g,h,t1,t2,m[64]; int i,j;
    for (i=0,j=0; i<16; i++, j+=4)
        m[i] = ((unsigned)data[j]<<24)|((unsigned)data[j+1]<<16)|
               ((unsigned)data[j+2]<<8)|((unsigned)data[j+3]);
    for (; i<64; i++) {
        unsigned int s0 = SHA256_ROTR(m[i-15],7)^SHA256_ROTR(m[i-15],18)^(m[i-15]>>3);
        unsigned int s1 = SHA256_ROTR(m[i-2],17)^SHA256_ROTR(m[i-2],19)^(m[i-2]>>10);
        m[i] = m[i-16]+s0+m[i-7]+s1;
    }
    a=c->state[0]; b=c->state[1]; cc=c->state[2]; d=c->state[3];
    e=c->state[4]; f=c->state[5]; g=c->state[6]; h=c->state[7];
    for (i=0; i<64; i++) {
        t1 = h + (SHA256_ROTR(e,6)^SHA256_ROTR(e,11)^SHA256_ROTR(e,25)) +
             ((e&f)^((~e)&g)) + SHA256_K[i] + m[i];
        t2 = (SHA256_ROTR(a,2)^SHA256_ROTR(a,13)^SHA256_ROTR(a,22)) +
             ((a&b)^(a&cc)^(b&cc));
        h=g; g=f; f=e; e=d+t1; d=cc; cc=b; b=a; a=t1+t2;
    }
    c->state[0]+=a; c->state[1]+=b; c->state[2]+=cc; c->state[3]+=d;
    c->state[4]+=e; c->state[5]+=f; c->state[6]+=g; c->state[7]+=h;
}

static void sha256_update(sha256_ctx *c, const unsigned char *data, unsigned int len) {
    for (unsigned int i=0; i<len; i++) {
        c->data[c->datalen++] = data[i];
        if (c->datalen == 64) {
            sha256_transform(c, c->data);
            c->bitlen += 512; c->datalen = 0;
        }
    }
}

static void sha256_final(sha256_ctx *c, unsigned char out[32]) {
    unsigned int i = c->datalen;
    c->data[i++] = 0x80;
    if (i > 56) { while (i<64) c->data[i++]=0; sha256_transform(c,c->data); i=0; }
    while (i<56) c->data[i++]=0;
    c->bitlen += (unsigned long long)c->datalen * 8;
    for (i=0; i<8; i++) c->data[63-i] = (unsigned char)(c->bitlen >> (i*8));
    sha256_transform(c, c->data);
    for (i=0; i<8; i++) {
        out[i*4]   = (c->state[i] >> 24) & 0xff;
        out[i*4+1] = (c->state[i] >> 16) & 0xff;
        out[i*4+2] = (c->state[i] >> 8)  & 0xff;
        out[i*4+3] = c->state[i]         & 0xff;
    }
}

/* ---- Base64URL (RFC 4648 §5, no padding) decoder + encoder ------------- */

static const char B64URL_CHARS[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/* Decode Base64URL (no padding).  Returns decoded length, or -1 on error. */
static int base64url_decode(const char *in, unsigned char *out, int max_out) {
    int rev[256]; for (int i=0; i<256; i++) rev[i] = -1;
    for (int i=0; i<64; i++) rev[(unsigned char)B64URL_CHARS[i]] = i;
    int val=0, valb=-8, olen=0;
    for (const char *p=in; *p; p++) {
        int d = rev[(unsigned char)*p];
        if (d < 0) { if (*p == '=') continue; return -1; }
        val = (val << 6) | d; valb += 6;
        if (valb >= 0) {
            if (olen >= max_out) return -1;
            out[olen++] = (val >> valb) & 0xff; valb -= 8;
        }
    }
    return olen;
}

static void base64url_encode(const unsigned char *in, int len, char *out) {
    int val=0, valb=-6, o=0;
    for (int i=0; i<len; i++) {
        val = (val << 8) | in[i]; valb += 8;
        while (valb >= 0) { out[o++] = B64URL_CHARS[(val >> valb) & 0x3f]; valb -= 6; }
    }
    if (valb > -6) out[o++] = B64URL_CHARS[((val << 8) >> (valb + 8)) & 0x3f];
    out[o] = '\0';
}

/* ---- did:dns helpers --------------------------------------------------- */

static void parse_did_kv(const char *segment, char *out_n, char *out_g,
                         char *out_fp, char *out_iat, char *out_exp,
                         char *out_v, char *out_kty, char *out_pk,
                         char *out_black_fp) {
    /* Parse `k=v;k=v` (already past the `did:dns:` prefix) into named buffers.
       Each out_* is a buffer; only matching keys are written (NUL-terminated). */
    if (!segment) return;
    char *copy = strdup(segment);
    if (!copy) return;
    char *saveptr=NULL, *pair = strtok_r(copy, ";", &saveptr);
    while (pair) {
        char *eq = strchr(pair, '=');
        if (eq) {
            *eq = '\0';
            const char *k = pair, *v = eq+1;
            if      (strcmp(k,"v")==0   && out_v)        { strncpy(out_v,v,15); out_v[15]='\0'; }
            else if (strcmp(k,"fp")==0  && out_fp)       { strncpy(out_fp,v,KIRIN_DID_DNS_FINGERPRINT_LEN); out_fp[KIRIN_DID_DNS_FINGERPRINT_LEN]='\0'; }
            else if (strcmp(k,"n")==0   && out_n)        { strncpy(out_n,v,255); out_n[255]='\0'; }
            else if (strcmp(k,"g")==0   && out_g)        { strncpy(out_g,v,3); out_g[3]='\0'; }
            else if (strcmp(k,"iat")==0 && out_iat)      { strncpy(out_iat,v,15); out_iat[15]='\0'; }
            else if (strcmp(k,"exp")==0 && out_exp)      { strncpy(out_exp,v,15); out_exp[15]='\0'; }
            else if (strcmp(k,"kty")==0 && out_kty)      { strncpy(out_kty,v,15); out_kty[15]='\0'; }
            else if (strcmp(k,"pk")==0  && out_pk)       { strncpy(out_pk,v,255); out_pk[255]='\0'; }
            else if (strcmp(k,"fp")==0  && out_black_fp) { strncpy(out_black_fp,v,511); out_black_fp[511]='\0'; }
        }
        pair = strtok_r(NULL, ";", &saveptr);
    }
    free(copy);
}

int kirin_parse_did_dns_identity(const char *const *txt_records, int count,
                                 KirinDidDnsIdentity *identity) {
    if (!txt_records || !identity) return KIRIN_ERR_PARSE;
    memset(identity, 0, sizeof(*identity));
    const char *decl_raw=NULL, *pk_raw=NULL, *black_raw=NULL;
    for (int i=0; i<count; i++) {
        const char *s = txt_records[i];
        if (!s) continue;
        while (*s==' '||*s=='\t') s++;
        if      (!decl_raw  && strncmp(s, DID_DNS_DECL_PREFIX,  strlen(DID_DNS_DECL_PREFIX))==0)  decl_raw=s;
        else if (!pk_raw    && strncmp(s, DID_DNS_PK_PREFIX,    strlen(DID_DNS_PK_PREFIX))==0)    pk_raw=s;
        else if (!black_raw && strncmp(s, DID_DNS_BLACK_PREFIX, strlen(DID_DNS_BLACK_PREFIX))==0) black_raw=s;
    }
    if (!decl_raw || !pk_raw) return KIRIN_ERR_PARSE;

    char v[16]="", fp[17]="", n[256]="", g[4]="", iat[16]="", exp[16]="";
    parse_did_kv(decl_raw + strlen(DID_DNS_PREFIX), n,g,fp,iat,exp,v, NULL,NULL,NULL);
    identity->version = (unsigned int)strtoul(v[0]?v:"1", NULL, 10);
    strncpy(identity->fingerprint, fp, KIRIN_DID_DNS_FINGERPRINT_LEN);
    identity->fingerprint[KIRIN_DID_DNS_FINGERPRINT_LEN]='\0';
    strncpy(identity->nickname, n, 255); identity->nickname[255]='\0';
    strncpy(identity->gender, g, 3); identity->gender[3]='\0';
    identity->issued_at  = iat[0] ? strtol(iat, NULL, 10) : 0;
    identity->expires_at = exp[0] ? strtol(exp, NULL, 10) : 0;

    char kty[16]="", pk[256]="";
    parse_did_kv(pk_raw + strlen(DID_DNS_PREFIX), NULL,NULL,NULL,NULL,NULL,NULL, kty,pk,NULL);
    strncpy(identity->key_type, kty[0]?kty:DID_DNS_KTY_ED25519, 15); identity->key_type[15]='\0';
    strncpy(identity->public_key_b64url, pk, 255); identity->public_key_b64url[255]='\0';

    if (black_raw) {
        char bfp[512]="";
        parse_did_kv(black_raw + strlen(DID_DNS_PREFIX), NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL, bfp);
        strncpy(identity->blacklist, bfp, 511); identity->blacklist[511]='\0';
    }
    identity->has_decl = 1; identity->has_pk = 1;
    return KIRIN_OK;
}

int kirin_did_dns_compute_fingerprint(const KirinDidDnsIdentity *identity, char *out) {
    if (!identity || !out) return KIRIN_ERR_PARSE;
    unsigned char pk_bytes[512];
    int n = base64url_decode(identity->public_key_b64url, pk_bytes, (int)sizeof(pk_bytes));
    if (n < 0) return KIRIN_ERR_PARSE;
    unsigned char digest[32];
    sha256_ctx c; sha256_init(&c); sha256_update(&c, pk_bytes, (unsigned)n); sha256_final(&c, digest);
    base64url_encode(digest, DID_DNS_FP_BYTES, out);
    return KIRIN_OK;
}

int kirin_did_dns_fingerprint_chain_ok(const KirinDidDnsIdentity *identity) {
    if (!identity || identity->fingerprint[0]=='\0') return 0;
    char got[KIRIN_DID_DNS_FINGERPRINT_LEN + 1];
    if (kirin_did_dns_compute_fingerprint(identity, got) != KIRIN_OK) return 0;
    return strcmp(got, identity->fingerprint) == 0 ? 1 : 0;
}

int kirin_did_dns_is_revoked(const KirinDidDnsIdentity *identity) {
    if (!identity || identity->blacklist[0]=='\0' || identity->fingerprint[0]=='\0') return 0;
    /* blacklist is comma-separated; check if fp is one of the entries */
    char *copy = strdup(identity->blacklist);
    if (!copy) return 0;
    int found = 0;
    char *saveptr=NULL, *tok = strtok_r(copy, ",", &saveptr);
    while (tok) {
        while (*tok==' ') tok++;
        if (strcmp(tok, identity->fingerprint)==0) { found=1; break; }
        tok = strtok_r(NULL, ",", &saveptr);
    }
    free(copy);
    return found;
}

int kirin_did_dns_is_valid(const KirinDidDnsIdentity *identity, long now) {
    if (!identity) return 0;
    if (identity->version != 1) return 0;
    if (strcmp(identity->key_type, DID_DNS_KTY_ED25519) != 0) return 0;
    if (!kirin_did_dns_fingerprint_chain_ok(identity)) return 0;
    if (kirin_did_dns_is_revoked(identity)) return 0;
    if (identity->expires_at != 0 && now >= identity->expires_at) return 0;
    return 1;
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

    /* ---- did:dns three-record identity model (C-1 baseline) ---- */
    /* Deterministic 32-byte key = bytes 0..31 (matches the golden vector). */
    unsigned char pk_bytes[32];
    for (int i = 0; i < 32; i++) pk_bytes[i] = (unsigned char)i;
    char pk_b64[256]; base64url_encode(pk_bytes, 32, pk_b64);
    /* Recompute the expected fingerprint with our own SHA-256. */
    unsigned char dg[32]; sha256_ctx sc; sha256_init(&sc);
    sha256_update(&sc, pk_bytes, 32); sha256_final(&sc, dg);
    char fp_calc[KIRIN_DID_DNS_FINGERPRINT_LEN + 1];
    base64url_encode(dg, DID_DNS_FP_BYTES, fp_calc);

    const long now = 1700000000L;
    char decl[512], pkrec[512], blackrec[128];
    snprintf(decl, sizeof(decl),
        "did:dns:v=1;fp=%s;n=QWxpY2U;g=F;iat=%ld;exp=%ld", fp_calc, now, now+3600);
    snprintf(pkrec, sizeof(pkrec), "did:dns:pk;kty=ed25519;pk=%s", pk_b64);
    snprintf(blackrec, sizeof(blackrec), "did:dns:black;fp=RevokedAaaa,RevokedBbbb");

    const char *recs[4] = { "v=spf1 include:_spf.kirinnet.org -all", decl, pkrec, blackrec };
    KirinDidDnsIdentity did; int derr = kirin_parse_did_dns_identity(recs, 4, &did);
    assert(derr == KIRIN_OK);
    assert(did.version == 1);
    assert(strcmp(did.fingerprint, fp_calc) == 0);
    assert(strcmp(did.key_type, "ed25519") == 0);
    assert(kirin_did_dns_fingerprint_chain_ok(&did) == 1);
    assert(kirin_did_dns_is_valid(&did, now) == 1);
    assert(kirin_did_dns_is_revoked(&did) == 0);

    /* Tampered pk -> chain breaks. */
    unsigned char wrong[32]; memset(wrong, 0xff, 32);
    char wrong_b64[256]; base64url_encode(wrong, 32, wrong_b64);
    char tampered_pk[512]; snprintf(tampered_pk, sizeof(tampered_pk), "did:dns:pk;kty=ed25519;pk=%s", wrong_b64);
    const char *recs_tamper[3] = { recs[0], decl, tampered_pk };
    KirinDidDnsIdentity broken; assert(kirin_parse_did_dns_identity(recs_tamper, 3, &broken) == KIRIN_OK);
    assert(kirin_did_dns_fingerprint_chain_ok(&broken) == 0);

    /* Missing pk -> parse error. */
    assert(kirin_parse_did_dns_identity((const char*[]){decl}, 1, &did) == KIRIN_ERR_PARSE);
    /* No did:dns at all -> parse error (legacy id= must NOT be misclassified). */
    const char *noise[2] = { "v=spf1 -all", "id=foo;key=bar" };
    assert(kirin_parse_did_dns_identity(noise, 2, &did) == KIRIN_ERR_PARSE);
    /* Wrong kty -> invalid. */
    char rsa_pk[512]; snprintf(rsa_pk, sizeof(rsa_pk), "did:dns:pk;kty=rsa;pk=%s", pk_b64);
    const char *recs_rsa[2] = { decl, rsa_pk };
    KirinDidDnsIdentity rsa_id; assert(kirin_parse_did_dns_identity(recs_rsa, 2, &rsa_id) == KIRIN_OK);
    assert(strcmp(rsa_id.key_type, "rsa") == 0);
    assert(kirin_did_dns_is_valid(&rsa_id, now) == 0);

    printf("kirin_dns did:dns tests: PASSED (fingerprint chain)\n");

    printf("\nkirin_dns C self-test: ALL PASSED\n");
    return 0;
}
#endif
