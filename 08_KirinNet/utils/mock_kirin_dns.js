/**
 * mock_aura_dns.js — Mock KirinDNS Resolution for Local Development
 *
 * Simulates KirinDNS resolution without a real DNS server.
 * Protocol: SRV records for service discovery, TXT for identity metadata.
 *
 * Matches KirinDNS Automation Standard v2.0 (§5).
 *
 * Usage:
 *   const { resolveService, resolveIdentity } = require('./mock_aura_dns');
 *   const ws = await resolveService('alice.kirinnet.org', 'ws');
 *   // => { target: 'alice.kirinnet.org', port: 8082 }
 *   const identity = await resolveIdentity('alice.kirinnet.org');
 *   // => { id: '550e8400-...', key: '0x04abc...', nick: 'Alice' }
 */

// ---------------------------------------------------------------------------
// SRV Record Definitions (§2)
// ---------------------------------------------------------------------------
const SRV_SERVICES = {
  'ws':    '_kirinnet-ws._tcp',
  'http':  '_kirinnet-http._tcp',
  'https': '_kirinnet-https._tcp',
};

// Mock SRV records: domain → { ws: port, http: port, https: port }
const MOCK_SRV_RECORDS = {
  'alice.kirinnet.org': { ws: 8082, http: 8080, https: 8443 },
  'bob.kirinnet.org':   { ws: 8082, http: 9090, https: 9443 },
  'carol.kirinnet.org': { ws: 8082, http: 3000, https: 3443 },
  'dave.kirinnet.org':  { ws: 8082, http: 8080, https: 8443 },
};

// Mock TXT records (§3): domain → identity metadata
const MOCK_TXT_RECORDS = {
  'alice.kirinnet.org': {
    id:   '550e8400-e29b-41d4-a716-446655440000',
    key:  '0x04a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    nick: 'Alice',
    ipfs: false,
  },
  'bob.kirinnet.org': {
    id:   '660e8400-e29b-41d4-a716-446655440001',
    key:  '0x04b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7',
    nick: 'Bob',
    ipfs: true,
  },
  'carol.kirinnet.org': {
    id:   '770e8400-e29b-41d4-a716-446655440002',
    key:  '0x04c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
    nick: 'Carol',
  },
  'dave.kirinnet.org': {
    id:   '880e8400-e29b-41d4-a716-446655440003',
    key:  '0x04d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9',
    nick: 'Dave',
  },
};

// Default fallback for unknown domains
const FALLBACK_SRV = { ws: 8082, http: 8080 };

