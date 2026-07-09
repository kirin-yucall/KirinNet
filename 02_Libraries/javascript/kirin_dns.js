/**
 * KirinDNS Resolution Protocol (ADRP) — Node.js Client Library
 *
 * Implements ADRP as defined in 01_Standard/spec_v1.md.
 *
 * Resolution algorithm:
 *   1. Query TXT records for the target domain using dns.resolveTxt().
 *   2. Iterate through each TXT record; attempt to parse as JSON.
 *   3. The first record that parses as valid JSON and contains at least one
 *      recognized key (http, https, ws, wss) is the ADRP response.
 *   4. If no valid ADRP record is found, return the standard fallback ports.
 *
 * NOTE ON BROWSER USAGE:
 *   Browsers cannot directly query DNS TXT records. This library is intended
 *   for Node.js (server-side) use. For browser-based ADRP resolution, use the
 *   Service Worker approach described in Phase 3 (Browser Extension), which
 *   proxies TXT queries through a DoH (DNS-over-HTTPS) endpoint.
 *
 * NOTE ON SECURITY:
 *   Node.js's built-in dns module uses unencrypted DNS by default. For
 *   production ADRP queries, configure a DoH/DoT resolver in front of this
 *   library, or use a library like 'native-dns' with DoT support.
 *   See 01_Standard/spec_v1.md Section 4.3 for the security requirements.
 *
 * Example usage:
 *   const { resolve_kirin_dns } = require('./kirin_dns');
 *
 *   (async () => {
 *     const ports = await resolve_kirin_dns('example.com');
 *     console.log(ports);
 *     // => { http: 80, https: 8443 }  (if ADRP record exists)
 *     // => { http: 80, https: 443 }   (fallback)
 *   })();
 */

const dns = require('dns');

// Recognized ADRP keys (spec Section 3.1.1)
const RECOGNIZED_KEYS = new Set(['http', 'https', 'ws', 'wss']);

// Fallback ports (spec Section 3.2, Step 5)
const FALLBACK_PORTS = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
};

/**
 * Validate an ADRP JSON payload against the spec (Section 3.1).
 *
 * Rules:
 *   - All values for recognized keys MUST be integers in the range 1-65535.
 *   - At least one recognized key MUST be present.
 *   - Unknown keys are silently ignored.
 *
 * @param {object} data - Parsed JSON object to validate.
 * @returns {boolean} True if the record is a valid ADRP record.
 */
function validateKirinDnsRecord(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false;
  }

  let recognizedKeyPresent = false;

  for (const [key, value] of Object.entries(data)) {
    if (RECOGNIZED_KEYS.has(key)) {
      recognizedKeyPresent = true;
      // Must be an integer in range 1-65535
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return false;
      }
    }
  }

  return recognizedKeyPresent;
}

/**
 * Parse a single TXT record string as JSON and validate it as an ADRP record.
 *
 * The spec (Section 3.1.1) requires the JSON object to be the sole content
 * of the TXT character string.
 *
 * @param {string} text - The TXT record string.
 * @returns {object|null} Parsed ADRP record, or null if not valid.
 */
function parseTxtValue(text) {
  const trimmed = text.trim();

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // Not valid JSON — skip this record
  }

  if (validateKirinDnsRecord(parsed)) {
    return parsed;
  }
  return null; // Valid JSON but not a valid ADRP record
}

/**
 * Resolve the KirinDNS ports for a given domain.
 *
 * Returns a Promise that resolves to an object mapping protocol keys to
 * port numbers. If the domain has no valid ADRP TXT record, the standard
 * fallback ports are returned.
 *
 * @param {string} domain - The domain name to query.
 * @returns {Promise<object>} Port mapping object.
 */
async function resolve_kirin_dns(domain) {
  // Start with full fallback; recognized keys will be overwritten if found.
  const result = { ...FALLBACK_PORTS };

  let txtRecords;
  try {
    txtRecords = await dns.resolveTxt(domain);
  } catch (err) {
    // ENOTFOUND (domain does not exist), ENODATA (no TXT records),
    // or other DNS errors — fall back to defaults.
    return result;
  }

  // Aggregate and parse (spec Section 3.1.2, "first valid" rule)
  for (const record of txtRecords) {
    // dns.resolveTxt() returns an array of arrays of strings.
    // Each inner array is a single TXT record that may be split across
    // multiple strings; join them to reconstruct the full value.
    const txtValue = record.join('');
    const parsed = parseTxtValue(txtValue);

    if (parsed !== null) {
      // Found the first valid ADRP record.
      // Overwrite only the keys present in the record; missing keys
      // retain their fallback values.
      Object.assign(result, parsed);
      return result;
    }
  }

  // No valid ADRP record found — return fallback.
  return result;
}

module.exports = { resolve_kirin_dns };

// ---------------------------------------------------------------------------
// Self-test (run with: node aura_dns.js)
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    // Example: query a real domain (will likely return fallback ports)
    const testDomain = 'example.com';
    const ports = await resolve_kirin_dns(testDomain);
    console.log(`ADRP query for ${testDomain}:`, ports);

    // Example: NXDOMAIN should return fallback
    const fallback = await resolve_kirin_dns('nonexistent.invalid');
    console.log(`ADRP query for nonexistent.invalid:`, fallback);

    // Internal unit tests
    console.assert(validateKirinDnsRecord({ http: 8080, https: 8443 }) === true, 'valid record');
    console.assert(validateKirinDnsRecord({ https: 443 }) === true, 'single key');
    console.assert(validateKirinDnsRecord({ ws: 0 }) === false, 'port out of range (0)');
    console.assert(validateKirinDnsRecord({ ws: 65536 }) === false, 'port out of range (65536)');
    console.assert(validateKirinDnsRecord({ ws: '80' }) === false, 'port not an integer');
    console.assert(validateKirinDnsRecord({ unknown: 80 }) === false, 'no recognized key');
    console.assert(validateKirinDnsRecord({}) === false, 'empty object');
    console.assert(validateKirinDnsRecord('not an object') === false, 'wrong type');
    console.assert(validateKirinDnsRecord(null) === false, 'null');
    console.assert(validateKirinDnsRecord([1, 2]) === false, 'array');
    console.log('Internal unit tests passed.');
  })();
}
