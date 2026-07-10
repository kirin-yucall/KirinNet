// KirinNet User Node — Content upload, management, comments (DuckDB + FS)
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const segHash = require('../lib/segment-hash');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

let db, _requireAuth;
function set_db(d, auth) { db = d; _requireAuth = auth; }

// Lazy auth middleware — defers to the real one injected via set_db
function requireAuth(req, res, next) {
  if (!_requireAuth) return next();
  return _requireAuth(req, res, next);
}

// Ensure media directory
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });

// ---- File upload configuration -----------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(DATA_DIR, 'media')),
  filename: (_req, file, cb) => {
    const { v4: uuidv4 } = require('uuid');
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'video/mp4', 'video/webm', 'video/ogg',
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'audio/mp3', 'audio/ogg', 'audio/wav',
      'text/markdown', 'text/html', 'text/plain',
      'application/octet-stream',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

// ---- Helpers ------------------------------------------------------------------
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---- Content Endpoints --------------------------------------------------------

// POST /api/upload
router.post('/upload', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const { title, description, type, content_type, allow_comments, comment_permission, visibility, required_points, required_vip, thumbnail, tags } = req.body;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'no_file' });
  if (!title) return res.status(400).json({ error: 'no_title' });

  const ct = content_type || type || 'article';
  if (!['video', 'image', 'audio', 'article', 'post'].includes(ct)) {
    return res.status(400).json({ error: 'invalid_type' });
  }
  const cp = comment_permission || 'all';
  if (!['all', 'followers', 'none'].includes(cp)) {
    return res.status(400).json({ error: 'invalid_comment_permission', valid: ['all', 'followers', 'none'] });
  }
  const allowComments = allow_comments === 'true' || allow_comments === true || allow_comments === undefined;

  // Normalize tags: comma-separated string → JSON array
  let tagArray = [];
  try {
    if (tags) {
      tagArray = typeof tags === 'string' ? tags.split(',').map(t=>t.trim()).filter(Boolean) : tags;
    }
  } catch(e) { tagArray = []; }

  const contentId = uuidv4();
  const bodyText = description || '';
  const url = `/media/${file.filename}`;

  await db.run(
    `INSERT INTO content (id, title, description, content_type, url, thumbnail, file_size, mime_type, allow_comments, comment_permission, required_points, required_vip, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    contentId, title, description || '', ct, url, thumbnail || '', file.size, file.mimetype, allowComments, cp,
    parseInt(required_points) || 0, required_vip || '', JSON.stringify(tagArray)
  );

  // Compute elastic segment hashes for deduplication
  const segHashes = segHash.computeSegmentHashes(description || '');
  if (segHashes.length > 0) {
    await segHash.storeSegments(db, contentId, segHashes);
    // Check for similar content (warn only, don't block)
    const dupResult = await segHash.findSimilarContent(db, contentId, segHashes, 0.7);
    if (dupResult.isDuplicate) {
      console.log(`[Content] high similarity detected: ${dupResult.matched_id} (${(dupResult.similarity*100).toFixed(0)}%)`);
    }
  }

  // Auto-encrypt for followers if public
  const pushed = [];
  if (visibility !== 'private') {
    const followers = await db.all('SELECT follower_domain, public_key FROM followers');
    for (const f of followers) {
      try {
        const crypto = require('crypto');
        const ck = crypto.randomBytes(32).toString('hex');
        const enc = crypto.publicEncrypt(
          { key: f.public_key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
          Buffer.from(ck)
        );
        await db.run(
          `INSERT INTO encrypted_pushes (content_id, follower_domain, encrypted_key) VALUES (?, ?, ?)
           ON CONFLICT (content_id, follower_domain) DO UPDATE SET encrypted_key = EXCLUDED.encrypted_key`,
          contentId, f.follower_domain, enc.toString('base64')
        );
        pushed.push(f.follower_domain);
      } catch (e) { console.error(`Encrypt for ${f.follower_domain} failed:`, e.message); }
    }
  }

  res.status(201).json({
    id: contentId, title, content_type: ct, url,
    allow_comments: allowComments, comment_permission: cp, thumbnail: thumbnail || '',
    file_size: file.size, mime_type: file.mimetype,
    pushed_to_followers: pushed.length,
    created_at: new Date().toISOString(),
  });
}));

// POST /api/content — JSON-only content (no file required)
router.post('/content', requireAuth, asyncHandler(async (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const { title, body, description, content_type, comment_permission, visibility, required_points, required_vip, thumbnail, tags } = req.body;

  if (!title) return res.status(400).json({ error: 'no_title' });

  const ct = content_type || 'article';
  if (!['video', 'image', 'audio', 'article', 'post'].includes(ct)) {
    return res.status(400).json({ error: 'invalid_type' });
  }
  const cp = comment_permission || 'all';
  if (!['all', 'followers', 'none'].includes(cp)) {
    return res.status(400).json({ error: 'invalid_comment_permission', valid: ['all', 'followers', 'none'] });
  }

  const contentId = uuidv4();
  const textBody = body || description || '';

  // Normalize tags
  let tagArray = [];
  try {
    if (tags) {
      tagArray = typeof tags === 'string' ? tags.split(',').map(t=>t.trim()).filter(Boolean) : tags;
    }
  } catch(e) { tagArray = []; }

  await db.run(
    `INSERT INTO content (id, title, description, content_type, url, thumbnail, allow_comments, comment_permission, required_points, required_vip, visibility, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    contentId, title, textBody.substring(0, 5000), ct, '', thumbnail || '', true, cp,
    parseInt(required_points) || 0, required_vip || '', visibility || 'public', JSON.stringify(tagArray)
  );

  // Segment hashing
  const segHashes = segHash.computeSegmentHashes(textBody);
  if (segHashes.length > 0) {
    await segHash.storeSegments(db, contentId, segHashes);
    const dupResult = await segHash.findSimilarContent(db, contentId, segHashes, 0.7);
    if (dupResult.isDuplicate) {
      console.log(`[Content] high similarity detected: ${dupResult.matched_id} (${(dupResult.similarity*100).toFixed(0)}%)`);
    }
  }

  res.status(201).json({
    id: contentId, title, content_type: ct, comment_permission: cp,
    description: textBody.substring(0, 200),
    created_at: new Date().toISOString(),
  });
}));

