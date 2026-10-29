#!/usr/bin/env node

/**
 * PRINTELLECT Kiosk Server — Release Signing Key Generator
 * 
 * Generates an Ed25519 keypair for cryptographically signing release manifests.
 * Usage: node scripts/generate-keys.js [output_dir]
 */
import fs from 'fs';
import path from 'path';
import { generateEd25519KeyPair } from './crypto-utils.js';

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(process.cwd(), '.keys');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
}

const privPath = path.join(outDir, 'release-key.pem');
const pubPath = path.join(outDir, 'release-key.pub.pem');

if (fs.existsSync(privPath) || fs.existsSync(pubPath)) {
  console.error(`\n[ERROR] Key file(s) already exist in ${outDir}.`);
  console.error('To prevent accidental key loss, existing keys will not be overwritten.');
  console.error('Specify a different directory or remove existing keys manually.\n');
  process.exit(1);
}

const { publicKey, privateKey } = generateEd25519KeyPair();

// Write private key with restrictive permissions
fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });

console.log('\n======================================================');
console.log('   PRINTELLECT Release Signing Keypair Generated      ');
console.log('======================================================');
console.log(`Private Key (KEEP SECRET!) : ${privPath}`);
console.log(`Public Key (Embed / Share) : ${pubPath}`);
console.log('\nSECURITY INSTRUCTIONS:');
console.log('1. NEVER commit release-key.pem to git.');
console.log('2. Store release-key.pem in a secure offline vault or GitHub Actions Secrets.');
console.log('3. release-key.pub.pem can be publicly distributed and embedded into the bootstrap installer.');
console.log('======================================================\n');
