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
}
