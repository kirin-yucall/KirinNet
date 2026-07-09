/*
 * kirin_dns.h — KirinDNS Resolution Protocol (ADRP) C Client Library
 *
 * Resolves service port mappings from DNS TXT records.
 * Single-header, no external dependencies beyond libc and libresolv.
 *
 * Usage:
 *   #include "kirin_dns.h"
 *
 *   KirinPorts ports;
 *   int err = kirin_resolve("example.com", &ports);
 *   if (err == 0) printf("HTTP: %u\n", ports.http);
 *
 * Build:
 *   gcc -o myapp myapp.c kirin_dns.c -lresolv
 */

#ifndef KIRIN_DNS_H
#define KIRIN_DNS_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Resolved service ports. All fields always have a value. */
typedef struct {
    uint16_t http;
    uint16_t https;
    uint16_t ws;
    uint16_t wss;
} KirinPorts;

/* Standard IANA fallback ports. */
#define KIRIN_HTTP_DEFAULT   80
#define KIRIN_HTTPS_DEFAULT 443
#define KIRIN_WS_DEFAULT     80
#define KIRIN_WSS_DEFAULT   443

/* Return codes for kirin_resolve(). */
#define KIRIN_OK              0   /* success (may be fallback ports) */
#define KIRIN_ERR_DNS        -1   /* DNS query failed */
#define KIRIN_ERR_PARSE      -2   /* invalid ADRP record format */
#define KIRIN_ERR_MEMORY     -3   /* out of memory */
#define KIRIN_ERR_TIMEOUT    -4   /* DNS timeout */

/*
 * Resolve KirinDNS ports for `domain`.
 *
 * Queries DNS TXT records, parses the first valid ADRP JSON record,
 * and fills `ports`.  On success returns KIRIN_OK.  If no valid ADRP
 * record is found, `ports` is filled with standard fallback values
 * and KIRIN_OK is still returned.
 *
 * `domain` must be a null-terminated string (e.g. "alice.kirinnet.org").
 *
 * Returns a negative error code on failure.
 */
int kirin_resolve(const char *domain, KirinPorts *ports);

/*
 * Resolve with a custom DNS server (e.g. "8.8.8.8").
 * Otherwise identical to kirin_resolve().
 */
int kirin_resolve_with_server(const char *domain, const char *dns_server, KirinPorts *ports);

/*
 * Free any internally allocated memory from the last call.
 * Called automatically by kirin_resolve, but may be called manually.
 */
void kirin_cleanup(void);

#ifdef __cplusplus
}
#endif

#endif /* KIRIN_DNS_H */
