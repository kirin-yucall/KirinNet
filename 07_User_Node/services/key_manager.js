/**
 * key_manager.js — RSA Key Management for KirinNet P2P IM
 *
 * Generates and stores long-term RSA key pairs for the User Node.
 * Provides encryption and decryption for P2P messaging.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const KEYS_DIR = path.join(DATA_DIR, 'keys');

// Ensure keys directory exists
if (!fs.existsSync(KEYS_DIR)) {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
}

const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'public.pem');
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'private.pem');

let _keyPair = null;

/**
 * Initialize keys — generate if not exists, load if exists.
 */
function initKeys() {
  if (_keyPair) return _keyPair;

  // Try to load existing keys
  if (fs.existsSync(PUBLIC_KEY_PATH) && fs.existsSync(PRIVATE_KEY_PATH)) {
    try {
      _keyPair = {
        publicKey: fs.readFileSync(PUBLIC_KEY_PATH, 'utf-8'),
        privateKey: fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8'),
      };
      console.log('[KeyManager] Loaded existing RSA key pair');
      return _keyPair;
    } catch (err) {
      console.error('[KeyManager] Failed to load keys, generating new ones:', err.message);
    }
  }

  // Generate new key pair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  _keyPair = { publicKey, privateKey };

  // Write keys to disk
  fs.writeFileSync(PUBLIC_KEY_PATH, publicKey);
  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey);

  console.log('[KeyManager] Generated new RSA-2048 key pair');
  return _keyPair;
}

/**
 * Get the node's public key.
 * @returns {string} PEM-encoded public key
 */
function getPublicKey() {
  return initKeys().publicKey;
}

/**
 * Get the node's private key.
 * @returns {string} PEM-encoded private key
 */
function getPrivateKey() {
  return initKeys().privateKey;
}

/**
 * Encrypt a message using the recipient's public key (RSA-OAEP with SHA-256).
 *
 * For messages longer than the RSA max plaintext (214 bytes for RSA-2048),
 * uses hybrid encryption: AES-256-GCM for the message + RSA-OAEP for the AES key.
 *
 * @param {string} message - The plaintext message
 * @param {string} publicKey - PEM-encoded public key of the recipient
 * @returns {string} Base64-encoded encrypted payload (JSON)
 */
function encryptMessage(message, publicKey) {
  const msgBuffer = Buffer.from(message, 'utf-8');
  const maxPlaintext = 214; // RSA-2048 OAEP SHA-256 max plaintext

  if (msgBuffer.length <= maxPlaintext) {
    // Direct RSA-OAEP encryption
    const encrypted = crypto.publicEncrypt({
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, msgBuffer);
    return encrypted.toString('base64');
  }

  // Hybrid encryption for longer messages
  const aesKey = crypto.randomBytes(32); // AES-256 key
  const iv = crypto.randomBytes(12); // AES-GCM IV

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  let encryptedMsg = cipher.update(msgBuffer, 'utf-8', 'base64');
  encryptedMsg += cipher.final('base64');
  const tag = cipher.getAuthTag().toString('base64');

  // Encrypt AES key with RSA-OAEP
  const encryptedKey = crypto.publicEncrypt({
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, aesKey).toString('base64');

  return JSON.stringify({
    encrypted_key: encryptedKey,
    iv: iv.toString('base64'),
    content: encryptedMsg,
    tag,
  });
}

/**
 * Decrypt a message using the node's private key.
 *
 * Detects whether the payload is direct RSA-OAEP or hybrid encryption.
 *
 * @param {string} encryptedPayload - Base64-encoded encrypted payload (JSON for hybrid, raw base64 for direct)
 * @returns {string} Decrypted plaintext message
 */
function decryptMessage(encryptedPayload) {
  const keyPair = initKeys();
  const privateKey = keyPair.privateKey;

  // Try to parse as hybrid encryption first
  let parsed;
  try {
    parsed = JSON.parse(encryptedPayload);
  } catch {
    // Not JSON — direct RSA-OAEP encryption
  }

  if (parsed && parsed.encrypted_key && parsed.iv && parsed.content && parsed.tag) {
    // Hybrid decryption
    const encryptedKey = Buffer.from(parsed.encrypted_key, 'base64');
    const iv = Buffer.from(parsed.iv, 'base64');
    const tag = Buffer.from(parsed.tag, 'base64');

    // Decrypt AES key with RSA-OAEP
    const aesKey = crypto.privateDecrypt({
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, encryptedKey);

    // Decrypt message with AES-256-GCM
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    let decryptedMsg = decipher.update(parsed.content, 'base64', 'utf-8');
    decryptedMsg += decipher.final('utf-8');

    return decryptedMsg;
  }

  // Direct RSA-OAEP decryption
  const encrypted = Buffer.from(encryptedPayload, 'base64');
  const decrypted = crypto.privateDecrypt({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, encrypted);

  return decrypted.toString('utf-8');
}

/**
 * Validate a PEM-encoded public key.
 * @param {string} publicKey - PEM-encoded public key
 * @returns {boolean} True if valid
 */
function isValidPublicKey(publicKey) {
  try {
    crypto.publicEncrypt({
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, Buffer.from('test'));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  initKeys,
  getPublicKey,
  getPrivateKey,
  encryptMessage,
  decryptMessage,
  isValidPublicKey,
};
