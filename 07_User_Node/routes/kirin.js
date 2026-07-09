const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const DB_PATH = path.join(DATA_DIR, 'db', 'auranode.db');

// Initialize SQLite database
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create schema if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS node (
    id         TEXT PRIMARY KEY,
    nickname   TEXT NOT NULL DEFAULT 'User',
    bio        TEXT DEFAULT '',
    avatar     TEXT DEFAULT '',
    password   TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS content (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    type        TEXT NOT NULL CHECK (type IN ('video', 'image', 'audio', 'article')),
    url         TEXT NOT NULL,
    thumbnail   TEXT DEFAULT '',
    file_size   INTEGER DEFAULT 0,
    mime_type   TEXT DEFAULT '',
    visibility  TEXT DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

// Initialize node identity if not exists
let node = db.prepare('SELECT * FROM node LIMIT 1').get();
if (!node) {
  const { v4: uuidv4 } = require('uuid');
  const nodeId = uuidv4();
  db.prepare('INSERT INTO node (id, nickname) VALUES (?, ?)').run(nodeId, 'User');
  node = { id: nodeId, nickname: 'User', bio: '', avatar: '', password: '' };
  console.log(`User Node initialized. ID: ${nodeId}`);
}

// --- Authentication middleware ---

function requireAuth(req, res, next) {
  if (!node.password) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'unauthorized', message: 'Password required' });
  }

  const [scheme, credentials] = authHeader.split(' ');

  if (scheme === 'Basic') {
    const [username, password] = Buffer.from(credentials, 'base64').toString().split(':');
    if (username === node.id && password === node.password) return next();
  }

  if (scheme === 'Bearer') {
    if (credentials === node.password) return next();
  }

  res.status(401).json({ error: 'unauthorized', message: 'Invalid credentials' });
}

// --- KirinDNS Compatible Endpoints ---

// GET /aura/profile
// Returns the user's public profile metadata.
// If password is set, requires Authorization header.
router.get('/profile', (req, res) => {
  // Refresh node data from DB
  node = db.prepare('SELECT * FROM node LIMIT 1').get();

  const profile = {
    id: node.id,
    nickname: node.nickname,
    bio: node.bio || '',
    avatar: node.avatar || '',
    created_at: node.created_at,
  };

  res.json(profile);
});

// PUT /aura/profile
// Update user profile (nickname, bio, avatar, password).
// Requires authentication if password is set.
router.put('/aura/profile', requireAuth, (req, res) => {
  const { nickname, bio, avatar, password } = req.body;

  if (nickname) db.prepare('UPDATE node SET nickname = ?').run(nickname);
  if (bio !== undefined) db.prepare('UPDATE node SET bio = ?').run(bio);
  if (avatar) db.prepare('UPDATE node SET avatar = ?').run(avatar);
  if (password) db.prepare('UPDATE node SET password = ?').run(password);

  // Refresh node data
  node = db.prepare('SELECT * FROM node LIMIT 1').get();

  res.json({ message: 'Profile updated', nickname: node.nickname });
});

// GET /aura/content
// Returns a list of public content items.
// If password is set, requires Authorization header.
router.get('/content', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const type = req.query.type || null;

  let sql = 'SELECT id, title, type, url, thumbnail, description, file_size, created_at FROM content WHERE visibility = ?';
  const params = ['public'];

  // Support Since header for incremental fetching (Aggregator sync protocol)
  const since = req.headers.since;
  if (since) {
    sql += ' AND created_at >= ?';
    params.push(since);
  }

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const items = db.prepare(sql).all(...params);

  res.json(items);
});

module.exports = router;
