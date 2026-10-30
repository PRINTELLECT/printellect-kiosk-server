import crypto from 'crypto';
import fs from 'fs';

/**
 * Generates an Ed25519 keypair in standard SPKI/PKCS#8 PEM format.
 * @returns {{ publicKey: string, privateKey: string }}
 */
export function generateEd25519KeyPair() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });
}

/**
 * Signs data using Ed25519 private key.
 * @param {Buffer|string} data 
 * @param {string} privateKeyPem 
 * @returns {Buffer} Raw 64-byte binary signature.
 */
export function signData(data, privateKeyPem) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return crypto.sign(null, buf, privateKeyPem);
}

/**
 * Verifies an Ed25519 signature.
 * @param {Buffer|string} data 
 * @param {Buffer} signature 
 * @param {string} publicKeyPem 
 * @returns {boolean} True if signature is valid.
 */
export function verifySignature(data, signature, publicKeyPem) {
  try {
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const sigBuf = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
    return crypto.verify(null, dataBuf, publicKeyPem, sigBuf);
  } catch (_) {
    return false;
  }
}

/**
 * Computes the SHA-256 hex digest of a file or buffer.
 * When target is a string, it is always treated strictly as a file path (throwing ENOENT if missing).
 * @param {string|Buffer} target - File path or Buffer.
 * @returns {string} Hex encoded sha256.
 */
export function computeSha256(target) {
  const hash = crypto.createHash('sha256');
  if (Buffer.isBuffer(target)) {
    hash.update(target);
  } else if (typeof target === 'string') {
    hash.update(fs.readFileSync(target));
  } else {
    throw new TypeError('Target must be a file path string or Buffer');
  }
  return hash.digest('hex');
}

export default {
  generateEd25519KeyPair,
  signData,
  verifySignature,
  computeSha256,
};
