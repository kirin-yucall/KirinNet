// ============================================================================
// KirinNet — Authentication Middleware (challenge-response + JWT)
// ============================================================================
const crypto = require('crypto');

const TOKEN_SECRET = process.env.JWT_SECRET || 'kirinnet-dev-secret-change-in-production';
const TOKEN_EXPIRY = 24 * 60 * 60; // 24 hours

function base64url(str) {
  return Buffer.from(str).toString('base64url');
}
function base64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function createToken(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY,
  }));
  const signature = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', TOKEN_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig)))
      return null;
    const payload = JSON.parse(base64urlDecode(body));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000))
      return null;
    return payload;
  } catch { return null; }
}

function createRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: 'Bearer <token> required' });
  }
  const payload = verifyToken(authHeader.substring(7));
  if (!payload) {
    return res.status(401).json({ error: 'unauthorized', message: 'Token expired or invalid' });
  }
  req.user = payload;
  next();
}

function requireModerator(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (req.user.role !== 'moderator' && req.user.role !== 'admin')
    return res.status(403).json({ error: 'forbidden', message: 'Moderator+ required' });
  next();
}

module.exports = { createToken, verifyToken, createRefreshToken, requireAuth, requireModerator, TOKEN_EXPIRY };
