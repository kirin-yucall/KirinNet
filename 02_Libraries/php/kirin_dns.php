<?php
/**
 * KirinDNS Resolution Protocol (ADRP) v2.0 — PHP Client Library
 *
 * Implements ADRP as defined in 01_Standard/spec_v1.md.
 *
 * Architecture:
 *   SRV records for service port discovery (_kirinnet-http._tcp, etc.)
 *   TXT records for identity metadata (id=;key=;nick=;ipfs=)
 *
 * Requires: PHP 8.0+
 */

namespace KirinDNS;

// ---------------------------------------------------------------------------
// Constants (spec Section 2.2)
// ---------------------------------------------------------------------------

const SRV_SERVICES = [
    'http'  => '_kirinnet-http._tcp',
    'https' => '_kirinnet-https._tcp',
    'ws'    => '_kirinnet-ws._tcp',
];

const FALLBACK_PORTS = [
    'http'  => 80,
    'https' => 443,
    'ws'    => 80,
    'wss'   => 443,
];

// ---------------------------------------------------------------------------
// Service Resolution (SRV)
// ---------------------------------------------------------------------------

/**
 * Resolve a single service port via SRV.
 *
 * @return array{target: string, port: int}|null
 */
function resolveService(string $domain, string $service): ?array
{
    $srvName = SRV_SERVICES[$service] ?? null;
    if ($srvName === null) {
        throw new \InvalidArgumentException(
            "Unknown service: $service. Recognized: http, https, ws"
        );
    }

    $fullName = "{$srvName}.{$domain}";
    $records = @dns_get_record($fullName, DNS_SRV);
    if ($records === false || count($records) === 0) {
        return null;
    }

    // RFC 2782: lowest priority, then highest weight
    usort($records, function (array $a, array $b): int {
        if ($a['pri'] !== $b['pri']) return $a['pri'] - $b['pri'];
        return $b['weight'] - $a['weight'];
    });

    $best = $records[0];
    return [
        'target' => rtrim($best['target'], '.'),
        'port'   => $best['port'],
    ];
}

/**
 * Resolve all SRV services for a domain.
 *
 * @return array{http: ?array, https: ?array, ws: ?array}
 */
function resolveAllServices(string $domain): array
{
    return [
        'http'  => resolveService($domain, 'http'),
        'https' => resolveService($domain, 'https'),
        'ws'    => resolveService($domain, 'ws'),
    ];
}

// ---------------------------------------------------------------------------
// Identity Resolution (TXT)
// ---------------------------------------------------------------------------

/**
 * Parse a semicolon-separated key=value TXT string into an identity array.
 *
 * Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
 * (spec Section 3.2)
 *
 * @return array{id: string, key: string, nick?: string, ipfs?: bool}|null
 */
function parseIdentityTxt(string $txt): ?array
{
    $txt = trim($txt);
    if ($txt === '' || !str_starts_with($txt, 'id=')) {
        return null;
    }

    $result = [];
    foreach (explode(';', $txt) as $pair) {
        $eq = strpos($pair, '=');
        if ($eq === false) continue;
        $key = trim(substr($pair, 0, $eq));
        $val = trim(substr($pair, $eq + 1));
        $result[$key] = $val;
    }

    // Both id and key are required
    if (!isset($result['id']) || !isset($result['key'])) {
        return null;
    }

    // Parse ipfs boolean
    if (isset($result['ipfs'])) {
        $result['ipfs'] = ($result['ipfs'] === 'true');
    }

    return $result;
}

/**
 * Resolve identity metadata from TXT record.
 *
 * @return array{id: string, key: string, nick?: string, ipfs?: bool}|null
 */
