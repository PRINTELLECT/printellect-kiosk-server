#!/usr/bin/env node

/**
 * PRINTELLECT Kiosk Server — Release Manifest Signer
 * 
 * Usage: node scripts/sign-release.js <manifest.json> <privateKey.pem> [output.sig]
 */
import fs from 'fs';
import path from 'path';
import { signData } from './crypto-utils.js';

const manifestPath = process.argv[2];
const keyPath = process.argv[3];
const outputPath = process.argv[4] || `${manifestPath}.sig`;

if (!manifestPath || !keyPath) {
  console.error('Usage: node scripts/sign-release.js <manifest.json> <privateKey.pem> [output.sig]');
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) {
  console.error(`[ERROR] Manifest not found: ${manifestPath}`);
  process.exit(1);
}

if (!fs.existsSync(keyPath)) {
  console.error(`[ERROR] Private key not found: ${keyPath}`);
  process.exit(1);
}

try {
  const manifestData = fs.readFileSync(manifestPath);
  const privateKey = fs.readFileSync(keyPath, 'utf8');

  const signature = signData(manifestData, privateKey);
  fs.writeFileSync(outputPath, signature);

  console.log(`✅ Successfully signed manifest: ${manifestPath}`);
  console.log(`   Signature written to: ${outputPath} (${signature.length} bytes)`);
} catch (err) {
  console.error(`[FATAL ERROR] Failed to sign manifest: ${err.message}`);
  process.exit(1);
}
