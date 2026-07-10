/*
 * kirin_dns.h — KirinDNS Resolution Protocol (ADRP) v2.0 C Client Library
 *
 * SRV records for service port discovery (_kirinnet-http._tcp, etc.)
 * TXT records for identity metadata (id=;key=;nick=;ipfs=)
 * Legacy ADRP JSON TXT fallback preserved for backward compatibility.
 *
 * Single-header, no external dependencies beyond libc and libresolv.
 *
 * Usage:
 *   #include "kirin_dns.h"
 *
 *   KirinSRVResult srv;
 *   int err = kirin_resolve_service("example.com", "ws", &srv);
 *   if (err == KIRIN_OK) printf("WS: %s:%u\n", srv.target, srv.port);
 *
 *   KirinIdentity id;
 *   err = kirin_resolve_identity("example.com", &id);
 *   if (err == KIRIN_OK) printf("ID: %s\n", id.id);
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

/* ---- legacy ADRP port struct (backward compatibility) ------------------ */

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

/* ---- v2 SRV result ---------------------------------------------------- */

#define KIRIN_MAX_TARGET 256

typedef struct {
    char   target[KIRIN_MAX_TARGET];  /* target hostname (e.g. "alice.kirinnet.org") */
    uint16_t port;
} KirinSRVResult;

/* ---- v2 identity result ----------------------------------------------- */

typedef struct {
    char id[64];     /* uuid */
    char key[256];   /* hex-encoded public key */
    char nick[128];  /* optional display name */
    int  ipfs;       /* 0 or 1, -1 if not set */
} KirinIdentity;

/* ---- return codes ----------------------------------------------------- */

#define KIRIN_OK              0   /* success (may be fallback ports) */
#define KIRIN_ERR_DNS        -1   /* DNS query failed */
#define KIRIN_ERR_PARSE      -2   /* invalid record format */
#define KIRIN_ERR_MEMORY     -3   /* out of memory */
#define KIRIN_ERR_TIMEOUT    -4   /* DNS timeout */

/* ---- v2 API: Service Resolution (SRV) --------------------------------- */

/*
 * Resolve a single service port via SRV.
 *
 * `domain`  — e.g. "alice.kirinnet.org"
 * `service` — "http", "https", or "ws"
 *
 * Returns KIRIN_OK and fills `result` on success.
 * If no SRV record is found, returns KIRIN_ERR_DNS and leaves `result`
 * untouched (caller should fall back to standard port).
 */
int kirin_resolve_service(const char *domain, const char *service,
                          KirinSRVResult *result);

/*
 * Resolve all SRV services for a domain.
 * `results` must point to an array of 3 KirinSRVResult structs
 * (indexed: 0=http, 1=https, 2=ws).
 * `found` is a 3-element int array filled with 1 (found) or 0 (not found).
 */
int kirin_resolve_all_services(const char *domain,
                               KirinSRVResult results[3],
                               int found[3]);

/* ---- v2 API: Identity Resolution (TXT) -------------------------------- */

/*
 * Parse a semicolon-separated key=value TXT string into an identity struct.
 *
 * Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
 *
 * Returns KIRIN_OK if a valid identity record was parsed.
 * Returns KIRIN_ERR_PARSE if the string is not a valid identity TXT.
 */
int kirin_parse_identity_txt(const char *txt, KirinIdentity *identity);

/*
 * Resolve identity metadata from TXT records.
 *
 * Queries TXT, finds the first record matching the identity format
 * (starts with "id="), and parses it.
 *
 * Returns KIRIN_OK on success, KIRIN_ERR_DNS if no identity TXT found.
 */
int kirin_resolve_identity(const char *domain, KirinIdentity *identity);

/* ---- legacy API (backward compatibility) ------------------------------- */

/*
 * Resolve KirinDNS ports for `domain` using the legacy ADRP JSON TXT method.
 *
 * Queries DNS TXT records, parses the first valid ADRP JSON record,
 * and fills `ports`.  On success returns KIRIN_OK.  If no valid ADRP
 * record is found, `ports` is filled with standard fallback values
 * and KIRIN_OK is still returned.
 *
 * `domain` must be a null-terminated string (e.g. "alice.kirinnet.org").
 */
int kirin_resolve(const char *domain, KirinPorts *ports);

/*
 * Resolve with a custom DNS server (e.g. "8.8.8.8").
 * Otherwise identical to kirin_resolve().
 */
int kirin_resolve_with_server(const char *domain, const char *dns_server,
                              KirinPorts *ports);

/*
 * Free any internally allocated memory from the last call.
 * Called automatically by kirin_resolve, but may be called manually.
 */
void kirin_cleanup(void);

#ifdef __cplusplus
}
#endif

#endif /* KIRIN_DNS_H */