// ---------------------------------------------------------------------------
// Simulate DNS latency
// ---------------------------------------------------------------------------
async function latency() {
  const ms = Math.floor(Math.random() * 40) + 10;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Resolve a single service port via SRV
//
// @param {string} domain  - e.g., 'alice.kirinnet.org'
// @param {string} service - 'ws', 'http', or 'https'
// @returns {Promise<{target: string, port: number}|null>}
// ---------------------------------------------------------------------------
async function resolveService(domain, service) {
  await latency();

  const srv = MOCK_SRV_RECORDS[domain];
  const port = srv ? srv[service] : (FALLBACK_SRV[service] || null);

  if (!port) return null;

  return { target: domain, port };
}

// ---------------------------------------------------------------------------
// Resolve all SRV services for a domain
//
// @param {string} domain
// @returns {Promise<object>}  e.g., { ws: 8082, http: 8080, https: 8443 }
// ---------------------------------------------------------------------------
async function resolveAllServices(domain) {
  await latency();

  const srv = MOCK_SRV_RECORDS[domain];
  if (srv) return { ...srv };
  return { ...FALLBACK_SRV };
}

// ---------------------------------------------------------------------------
// Resolve identity metadata from TXT record
//
// @param {string} domain
// @returns {Promise<{id: string, key: string, nick?: string, ipfs?: boolean}|null>}
// ---------------------------------------------------------------------------
async function resolveIdentity(domain) {
  await latency();

  const record = MOCK_TXT_RECORDS[domain];
  if (!record) return null;

  return { ...record };
}

// ---------------------------------------------------------------------------
// Full resolution: SRV + TXT + identity
// (Backward-compatible wrapper, maintained for existing callers)
//
// @param {string} domain
// @returns {Promise<object>}
//   { srv: {target, port}, identity: {id, key, nick} }
// ---------------------------------------------------------------------------
async function mockResolveKirinDNS(domain) {
  const [wsSrv, identity, allSrv] = await Promise.all([
    resolveService(domain, 'ws'),
    resolveIdentity(domain),
    resolveAllServices(domain),
  ]);

  return {
    domain,
    ws: wsSrv || { target: domain, port: FALLBACK_SRV.ws },
    http: allSrv.http || FALLBACK_SRV.http,
    https: allSrv.https || null,
    identity: identity || null,
  };
}

// ---------------------------------------------------------------------------
// Parse a raw TXT record string into key-value pairs (§5.3)
// ---------------------------------------------------------------------------
function parseTxtRecord(raw) {
  const result = {};
  if (!raw) return result;
  raw.split(';').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    const key = pair.substring(0, eq).trim();
    const val = pair.substring(eq + 1).trim();
    result[key] = val;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Format identity into TXT record format (§3.1)
// ---------------------------------------------------------------------------
function formatTxtRecord(txt) {
  const parts = [`id=${txt.id}`, `key=${txt.key}`];
  if (txt.nick) parts.push(`nick=${txt.nick}`);
  if (txt.ipfs === true) parts.push('ipfs=true');
  return parts.join(';');
}

// ---------------------------------------------------------------------------
// Dynamic record management (for testing)
// ---------------------------------------------------------------------------
function addMockSrv(domain, ports) {
  MOCK_SRV_RECORDS[domain] = ports;
}

function addMockTxt(domain, identity) {
  MOCK_TXT_RECORDS[domain] = identity;
}

function removeMockRecord(domain) {
  delete MOCK_SRV_RECORDS[domain];
  delete MOCK_TXT_RECORDS[domain];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // New API (preferred)
  resolveService,
  resolveAllServices,
  resolveIdentity,
  // Legacy wrapper
  mockResolveKirinDNS,
  // Utilities
  parseTxtRecord,
  formatTxtRecord,
  // Test helpers
  addMockSrv,
  addMockTxt,
  addMockRecord: (domain, record) => {
    // Backward compat: accept old v1 format
    if (record.http || record.ws) {
      addMockSrv(domain, { ws: record.ws || 8082, http: record.http || 8080 });
    }
    if (record.id || record.key) {
      addMockTxt(domain, {
        id: record.id || 'mock-id',
        key: record.key || '0x00',
        nick: record.nick || record.nickname,
        ipfs: record.ipfs_gateway || false,
      });
    }
  },
  removeMockRecord,
  // Raw data (for inspection)
  MOCK_SRV_RECORDS,
  MOCK_TXT_RECORDS,
  SRV_SERVICES,
};

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log('=== Mock KirinDNS SRV Resolution Test ===\n');

    // Test SRV resolution
    for (const domain of ['alice.kirinnet.org', 'bob.kirinnet.org', 'unknown.kirinnet.org']) {
      const ws = await resolveService(domain, 'ws');
      const identity = await resolveIdentity(domain);
      console.log(`${domain}:`);
      console.log(`  WS port: ${ws ? ws.port : 'N/A'}`);
      console.log(`  Identity: ${identity ? `${identity.nick} (${identity.id})` : 'N/A'}`);
    }

    console.log('\n=== Legacy Compatibility Test ===\n');
    const full = await mockResolveKirinDNS('alice.kirinnet.org');
    console.log(JSON.stringify(full, null, 2));

    console.log('\n=== TXT Formatting Test ===\n');
    const txt = { id: 'test-id', key: '0x04abc', nick: 'TestUser', ipfs: true };
    console.log('Formatted:', formatTxtRecord(txt));
    console.log('Parsed:', parseTxtRecord(formatTxtRecord(txt)));
  })();
}
