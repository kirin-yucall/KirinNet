// KirinNet — Settings API (runtime control, survives restarts)
const express = require('express');
const router = express.Router();

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(e => res.status(500).json({ error: e.message }));

// GET /api/settings — current values
router.get('/settings', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await db.getSettings());
}));

// GET /api/settings/describe — metadata for UI
router.get('/settings/describe', asyncHandler(async (_req, res) => {
  res.json({
    // -- Indexer --
    public_indexing:       { type: 'boolean', default: 'true',  desc: '启用公共内容索引和搜索', group: '索引' },
    // -- Ad slots --
    ad_slots_per_page:     { type: 'number',  default: '2',    desc: '每页广告位数量', group: '广告' },
    ad_reserve_days:       { type: 'number',  default: '7',    desc: '广告位提前预定天数', group: '广告' },
    ad_max_duration_days:  { type: 'number',  default: '30',   desc: '广告位单次最长天数', group: '广告' },
    // -- Node identity (restart required for some) --
    node_domain:           { type: 'text',    default: '',      desc: '节点公开域名，如 kirin.example.com', group: '节点', restart: true },
    node_port:             { type: 'number',  default: '8080',  desc: '节点监听端口（修改后需重启）', group: '节点', restart: true },
    dns_provider:          { type: 'select',  default: '',      desc: 'DNS 服务商', group: '节点', options: ['','cloudflare','dnspod','aliyun','huaweicloud','aws-route53','google-domains','namecheap','godaddy','porkbun','namesilo','cloudns','he.net'] },
    dns_api_key:           { type: 'password',default: '',      desc: 'DNS API Key / Secret', group: '节点' },
  });
}));

// PATCH /api/settings — update
router.patch('/settings', requireAuth, asyncHandler(async (req, res) => {
  const allowed = [
    'public_indexing','ad_slots_per_page','ad_reserve_days','ad_max_duration_days',
    'node_domain','node_port','dns_provider','dns_api_key'
  ];
  const updated = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) { await db.setSetting(k, String(v)); updated[k] = String(v); }
  }
  if (!Object.keys(updated).length) {
    return res.status(400).json({ error: 'no_valid_keys', allowed_keys: allowed });
  }

  // Notify modules
  if (updated.public_indexing !== undefined) {
    require('./indexer').setIndexEnabled(updated.public_indexing === 'true');
  }
  if (updated.ad_slots_per_page || updated.ad_reserve_days || updated.ad_max_duration_days) {
    require('./ad-auction').clearCache?.();
  }

  // Determine if restart needed
  const needsRestart = ['node_domain', 'node_port'].some(k => updated[k] !== undefined);
  res.json({ status: 'ok', updated, restart_needed: needsRestart });
}));

module.exports = { router, set_db };