// GET /api/content
router.get('/content', asyncHandler(async (req, res) => {
  const limit = Math.min(+req.query.limit || 50, 200);
  const offset = +req.query.offset || 0;
  const type = req.query.type || null;

  let sql = 'SELECT id, title, description, content_type, url, thumbnail, file_size, mime_type, allow_comments, comment_permission, tags, created_at FROM content WHERE deleted_at IS NULL';
  const params = [];

  if (type) { sql += ' AND content_type = ?'; params.push(type); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const items = await db.all(sql, ...params);
  res.json(items);
}));

// GET /api/content/:id
router.get('/content/:id', asyncHandler(async (req, res) => {
  const item = await db.get('SELECT * FROM content WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  res.json(item);
}));

// PUT /api/content/:id/comments/toggle
router.put('/content/:id/comments/toggle', requireAuth, asyncHandler(async (req, res) => {
  const { allow } = req.body;
  if (typeof allow !== 'boolean') return res.status(400).json({ error: 'allow must be boolean' });
  const item = await db.get('SELECT * FROM content WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  await db.run('UPDATE content SET allow_comments = ? WHERE id = ?', allow, req.params.id);
  res.json({ content_id: req.params.id, allow_comments: allow });
}));

// DELETE /api/content/:id
router.delete('/content/:id', requireAuth, asyncHandler(async (req, res) => {
  const item = await db.get('SELECT * FROM content WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });

  const filePath = path.join(DATA_DIR, 'media', path.basename(item.url));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  if (item.thumbnail) {
    const thumbPath = path.join(DATA_DIR, 'media', path.basename(item.thumbnail));
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  }

  await db.run('DELETE FROM content WHERE id = ?', req.params.id);
  await db.run('DELETE FROM comments WHERE content_id = ?', req.params.id);
  res.status(204).send();
}));

// ---- Comment Management (Node Owner Only) -------------------------------------

// GET /api/comments — list all comments on this node's content (owner view)
router.get('/comments', asyncHandler(async (req, res) => {
  const limit = Math.min(+req.query.limit || 50, 200);
  const offset = +req.query.offset || 0;

  const items = await db.all(`
    SELECT c.id, c.content_id, c.author_domain, c.body, c.parent_comment_id,
           c.created_at, c.deleted_at, co.title AS content_title
    FROM comments c JOIN content co ON c.content_id = co.id
    ORDER BY c.created_at DESC LIMIT ? OFFSET ?
  `, limit, offset);

  res.json(items);
}));

// GET /api/content/:id/comments
router.get('/content/:id/comments', asyncHandler(async (req, res) => {
  const content = await db.get('SELECT id, allow_comments FROM content WHERE id = ?', req.params.id);
  if (!content) return res.status(404).json({ error: 'not_found' });

  const comments = await db.all(`
    SELECT id, author_domain, body, parent_comment_id, created_at, deleted_at
    FROM comments WHERE content_id = ? AND deleted_at IS NULL
    ORDER BY created_at ASC
  `, req.params.id);

  // Build tree
  const commentTree = buildCommentTree(comments);
  res.json({ content_id: req.params.id, allow_comments: content.allow_comments,
              total: comments.length, comments: commentTree });
}));

// DELETE /api/comments/:id — node owner can delete any comment on their content
router.delete('/comments/:id', requireAuth, asyncHandler(async (req, res) => {
  const comment = await db.get('SELECT * FROM comments WHERE id = ?', req.params.id);
  if (!comment) return res.status(404).json({ error: 'not_found' });
  // Verify comment belongs to this node's content
  const content = await db.get('SELECT * FROM content WHERE id = ?', comment.content_id);
  if (!content) return res.status(404).json({ error: 'content_not_found' });

  // Soft delete
  await db.run('UPDATE comments SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', req.params.id);
  res.status(204).send();
}));

// ---- Helpers ------------------------------------------------------------------

function buildCommentTree(comments) {
  const map = new Map();
  const roots = [];
  for (const c of comments) map.set(c.id, { ...c, replies: [] });
  for (const c of comments) {
    if (c.parent_comment_id && map.has(c.parent_comment_id)) {
      map.get(c.parent_comment_id).replies.push(map.get(c.id));
    } else {
      roots.push(map.get(c.id));
    }
  }
  return roots;
}

module.exports = { router, set_db };
