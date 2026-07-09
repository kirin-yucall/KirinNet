// ============================================================================
// KirinNet — Auth API
//
// POST /api/auth/login    — authenticate user
// POST /api/auth/refresh  — refresh token
// POST /api/auth/register — create account
// Matches api_contract.md Section 1.
// ============================================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createToken, createRefreshToken, verifyToken, TOKEN_EXPIRY } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(verify));
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post('/auth/login', async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'Email and password are required',
      });
    }

    const result = await pool.query(
      'SELECT id, email, domain, public_key, password_hash, role, display_name FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid email or password',
      });
    }

    const user = result.rows[0];

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid email or password',
      });
    }

    // Create tokens
    const token = createToken({
      user_id: String(user.id),
      email: user.email,
      domain: user.domain,
      role: user.role,
    });

    const refreshToken = createRefreshToken();
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY * 1000);

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshToken, expiresAt]
    );

    res.json({
      token,
      refresh_token: refreshToken,
      expires_in: TOKEN_EXPIRY,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// ---------------------------------------------------------------------------
router.post('/auth/refresh', async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'refresh_token is required',
      });
    }

    const result = await pool.query(
      'SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked, u.email, u.domain, u.role FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id WHERE rt.token = $1',
      [refresh_token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid refresh token',
      });
    }

    const row = result.rows[0];

    if (row.revoked || new Date(row.expires_at) < new Date()) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Refresh token is expired or revoked',
      });
    }

    // Revoke old refresh token
    await pool.query('UPDATE refresh_tokens SET revoked = true WHERE id = $1', [row.id]);

    // Issue new tokens
    const token = createToken({
      user_id: String(row.user_id),
      email: row.email,
      domain: row.domain,
      role: row.role,
    });

    const newRefreshToken = createRefreshToken();
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY * 1000);

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [row.user_id, newRefreshToken, expiresAt]
    );

    res.json({
      token,
      expires_in: TOKEN_EXPIRY,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
router.post('/auth/register', async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const { email, password, domain, public_key, display_name } = req.body;

    if (!email || !password || !domain || !public_key) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'email, password, domain, and public_key are required',
      });
    }

    // Validate email format
    if (!email.includes('@')) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'Invalid email format',
      });
    }

    // Check uniqueness
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR domain = $2',
      [email, domain]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'conflict',
        message: 'Email or domain already registered',
      });
    }

    const passwordHash = hashPassword(password);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash, domain, public_key, display_name, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, domain, public_key, role, created_at',
      [email, passwordHash, domain, public_key, display_name || null, 'creator']
    );

    const user = result.rows[0];

    // Issue token immediately
    const token = createToken({
      user_id: String(user.id),
      email: user.email,
      domain: user.domain,
      role: user.role,
    });

    res.status(201).json({
      token,
      user_id: String(user.id),
      domain: user.domain,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
