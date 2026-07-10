// KirinNet Node — Profile + Init + Restart (DuckDB)
const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const router = express.Router();

let db;
function set_db(d) { db = d; }

// ---- Auth middleware ---------------------------------------------------------

async function getNode() {
  return db.get('SELECT * FROM node LIMIT 1');
}

async function isNodeInit() {
  const node = await getNode();
  return !!(node && node.password && node.password.length >= 6);
}

async function requireAuth(req, res, next) {
  const node = await getNode();
  // Uninitialized → allow everything (setup mode)
  if (!node || !node.password || node.password.length < 6) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'unauthorized', message: 'Password required' });
  }

  const [scheme, credentials] = authHeader.split(' ');
  if (scheme === 'Basic') {
    const [username, password] = Buffer.from(credentials, 'base64').toString().split(':');
    const match = await bcrypt.compare(password, node.password);
    if (match) return next();
  }
  if (scheme === 'Bearer') {
    const match = await bcrypt.compare(credentials, node.password);
    if (match) return next();
  }

  return res.status(401).json({ error: 'unauthorized', message: 'Invalid credentials' });
}

// ---- Init (first-time setup) ------------------------------------------------

// GET /api/init/status — check if initialized
router.get('/init/status', async (_req, res) => {
  const ready = await isNodeInit();
  const node = await getNode();
  res.json({
    initialized: ready,
    domain: (await db.getSetting('node_domain')) || process.env.DOMAIN || '',
    port: process.env.PORT || '8080',
  });
});

// POST /api/init — first-time setup
router.post('/init', async (req, res) => {
  const ready = await isNodeInit();
  if (ready) return res.status(400).json({ error: 'already_initialized' });

  const { password, domain, dns_provider, dns_api_key } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'password_min_length', min: 6 });
  }

  const hash = await bcrypt.hash(password, 10);
  await db.run('UPDATE node SET password = ?', hash);

  if (domain) await db.setSetting('node_domain', domain);
  if (dns_provider) await db.setSetting('dns_provider', dns_provider);
  if (dns_api_key) await db.setSetting('dns_api_key', dns_api_key);

  res.json({ status: 'ok', message: 'Node initialized' });
});

// ---- Profile ----------------------------------------------------------------

router.get('/profile', requireAuth, async (req, res) => {
  try {
    const node = await getNode();
    if (!node) return res.status(404).json({ error: 'not_found' });
    res.json({
      id: node.id,
      nickname: node.nickname,
      bio: node.bio || '',
      avatar: node.avatar || '',
      initialized: !!(node.password && node.password.length >= 6),
      created_at: node.created_at,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { nickname, bio, avatar, password } = req.body;
    if (nickname) await db.run('UPDATE node SET nickname = ?', nickname);
    if (bio !== undefined) await db.run('UPDATE node SET bio = ?', bio);
    if (avatar) await db.run('UPDATE node SET avatar = ?', avatar);
    if (password && password.length >= 6) {
      const hash = await bcrypt.hash(password, 10);
      await db.run('UPDATE node SET password = ?', hash);
    }
    const node = await getNode();
    res.json({ message: 'Profile updated', nickname: node.nickname });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Restart ----------------------------------------------------------------

// POST /api/restart — graceful restart (for port/CA changes)
router.post('/restart', requireAuth, async (_req, res) => {
  res.json({ status: 'ok', message: 'Restarting in 2 seconds...' });
  setTimeout(async () => {
    try { await db.exec('CHECKPOINT'); } catch(e) {}
    process.exit(0);
  }, 2000);
});

// ---- CA Cert upload ---------------------------------------------------------

const CA_DIR = path.join(process.env.DATA_DIR || '/app/data', 'ca');

// POST /api/ca-cert — upload government CA PEM (JSON { pem: "..." })
router.post('/ca-cert', requireAuth, async (req, res) => {
  try {
    const { pem } = req.body;
    if (!pem || !pem.includes('BEGIN CERTIFICATE')) {
      return res.status(400).json({ error: 'invalid_pem' });
    }

    fs.mkdirSync(CA_DIR, { recursive: true });
    fs.writeFileSync(path.join(CA_DIR, 'custom-ca.pem'), pem);

    await db.setSetting('ca_cert_uploaded', 'true');
    await db.setSetting('ca_cert_path', path.join(CA_DIR, 'custom-ca.pem'));

    res.json({ status: 'ok', message: 'CA cert saved. Restart to apply.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ca-cert — check if CA uploaded
router.get('/ca-cert', async (_req, res) => {
  const uploaded = await db.getSetting('ca_cert_uploaded');
  const caPath = await db.getSetting('ca_cert_path');
  const exists = caPath && fs.existsSync(caPath);
  res.json({ uploaded: uploaded === 'true' && exists, path: caPath || null });
});

// ---- Password Recovery (localhost-only trigger) -----------------------------

// POST /api/request-recovery — generate recovery code (localhost only)
// Usage: docker exec -it <container> curl -s http://localhost:8080/api/request-recovery
router.post('/request-recovery', async (req, res) => {
  // Only allow from localhost — requires docker exec access
  const ip = req.ip || req.socket.remoteAddress || '';
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'forbidden', message: '此端点仅可从容器内部访问。请使用: docker exec -it <容器> curl http://localhost:8080/api/request-recovery' });
  }

  try {
    const crypto = require('crypto');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];

    const expiresAt = Date.now() + 10 * 60 * 1000;
    await db.setSetting('recovery_code', JSON.stringify({ code, expires_at: expiresAt }));

    console.log(`[Recovery] Code generated: ${code} (expires in 10 min)`);
    res.json({ recovery_code: code, expires_in: '10 minutes', usage: '在登录页点击「忘记密码？」输入此码' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reset-password — verify recovery code + set new password
router.post('/reset-password', async (req, res) => {
  try {
    const { code, password } = req.body;
    if (!code || !password || password.length < 6) {
      return res.status(400).json({ error: 'bad_request', message: 'Recovery code + new password (>=6 chars) required' });
    }

    const raw = await db.getSetting('recovery_code');
    if (!raw) return res.status(400).json({ error: 'no_recovery_code', message: '没有活跃的恢复码。请运行: docker exec -it <容器> curl http://localhost:8080/api/request-recovery' });

    let stored;
    try { stored = JSON.parse(raw); } catch(e) {
      return res.status(400).json({ error: 'invalid_recovery_code' });
    }

    if (Date.now() > stored.expires_at) {
      await db.setSetting('recovery_code', '');
      return res.status(400).json({ error: 'expired', message: '恢复码已过期（10分钟）。请重新生成' });
    }

    if (code.toUpperCase() !== stored.code.toUpperCase()) {
      return res.status(400).json({ error: 'invalid_code', message: '恢复码不正确' });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.run('UPDATE node SET password = ?', hash);
    await db.setSetting('recovery_code', '');

    res.json({ status: 'ok', message: '密码已重置，请用新密码登录' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Content feed (public) --------------------------------------------------

// (handled by content.js router — this file provides requireAuth/isNodeInit)

module.exports = { router, set_db, requireAuth, isNodeInit };
