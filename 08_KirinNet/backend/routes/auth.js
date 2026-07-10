// KirinNet — Auth API (IM-based, DuckDB)
// Domain = user identity. Auth is performed by the IM system.
// This module handles JWT issuance for session persistence.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { createToken, createRefreshToken, TOKEN_EXPIRY } = require('../middleware/auth');

// POST /api/v1/auth/session
// Body: { domain, im_token, im_signature }
// IM system verifies the user, we just issue a session JWT.
// If user does not exist locally, create on first session.
router.post('/session', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { domain, display_name } = req.body;
    if (!domain) return res.status(400).json({ error: 'missing_domain' });

    // In production: verify im_token/signature with IM system's public key.
    // For now, domain IS identity — auto-create user record.

    let user = await db.get('SELECT * FROM users WHERE domain = ?', domain);
    if (!user) {
      const rows = await db.all(
        'INSERT INTO users (domain, display_name) VALUES (?, ?) RETURNING id',
        domain, display_name || null
      );
      user = { id: rows[0].id, domain, role: 'creator' };
    } else if (display_name) {
      await db.run('UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ?', display_name, domain);
    }

    const token = createToken({ user_id: String(user.id), domain, role: user.role });
    const refresh = createRefreshToken();
    await db.run('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      user.id, refresh, new Date(Date.now() + TOKEN_EXPIRY * 1000).toISOString());

    res.json({ token, refresh_token: refresh, expires_in: TOKEN_EXPIRY, domain, user_id: String(user.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/v1/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'missing_refresh_token' });

    const row = await db.get(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked, u.domain, u.role
       FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id WHERE rt.token = ?`, refresh_token);

    if (!row || row.revoked || new Date(row.expires_at) < new Date())
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired' });

    await db.run('UPDATE refresh_tokens SET revoked = true WHERE id = ?', row.id);
    const token = createToken({ user_id: String(row.user_id), domain: row.domain, role: row.role });
    const newRefresh = createRefreshToken();
    await db.run('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      row.user_id, newRefresh, new Date(Date.now() + TOKEN_EXPIRY * 1000).toISOString());

    res.json({ token, expires_in: TOKEN_EXPIRY });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
