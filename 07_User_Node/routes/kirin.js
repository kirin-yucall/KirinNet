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

// ---- Content feed (public) --------------------------------------------------

// (handled by content.js router — this file provides requireAuth/isNodeInit)

module.exports = { router, set_db, requireAuth, isNodeInit };
