// KirinNet — DNS Record Management
// Dispatches to provider APIs for automated DNS record updates.
// Currently implements: Cloudflare (reference), others return "not yet implemented".
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(e => res.status(500).json({ error: e.message }));

// ---- Provider dispatch --------------------------------------------------------
async function callProviderAPI(provider, apiKey, action, params) {
  switch (provider) {
    case 'cloudflare':
      return cloudflareAPI(apiKey, action, params);
    default:
      return { ok: false, error: `DNS provider '${provider}' — API integration not yet implemented. Contributions welcome.` };
  }
}

// ---- Cloudflare ---------------------------------------------------------------
async function cloudflareAPI(apiKey, action, params) {
  const base = 'https://api.cloudflare.com/client/v4';
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  if (action === 'list_zones') {
    const resp = await fetch(`${base}/zones?name=${encodeURIComponent(params.domain)}`, { headers });
    const data = await resp.json();
    if (!data.success) return { ok: false, error: data.errors?.[0]?.message || 'Cloudflare API error' };
    return { ok: true, zones: data.result.map(z => ({ id: z.id, name: z.name })) };
  }

  if (action === 'update_dns') {
    // Get zone ID first
    const zoneResult = await cloudflareAPI(apiKey, 'list_zones', { domain: params.zone });
    if (!zoneResult.ok) return zoneResult;
    const zoneId = zoneResult.zones[0]?.id;
    if (!zoneId) return { ok: false, error: `Zone not found for ${params.zone}` };

    // List existing records matching name+type
    const listResp = await fetch(
      `${base}/zones/${zoneId}/dns_records?type=${params.type}&name=${params.name}`,
      { headers }
    );
    const listData = await listResp.json();
    if (!listData.success) return { ok: false, error: listData.errors?.[0]?.message || 'DNS list failed' };

    const existing = listData.result[0];
    const record = {
      type: params.type || 'A',
      name: params.name,
      content: params.content,
      ttl: params.ttl || 120,
      proxied: params.proxied || false,
    };

    let result;
    if (existing) {
      // Update
      const updResp = await fetch(`${base}/zones/${zoneId}/dns_records/${existing.id}`, {
        method: 'PUT', headers, body: JSON.stringify(record),
      });
      result = await updResp.json();
      return { ok: result.success, action: 'updated', record_id: existing.id, detail: result };
    } else {
      // Create
      const createResp = await fetch(`${base}/zones/${zoneId}/dns_records`, {
        method: 'POST', headers, body: JSON.stringify(record),
      });
      result = await createResp.json();
      return { ok: result.success, action: 'created', detail: result };
    }
  }

  return { ok: false, error: `Unknown Cloudflare action: ${action}` };
}

// ---- API Endpoints ------------------------------------------------------------

// POST /api/dns/update — update DNS record for this node
// Body: { record_type: 'A'|'SRV'|'TXT', content: '1.2.3.4', ttl: 120 }
router.post('/dns/update', requireAuth, asyncHandler(async (req, res) => {
  const provider = await db.getSetting('dns_provider');
  const apiKey = await db.getSetting('dns_api_key');
  const domain = await db.getSetting('node_domain');
  const port = await db.getSetting('node_port') || '8080';

  if (!provider || !apiKey) {
    return res.status(400).json({ error: 'dns_not_configured', message: '请先在设置中配置 DNS 服务商和 API Key' });
  }
  if (!domain) {
    return res.status(400).json({ error: 'no_domain', message: '请先设置节点域名' });
  }

  const { record_type, content, ttl } = req.body;
  const type = record_type || 'A';

  // Build record name: for SRV, use _kirinnet-https._tcp subdomain
  let recordName = domain;
  if (type === 'SRV') {
    recordName = `_kirinnet-https._tcp.${domain}`;
  }

  const recordContent = content || await getPublicIP();
  const result = await callProviderAPI(provider, apiKey, 'update_dns', {
    zone: domain,
    name: recordName,
    type: type,
    content: recordContent,
    ttl: ttl || 120,
    proxied: false,
  });

  if (result.ok) {
    res.json({ status: 'ok', provider, domain, type, content: recordContent, detail: result });
  } else {
    res.status(502).json({ status: 'failed', provider, error: result.error });
  }
}));

// GET /api/dns/status — check if DNS is configured
router.get('/dns/status', requireAuth, asyncHandler(async (_req, res) => {
  const provider = await db.getSetting('dns_provider') || '';
  const hasKey = !!(await db.getSetting('dns_api_key'));
  const domain = await db.getSetting('node_domain') || '';
  res.json({
    configured: !!(provider && hasKey && domain),
    provider: provider || null,
    has_api_key: hasKey,
    domain: domain || null,
  });
}));

// POST /api/dns/test — test the provider API connection
router.post('/dns/test', requireAuth, asyncHandler(async (req, res) => {
  const provider = await db.getSetting('dns_provider');
  const apiKey = await db.getSetting('dns_api_key');
  if (!provider || !apiKey) {
    return res.status(400).json({ error: 'dns_not_configured' });
  }
  const result = await callProviderAPI(provider, apiKey, 'list_zones', { domain: await db.getSetting('node_domain') || '' });
  res.json(result);
}));

// ---- Helper -------------------------------------------------------------------
async function getPublicIP() {
  try {
    const resp = await fetch('https://api.ipify.org?format=json', { timeout: 5000 });
    const data = await resp.json();
    return data.ip;
  } catch { return '0.0.0.0'; }
}

module.exports = { router, set_db };
