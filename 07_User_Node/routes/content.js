const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const router = express.Router();

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const DB_PATH = path.join(DATA_DIR, 'db', 'auranode.db');

// Initialize SQLite database
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Ensure media directory exists
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });

// Initialize node identity
let node = db.prepare('SELECT * FROM node LIMIT 1').get();

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

// --- File upload configuration ---

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(DATA_DIR, 'media'));
  },
  filename: function (req, file, cb) {
    const { v4: uuidv4 } = require('uuid');
    const ext = path.extname(file.originalname);
    const filename = `${uuidv4()}${ext}`;
    cb(null, filename);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'video/mp4', 'video/webm', 'video/ogg',
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'audio/mp3', 'audio/ogg', 'audio/wav',
      'text/markdown', 'text/html',
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// --- Content Management API ---

// POST /api/upload
// Upload a file (video/image/audio) and save metadata to SQLite.
// Requires authentication if password is set.
router.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  try {
    const { v4: uuidv4 } = require('uuid');

    const { title, description, type, thumbnail } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'no_file', message: 'No file uploaded' });
    }

    if (!title) {
      return res.status(400).json({ error: 'no_title', message: 'Title is required' });
    }

    if (!type || !['video', 'image', 'audio', 'article'].includes(type)) {
      return res.status(400).json({ error: 'invalid_type', message: 'Invalid content type' });
    }

    const contentId = uuidv4();
    const url = `/media/${file.filename}`;
    const thumbnailUrl = thumbnail || '';

    db.prepare(`
      INSERT INTO content (id, title, description, type, url, thumbnail, file_size, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(contentId, title, description || '', type, url, thumbnailUrl, file.size, file.mimetype);

    res.status(201).json({
      id: contentId,
      title,
      type,
      url,
      thumbnail: thumbnailUrl,
      file_size: file.size,
      mime_type: file.mimetype,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'upload_failed', message: err.message });
  }
});

// GET /api/content
// List all content items (public and private if authenticated).
router.get('/content', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const type = req.query.type || null;

  let sql = 'SELECT id, title, type, url, thumbnail, file_size, mime_type, created_at FROM content';
  const params = [];

  if (type) {
    sql += ' WHERE type = ?';
    params.push(type);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const items = db.prepare(sql).all(...params);

  res.json(items);
});

// GET /api/content/:id
// Get a single content item by ID.
router.get('/content/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);

  if (!item) {
    return res.status(404).json({ error: 'not_found', message: 'Content not found' });
  }

  res.json(item);
});

// DELETE /api/content/:id
// Delete content item and its file.
// Requires authentication if password is set.
router.delete('/content/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM content WHERE id = ?').get(req.params.id);

  if (!item) {
    return res.status(404).json({ error: 'not_found', message: 'Content not found' });
  }

  // Delete file from filesystem
  const filePath = path.join(DATA_DIR, 'media', path.basename(item.url));
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  // Delete thumbnail if exists
  if (item.thumbnail) {
    const thumbPath = path.join(DATA_DIR, 'media', path.basename(item.thumbnail));
    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
    }
  }

  // Delete from database
  db.prepare('DELETE FROM content WHERE id = ?').run(req.params.id);

  res.status(204).send();
});

module.exports = router;
