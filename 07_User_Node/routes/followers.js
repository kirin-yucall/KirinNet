// KirinNet User Node — Followers (one-way subscription)
// Follower submits public key. Node auto-encrypts public content for followers.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

const asyncHandler = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---- Encrypt content key for a follower's public key -------------------------
function encryptForFollower(contentId, publicKeyPem) {
  // Generate an AES-256 content key
  const contentKey = crypto.randomBytes(32);
  const contentKeyHex = contentKey.toString('hex');

  // Encrypt content key with follower's RSA public key
  const encrypted = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    contentKey
  );

  return {
    content_key: contentKeyHex,
    encrypted_key: encrypted.toString('base64'),
  };
}

// ---- Subscribe ---------------------------------------------------------------
// POST /api/followers/subscribe
router.post('/followers/subscribe', asyncHandler(async (req, res) => {
  const { follower_domain, public_key } = req.body;
  if (!follower_domain || !public_key) return res.status(400).json({ error: 'follower_domain and public_key required' });

  await db.run(
    `INSERT INTO followers (follower_domain, public_key) VALUES (?, ?)
     ON CONFLICT (follower_domain) DO UPDATE SET public_key = EXCLUDED.public_key`,
    follower_domain, public_key
  );

  // Encrypt existing public content for this new follower
  const items = await db.all("SELECT id, title FROM content WHERE visibility = 'public' AND deleted_at IS NULL");
  const pushed = [];
  for (const item of items) {
    const { encrypted_key } = encryptForFollower(item.id, public_key);
    await db.run(
      `INSERT INTO encrypted_pushes (content_id, follower_domain, encrypted_key) VALUES (?, ?, ?)
       ON CONFLICT (content_id, follower_domain) DO UPDATE SET encrypted_key = EXCLUDED.encrypted_key`,
      item.id, follower_domain, encrypted_key
    );
    pushed.push(item.id);
  }

  res.status(201).json({
    status: 'subscribed',
    follower_domain,
    encrypted_content_count: pushed.length,
  });
}));

// DELETE /api/followers/:domain
router.delete('/followers/:domain', requireAuth, asyncHandler(async (req, res) => {
  await db.run('DELETE FROM followers WHERE follower_domain = ?', req.params.domain);
  await db.run('DELETE FROM encrypted_pushes WHERE follower_domain = ?', req.params.domain);
  res.status(204).send();
}));

// GET /api/followers
router.get('/followers', asyncHandler(async (req, res) => {
  const followers = await db.all('SELECT * FROM followers ORDER BY subscribed_at DESC');
  res.json({ count: followers.length, followers });
}));

// GET /api/followers/:domain/pushes — follower retrieves their encrypted content
router.get('/followers/:domain/pushes', asyncHandler(async (req, res) => {
  const pushes = await db.all(
    `SELECT ep.content_id, ep.encrypted_key, ep.created_at, c.title, c.content_type
     FROM encrypted_pushes ep JOIN content c ON ep.content_id = c.id
     WHERE ep.follower_domain = ?
     ORDER BY ep.created_at DESC`,
    req.params.domain
  );
  res.json({ follower: req.params.domain, count: pushes.length, pushes });
}));

module.exports = { router, set_db };
