// ============================================================================
// KirinNet — Publish API
//
// POST /api/v1/publish — Submit content metadata to the index.
// Matches api_contract.md Section 2.
// ============================================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Categorization (api_contract.md §2)
// ---------------------------------------------------------------------------
const VALID_CATEGORIES = ['post', 'video', 'article', 'audio', 'image', 'other'];
const VALID_STORAGE_TYPES = ['ipfs', 'arweave'];
const MAX_TITLE_LENGTH = 200;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 30;
const MAX_DESCRIPTION_LENGTH = 5000;

// ---------------------------------------------------------------------------
// CID validation
// ---------------------------------------------------------------------------
function isValidCid(cid) {
  if (!cid) return false;
  // IPFS CIDv0
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) return true;
  // IPFS CIDv1
  if (/^baf[a-z2-7]{56,}$/i.test(cid)) return true;
  // Arweave tx-id
  if (/^[a-zA-Z0-9_-]{43}$/.test(cid)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Signature verification (api_contract.md §2)
//
// message = title + description + cid + creator_domain
// Signed with ECDSA (secp256k1 or P-256) private key.
// Signature: hex-encoded DER format
// Public key: PEM format (-----BEGIN PUBLIC KEY-----...)
// ---------------------------------------------------------------------------
function verifySignature(title, description, cid, creator_domain, publicKey, signature) {
  // Development mode: accept any non-empty signature with valid key length
  if (process.env.NODE_ENV === 'development' || process.env.KIRINNET_SKIP_SIG_VERIFY === 'true') {
    if (!signature || signature.length < 10) return false;
    if (!publicKey || publicKey.length < 10) return false;
    return true;
  }

  // Production: real ECDSA verification
  try {
    // Parse public key from PEM or raw format
    const pemKey = publicKey.startsWith('-----BEGIN')
      ? publicKey
      : `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;

    // Decode signature from hex
    const sigBuffer = Buffer.from(signature.replace(/^0x/, ''), 'hex');

    // Build the canonical message (same as frontend signs)
    const payload = title + (description || '') + cid + creator_domain;

    const verifier = crypto.createVerify('SHA256');
    verifier.update(payload);
    verifier.end();

    return verifier.verify(pemKey, sigBuffer);
  } catch (err) {
    console.error('[publish] Signature verification failed:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/publish
// ---------------------------------------------------------------------------
router.post('/publish', async (req, res, next) => {
  try {
    const { pool } = require('../server');
    const { title, description, cid, storage_type, category, tags, creator_domain, signature, thumbnail_cid } = req.body;

    // --- Validation ---

    if (!title || !cid || !storage_type || !category || !creator_domain || !signature) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'Missing required fields: title, cid, storage_type, category, creator_domain, signature',
      });
    }

    if (title.length > MAX_TITLE_LENGTH) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `Title must be at most ${MAX_TITLE_LENGTH} characters`,
      });
    }

    if (description && description.length > MAX_DESCRIPTION_LENGTH) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      });
    }

    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
      });
    }

    if (!VALID_STORAGE_TYPES.includes(storage_type)) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `Invalid storage_type. Must be one of: ${VALID_STORAGE_TYPES.join(', ')}`,
      });
    }

    if (!isValidCid(cid)) {
      return res.status(400).json({
        error: 'invalid_cid',
        message: 'Invalid CID. Must be a valid IPFS CIDv0, CIDv1, or Arweave tx-id',
      });
    }

    // Tags validation
    let tagArray = [];
    if (tags) {
      tagArray = Array.isArray(tags) ? tags : [tags];
      if (tagArray.length > MAX_TAGS) {
        return res.status(400).json({
          error: 'invalid_request',
          message: `Maximum ${MAX_TAGS} tags allowed`,
        });
      }
      for (const tag of tagArray) {
        if (typeof tag !== 'string' || tag.length > MAX_TAG_LENGTH) {
          return res.status(400).json({
            error: 'invalid_request',
            message: `Each tag must be a string of at most ${MAX_TAG_LENGTH} characters`,
          });
        }
      }
    }

    // --- Look up user ---
    const userResult = await pool.query(
      'SELECT id, public_key FROM users WHERE domain = $1',
      [creator_domain]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'user_not_found',
        message: `No user registered for domain '${creator_domain}'. Register via POST /api/auth/register first.`,
      });
    }

    const publicKey = userResult.rows[0].public_key;

    // --- Verify signature ---
    if (!verifySignature(title, description || '', cid, creator_domain, publicKey, signature)) {
      return res.status(400).json({
        error: 'invalid_signature',
        message: 'Signature verification failed. Ensure metadata is signed with the correct private key.',
      });
    }

    // --- Insert content ---
    const insertResult = await pool.query(
      `INSERT INTO content
         (cid, storage_type, title, description, category, tags,
          creator_domain, creator_key, signature, thumbnail_cid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING
         id, cid, storage_type, title, category, tags,
         creator_domain, creator_key, created_at`,
      [cid, storage_type, title, description || null, category, tagArray,
       creator_domain, publicKey, signature, thumbnail_cid || null]
    );

    const content = insertResult.rows[0];

    console.log(`[publish] Content published: id=${content.id} title="${content.title}" by ${content.creator_domain}`);

    // --- Log ingestion ---
    await pool.query(
      `INSERT INTO ingestion_log (content_id, action, source_node, cid, details)
       VALUES ($1, 'indexed', $2, $3, $4)`,
      [content.id, creator_domain, cid, JSON.stringify({ title, category, tags: tagArray })]
    );

    res.status(201).json({
      content_id: String(content.id),
      title: content.title,
      cid: content.cid,
      storage_type: content.storage_type,
      creator_domain: content.creator_domain,
      category: content.category,
      tags: content.tags || [],
      created_at: content.created_at,
      url: `https://kirinnet.org/content/${content.id}`,
      direct_url: storage_type === 'ipfs'
        ? `https://gateway.kirinnet.org/ipfs/${content.cid}`
        : `https://arweave.net/${content.cid}`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
