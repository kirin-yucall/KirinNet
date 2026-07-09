<?php
/**
 * KirinDNS Resolution Protocol (ADRP) — PHP Client
 *
 * Resolves service port mappings from DNS TXT records.
 * Pure PHP — no external dependencies beyond ext-json and ext-sockets.
 *
 * Usage:
 *   require_once 'kirin_dns.php';
 *   $ports = KirinDNS\resolve('alice.kirinnet.org');
 *   echo "HTTP: {$ports['http']}\n";
 *
 * Requires: PHP 8.0+ (for match, named arguments, str_starts_with)
 */

namespace KirinDNS;

const DEFAULT_HTTP  = 80;
const DEFAULT_HTTPS = 443;
const DEFAULT_WS    = 80;
const DEFAULT_WSS   = 443;

const RECOGNIZED = ['http', 'https', 'ws', 'wss'];

/**
 * Resolve KirinDNS ports for a domain.
 * Returns an associative array with keys http, https, ws, wss.
 * Falls back to standard ports if no valid ADRP record exists.
 */
function resolve(string $domain): array
{
    $ports = [
        'http'  => DEFAULT_HTTP,
        'https' => DEFAULT_HTTPS,
        'ws'    => DEFAULT_WS,
        'wss'   => DEFAULT_WSS,
    ];

    $records = dns_get_record($domain, DNS_TXT);
    if ($records === false || count($records) === 0) {
        return $ports;
    }

    foreach ($records as $record) {
        $txt = $record['txt'] ?? ($record['entries'][0] ?? '');
        $parsed = parseTxt($txt);
        if ($parsed !== null) {
            return $parsed + $ports; // overwrite recognized keys
        }
    }

    return $ports;
}

/**
 * Resolve with a custom DNS server IP.
 */
function resolveWithServer(string $domain, string $dnsServer): array
{
    // PHP's dns_get_record doesn't support custom DNS servers directly.
    // For production, use a raw UDP DNS query.
    $ports = [
        'http'  => DEFAULT_HTTP,
        'https' => DEFAULT_HTTPS,
        'ws'    => DEFAULT_WS,
        'wss'   => DEFAULT_WSS,
    ];

    $raw = rawDnsQuery($domain, $dnsServer);
    if ($raw === null) return $ports;

    $txts = parseRawTxtResponses($raw);
    foreach ($txts as $txt) {
        $parsed = parseTxt($txt);
        if ($parsed !== null) return $parsed + $ports;
    }

    return $ports;
}

/**
 * Parse a TXT record string as ADRP JSON.
 * Returns an array of recognized ports, or null if invalid.
 */
function parseTxt(string $txt): ?array
{
    $txt = trim($txt);
    if ($txt === '' || $txt[0] !== '{') return null;

    try {
        $data = json_decode($txt, true, flags: JSON_THROW_ON_ERROR);
    } catch (\JsonException $e) {
        return null;
    }

    if (!is_array($data) || count($data) === 0) return null;

    $result = [];
    foreach (RECOGNIZED as $key) {
        if (!array_key_exists($key, $data)) continue;
        $val = $data[$key];
        if (!is_int($val) && !(is_string($val) && ctype_digit($val))) return null;
        $val = (int) $val;
        if ($val < 1 || $val > 65535) return null;
        $result[$key] = $val;
    }

    return count($result) > 0 ? $result : null;
}

// ---- internal raw DNS query helpers -----------------------------------

function rawDnsQuery(string $domain, string $dnsServer): ?string
{
    $query = buildDnsQuery($domain);
    $socket = @fsockopen("udp://$dnsServer", 53, $errno, $errstr, 3);
    if (!$socket) return null;

    fwrite($socket, $query);
    stream_set_timeout($socket, 3);
    $response = fread($socket, 4096);
    fclose($socket);

    return $response !== false ? $response : null;
}

function buildDnsQuery(string $domain): string
{
    $id = pack('n', random_int(0, 65535));
    $flags = pack('n', 0x0100); // standard query, recursion desired
    $qdcount = pack('n', 1);
    $header = $id . $flags . $qdcount . pack('n', 0) . pack('n', 0) . pack('n', 0);

    $question = '';
    foreach (explode('.', $domain) as $label) {
        $question .= chr(strlen($label)) . $label;
    }
    $question .= "\x00";            // null terminator
    $question .= pack('n', 16);     // QTYPE=TXT
    $question .= pack('n', 1);      // QCLASS=IN

    return $header . $question;
}

function parseRawTxtResponses(string $raw): array
{
    if (strlen($raw) < 12) return [];
    $ancount = unpack('n', $raw[6] . $raw[7])[1];
    if ($ancount === 0) return [];

    $pos = 12;
    // Skip question
    while ($pos < strlen($raw) && ord($raw[$pos]) !== 0) {
        $pos += ord($raw[$pos]) + 1;
    }
    $pos += 5; // null + QTYPE + QCLASS

    $results = [];
    for ($i = 0; $i < $ancount && $pos < strlen($raw); $i++) {
        // Skip NAME (handle compression)
        if ((ord($raw[$pos]) & 0xC0) === 0xC0) $pos += 2;
        else {
            while ($pos < strlen($raw) && ord($raw[$pos]) !== 0) $pos += ord($raw[$pos]) + 1;
            $pos++;
        }
        if ($pos + 10 > strlen($raw)) break;
        $rtype = unpack('n', substr($raw, $pos, 2))[1];
        $pos += 8; // TYPE(2) + CLASS(2) + TTL(4)
        $rdlen = unpack('n', substr($raw, $pos, 2))[1];
        $pos += 2;
        if ($rtype === 16 && $rdlen > 1) { // TXT
            $txtlen = ord($raw[$pos]);
            $pos++;
            $results[] = substr($raw, $pos, min($txtlen, $rdlen - 1));
            $pos += $rdlen - 1;
        } else {
            $pos += $rdlen;
        }
    }
    return $results;
}

// ---- self-test (run: php kirin_dns.php) ----------------------------------
if (basename(__FILE__) === basename($_SERVER['SCRIPT_FILENAME'] ?? '')) {
    assert(($p = parseTxt('{"http":8080,"https":8443}')) !== null);
    assert($p['http'] === 8080);
    assert($p['https'] === 8443);

    assert(parseTxt('{}') === null);
    assert(parseTxt('{"http":0}') === null);
    assert(parseTxt('not json') === null);

    $ports = resolve('nonexistent.invalid');
    assert($ports['http'] === 80);
    assert($ports['https'] === 443);

    echo "KirinDNS PHP self-test: PASSED\n";
}