function resolveIdentity(string $domain): ?array
{
    $records = @dns_get_record($domain, DNS_TXT);
    if ($records === false || count($records) === 0) {
        return null;
    }

    foreach ($records as $record) {
        $txt = $record['txt'] ?? ($record['entries'][0] ?? '');
        $identity = parseIdentityTxt($txt);
        if ($identity !== null) {
            return $identity;
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)
// ---------------------------------------------------------------------------
//
// Tamper-evident fingerprint chain: fp == Base64URL(SHA-256(pk)[0:12]).
// Uses PHP's built-in hash() (SHA-256) and a base64url wrapper.

const DID_DNS_PREFIX       = 'did:dns:';
const DID_DNS_DECL_PREFIX  = 'did:dns:v=';
const DID_DNS_PK_PREFIX    = 'did:dns:pk;';
const DID_DNS_BLACK_PREFIX = 'did:dns:black;';
const DID_DNS_KTY_ED25519  = 'ed25519';
const DID_DNS_FINGERPRINT_BYTES = 12;  // -> 16 base64url chars

/** Base64URL encode (RFC 4648 §5, no padding). */
function base64urlEncode(string $binary): string
{
    return rtrim(strtr(base64_encode($binary), '+/', '-_'), '=');
}

/** Base64URL decode (no padding). Returns the raw binary, or null on error. */
function base64urlDecode(string $s): ?string
{
    $pad = strlen($s) % 4;
    if ($pad > 0) {
        $s .= str_repeat('=', 4 - $pad);
    }
    $decoded = base64_decode(strtr($s, '-_', '+/'), true);
    return $decoded === false ? null : $decoded;
}

/**
 * A parsed did:dns identity (declaration + public key, optional blacklist).
 * Returned as an associative array; the tamper-evident fingerprint chain is
 * checked by fingerprintChainOk(), and the caller applies trust policy via
 * isValid() (fail-closed default).
 */
function newDidDnsIdentity(): array
{
    return [
        'version'          => 1,
        'fingerprint'      => '',
        'nickname'         => '',      // Base64URL(UTF-8)
        'gender'           => '',      // M/F/O/X
        'issued_at'        => 0,
        'expires_at'       => 0,
        'key_type'         => DID_DNS_KTY_ED25519,
        'public_key_b64url'=> '',
        'blacklist'        => [],
    ];
}

/** Recompute fp = Base64URL(SHA-256(pk)[0:12]). Empty string on malformed pk. */
function computeFingerprint(array $id): string
{
    $pk = base64urlDecode($id['public_key_b64url'] ?? '');
    if ($pk === null || $pk === '') {
        return '';
    }
    $digest = hash('sha256', $pk, binary: true);
    return base64urlEncode(substr($digest, 0, DID_DNS_FINGERPRINT_BYTES));
}

/** True iff declared fp matches recomputed fp over the pk bytes. */
function fingerprintChainOk(array $id): bool
{
    return $id['fingerprint'] !== '' && $id['fingerprint'] === computeFingerprint($id);
}

function isRevoked(array $id): bool
{
    return in_array($id['fingerprint'], $id['blacklist'], true);
}

function isExpired(array $id, int $now): bool
{
    return $id['expires_at'] !== 0 && $now >= $id['expires_at'];
}

/** Composite policy: v1 + ed25519 + chain + not revoked + not expired. */
function isValid(array $id, int $now): bool
{
    return $id['version'] === 1
        && $id['key_type'] === DID_DNS_KTY_ED25519
        && fingerprintChainOk($id)
        && !isRevoked($id)
        && !isExpired($id, $now);
}

/** Parse a `k=v;k=v` segment (after the did:dns: prefix) into an assoc array. */
function parseDidDnsKv(string $segment): array
{
    $out = [];
    foreach (explode(';', $segment) as $pair) {
        $eq = strpos($pair, '=');
        if ($eq === false) {
            continue;
        }
        $k = trim(substr($pair, 0, $eq));
        $v = trim(substr($pair, $eq + 1));
        $out[$k] = $v;
    }
    return $out;
}

/**
 * Classify TXT records by did:dns: sub-type; assemble an identity.
 *
 * @param array<int,string> $txtRecords
 * @return array|null  null if no did:dns records / declaration+pk missing.
 */
function parseDidDnsIdentity(array $txtRecords): ?array
{
    $declRaw = $pkRaw = $blackRaw = null;
    foreach ($txtRecords as $raw) {
        $s = trim((string) $raw);
        if ($declRaw === null && str_starts_with($s, DID_DNS_DECL_PREFIX)) {
            $declRaw = $s;
        } elseif ($pkRaw === null && str_starts_with($s, DID_DNS_PK_PREFIX)) {
            $pkRaw = $s;
        } elseif ($blackRaw === null && str_starts_with($s, DID_DNS_BLACK_PREFIX)) {
            $blackRaw = $s;
        }
    }
    if ($declRaw === null || $pkRaw === null) {
        return null;
    }

    $decl = parseDidDnsKv(substr($declRaw, strlen(DID_DNS_PREFIX)));
    $pk   = parseDidDnsKv(substr($pkRaw, strlen(DID_DNS_PREFIX)));

    $id = newDidDnsIdentity();
    $id['version']           = isset($decl['v']) ? (int)$decl['v'] : 1;
    $id['fingerprint']       = $decl['fp'] ?? '';
    $id['nickname']          = $decl['n'] ?? '';
    $id['gender']            = $decl['g'] ?? '';
    $id['issued_at']         = isset($decl['iat']) ? (int)$decl['iat'] : 0;
    $id['expires_at']        = isset($decl['exp']) ? (int)$decl['exp'] : 0;
    $id['key_type']          = $pk['kty'] ?? DID_DNS_KTY_ED25519;
    $id['public_key_b64url'] = $pk['pk'] ?? '';

    if ($blackRaw !== null) {
        $bkv = parseDidDnsKv(substr($blackRaw, strlen(DID_DNS_PREFIX)));
        $fpField = $bkv['fp'] ?? '';
        $id['blacklist'] = array_values(array_filter(explode(',', $fpField), fn ($f) => $f !== ''));
    }
    return $id;
}

// ---------------------------------------------------------------------------
// Legacy Compatibility Wrapper
// ---------------------------------------------------------------------------

/**
 * Full resolution: SRV + TXT + identity (legacy wrapper).
 *
 * New code should use resolveService() and resolveIdentity() directly.
 */
function resolve_kirin_dns(string $domain): array
{
    $ws = resolveService($domain, 'ws');

    return [
        'domain'   => $domain,
        'ws'       => $ws ?? ['target' => $domain, 'port' => FALLBACK_PORTS['ws']],
        'http'     => resolveService($domain, 'http'),
        'https'    => resolveService($domain, 'https'),
        'identity' => resolveIdentity($domain),
    ];
}

// ---------------------------------------------------------------------------
// Self-test (run: php kirin_dns.php)
// ---------------------------------------------------------------------------
if (basename(__FILE__) === basename($_SERVER['SCRIPT_FILENAME'] ?? '')) {
    // SRV — nonexistent domain returns null
    $ws = resolveService('nonexistent.invalid', 'ws');
    assert($ws === null, 'no SRV for nonexistent domain');

    // TXT identity — nonexistent domain returns null
    $id = resolveIdentity('nonexistent.invalid');
    assert($id === null, 'no TXT identity for nonexistent domain');

    // Identity parser
    $parsed = parseIdentityTxt(
        'id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false'
    );
    assert($parsed['id']   === '550e8400-e29b-41d4-a716-446655440000', 'id parsed');
    assert($parsed['key']  === '04abc', 'key parsed');
    assert($parsed['nick'] === 'Alice', 'nick parsed');
    assert($parsed['ipfs'] === false, 'ipfs parsed as bool');

    $minimal = parseIdentityTxt('id=test-id;key=0x00');
    assert($minimal['id']  === 'test-id', 'minimal id');
    assert($minimal['key'] === '0x00', 'minimal key');
    assert(!isset($minimal['nick']), 'no nick');

    // Invalid TXT
    assert(parseIdentityTxt('v=spf1 include:_spf.example.com') === null, 'spf skipped');
    assert(parseIdentityTxt('') === null, 'empty string');
    assert(parseIdentityTxt('not an identity') === null, 'not identity');

    // Legacy wrapper
    $full = resolve_kirin_dns('nonexistent.invalid');
    assert($full['ws']['port'] === 80, 'legacy ws fallback');
    assert($full['http'] === null, 'legacy http null');
    assert($full['identity'] === null, 'legacy identity null');

    echo "KirinDNS PHP self-test: PASSED\n";

    // ---- did:dns three-record identity model (C-1 baseline) ----
    // Deterministic 32-byte key = bytes 0..31 (matches the golden vector).
    $pkBytes = pack('C*', ...range(0, 31));
    $pkB64 = base64urlEncode($pkBytes);
    $dg = hash('sha256', $pkBytes, binary: true);
    $fpCalc = base64urlEncode(substr($dg, 0, DID_DNS_FINGERPRINT_BYTES));
    $now = 1700000000;

    $recs = [
        'v=spf1 include:_spf.kirinnet.org -all',
        "did:dns:v=1;fp={$fpCalc};n=QWxpY2U;g=F;iat={$now};exp=" . ($now + 3600),
        "did:dns:pk;kty=ed25519;pk={$pkB64}",
        'did:dns:black;fp=RevokedAaaa,RevokedBbbb',
    ];
    $did = parseDidDnsIdentity($recs);
    assert($did !== null, 'did:dns identity parsed');
    assert($did['version'] === 1, 'did:dns version');
    assert($did['fingerprint'] === $fpCalc, 'did:dns fp');
    assert($did['key_type'] === 'ed25519', 'did:dns kty');
    assert(fingerprintChainOk($did), 'did:dns fingerprint chain');
    assert(isValid($did, $now), 'did:dns valid');
    assert(!isRevoked($did), 'did:dns not revoked');

    // Tampered pk -> chain breaks
    $wrongB64 = base64urlEncode(str_repeat("\xff", 32));
    $tampered = [$recs[0], $recs[1], "did:dns:pk;kty=ed25519;pk={$wrongB64}"];
    $broken = parseDidDnsIdentity($tampered);
    assert(!fingerprintChainOk($broken), 'tampered pk breaks chain');

    // Missing pk -> null
    assert(parseDidDnsIdentity([$recs[1]]) === null, 'missing pk -> null');
    // No did:dns -> null (legacy id= ignored)
    assert(parseDidDnsIdentity(['v=spf1 -all', 'id=foo;key=bar']) === null, 'no did:dns -> null');
    // Wrong kty -> invalid
    $rsaId = parseDidDnsIdentity([$recs[1], "did:dns:pk;kty=rsa;pk={$pkB64}"]);
    assert($rsaId['key_type'] === 'rsa' && !isValid($rsaId, $now), 'rsa kty rejected');

    echo "KirinDNS PHP did:dns self-test: PASSED (fingerprint chain)\n";
}
