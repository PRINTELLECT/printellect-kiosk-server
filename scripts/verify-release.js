#!/usr/bin/env node

/**
 * PRINTELLECT Kiosk Server — Release Manifest, Archive & Staleness Verifier
 *
 * Verifies:
 *   1. Ed25519 signature of manifest.json against expected publicKey.pem.
 *   2. Strict schemaVersion 2 manifest schema, SemVer version, target architecture, and sourceFiles map.
 *   3. Archive existence, exact byte size, and SHA-256 match against manifest.archive.
 *   4. Archive tar headers: rejects symlinks, hardlinks, device nodes, path traversal, forbidden files,
 *      duplicate entries, missing REQUIRED_FILES, and unexpected extra files.
 *   5. Extracted per-file SHA-256 integrity against manifest.sourceFiles and release.json.
 *   6. Optional (--check-workspace): confirms dist/ matches every current workspace
 *      source file byte-for-byte so stale dist/ artifacts are deterministically rejected.
 *
 * Usage:
 *   node scripts/verify-release.js <manifest.json> <signature.sig> [publicKey.pem] [archive.tar.gz] [--check-workspace]
 *   (When [publicKey.pem] is omitted, defaults to the pinned production key at keys/release-key.pub.pem.)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { verifySignature, computeSha256 } from './crypto-utils.js';
import { REQUIRED_FILES, FORBIDDEN_PATTERNS } from './package-release.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = path.resolve(__dirname, '..');
export const PINNED_PUBLIC_KEY_PATH = path.join(DEFAULT_WORKSPACE_ROOT, 'keys', 'release-key.pub.pem');

const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const ALLOWED_ARCHIVE_DIRS = new Set(['.', 'bin', 'scripts', 'systemd']);

export function normalizePemKeyBody(pemText) {
  return String(pemText || '')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('-----'))
    .join('')
    .replace(/\s+/g, '');
}

function assertExtractedTreeHasNoLinks(dirPath) {
  const entries = fs.readdirSync(dirPath);
  for (const name of entries) {
    const full = path.join(dirPath, name);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) {
      throw new Error(`SECURITY ALERT: Extracted archive contains a symbolic link: "${name}"`);
    }
    if (st.isDirectory()) {
      assertExtractedTreeHasNoLinks(full);
    } else if (!st.isFile()) {
      throw new Error(`SECURITY ALERT: Extracted archive contains a non-regular file: "${name}"`);
    }
  }
}

/**
 * Programmatically verifies a signed release bundle and (optionally) workspace freshness.
 */
export function verifyRelease(opts = {}) {
  const {
    manifestPath,
    sigPath,
    pubKeyPath = PINNED_PUBLIC_KEY_PATH,
    archivePath: archiveOverride = null,
    checkWorkspace = false,
    workspaceRoot = DEFAULT_WORKSPACE_ROOT,
  } = opts;

  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  if (!sigPath || !fs.existsSync(sigPath)) {
    throw new Error(`Signature file not found: ${sigPath}`);
  }
  if (!pubKeyPath || !fs.existsSync(pubKeyPath)) {
    throw new Error(`Public key not found: ${pubKeyPath}`);
  }

  const manifestData = fs.readFileSync(manifestPath);
  const signature = fs.readFileSync(sigPath);
  const publicKey = fs.readFileSync(pubKeyPath, 'utf8');
  const pinnedKeyExists = fs.existsSync(PINNED_PUBLIC_KEY_PATH);
  const usedPinnedProductionKey =
    pinnedKeyExists &&
    normalizePemKeyBody(publicKey) ===
      normalizePemKeyBody(fs.readFileSync(PINNED_PUBLIC_KEY_PATH, 'utf8'));

  // 1. Cryptographic signature verification (Ed25519 signatures must be exactly 64 bytes)
  if (signature.length !== 64 || !verifySignature(manifestData, signature, publicKey)) {
    throw new Error(
      'CRYPTOGRAPHIC VERIFICATION FAILED: Manifest signature does not match public key or manifest was tampered with!'
    );
  }

  // 2. Strict manifest JSON & schemaVersion 2 validation
  let manifest;
  try {
    manifest = JSON.parse(manifestData.toString('utf8'));
  } catch (err) {
    throw new Error(`INVALID MANIFEST JSON: ${err.message}`);
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('INVALID MANIFEST SCHEMA: Manifest root must be a JSON object.');
  }
  if (manifest.schemaVersion !== 2) {
    throw new Error(
      `INVALID MANIFEST SCHEMA: Expected schemaVersion 2, got ${JSON.stringify(manifest.schemaVersion)}.`
    );
  }
  if (manifest.name !== 'printellect-kiosk-daemon') {
    throw new Error(
      `INVALID MANIFEST SCHEMA: Expected name "printellect-kiosk-daemon", got ${JSON.stringify(manifest.name)}.`
    );
  }
  if (
    typeof manifest.version !== 'string' ||
    !SEMVER_RE.test(manifest.version) ||
    manifest.version === '0.0.0'
  ) {
    throw new Error(
      `UNSUPPORTED OR INVALID VERSION: "${manifest.version}". Expected non-zero SemVer.`
    );
  }
  if (manifest.architecture !== 'linux-arm64') {
    throw new Error(
      `UNSUPPORTED ARCHITECTURE: Expected "linux-arm64", got ${JSON.stringify(manifest.architecture)}.`
    );
  }
  if (manifest.minNodeVersion !== '>=24.0.0') {
    throw new Error(
      `UNSUPPORTED MIN NODE VERSION: Expected ">=24.0.0", got ${JSON.stringify(manifest.minNodeVersion)}.`
    );
  }
  if (
    !manifest.archive ||
    typeof manifest.archive !== 'object' ||
    typeof manifest.archive.filename !== 'string' ||
    !manifest.archive.filename ||
    typeof manifest.archive.sha256 !== 'string' ||
    !SHA256_RE.test(manifest.archive.sha256) ||
    !Number.isInteger(manifest.archive.sizeBytes) ||
    manifest.archive.sizeBytes <= 0
  ) {
    throw new Error(
      'INVALID MANIFEST SCHEMA: Manifest archive metadata (filename, 64-hex sha256, positive sizeBytes) is missing or malformed.'
    );
  }
  const expectedArchiveFilename = `printellect-kiosk-daemon-${manifest.version}.tar.gz`;
  if (manifest.archive.filename !== expectedArchiveFilename) {
    throw new Error(
      `INVALID MANIFEST SCHEMA: archive.filename "${manifest.archive.filename}" does not match versioned filename "${expectedArchiveFilename}".`
    );
  }

  const requiredPosixSet = new Set(REQUIRED_FILES.map((r) => r.replace(/\\/g, '/')));
  const allowedArchiveFiles = new Set([...requiredPosixSet, 'release.json']);

  if (
    !manifest.sourceFiles ||
    typeof manifest.sourceFiles !== 'object' ||
    Array.isArray(manifest.sourceFiles)
  ) {
    throw new Error(
      'INVALID MANIFEST SCHEMA: Manifest lacks schemaVersion 2 per-file sourceFiles hash map.'
    );
  }
  for (const posixReq of requiredPosixSet) {
    const hash = manifest.sourceFiles[posixReq];
    if (typeof hash !== 'string' || !SHA256_RE.test(hash)) {
      throw new Error(
        `INCOMPLETE OR STALE ARCHIVE: Mandatory file "${posixReq}" is missing a valid SHA-256 digest in manifest.sourceFiles.`
      );
    }
  }
  for (const key of Object.keys(manifest.sourceFiles)) {
    if (!requiredPosixSet.has(key)) {
      throw new Error(
        `SECURITY ALERT: Manifest sourceFiles contains unexpected extra file entry: "${key}".`
      );
    }
  }

  // 3. Archive existence, byte size & SHA-256 verification (mandatory)
  const resolvedArchive =
    archiveOverride || path.join(path.dirname(manifestPath), manifest.archive.filename);
  if (!fs.existsSync(resolvedArchive)) {
    throw new Error(`Archive file not found at ${resolvedArchive}`);
  }

  const actualSizeBytes = fs.statSync(resolvedArchive).size;
  if (actualSizeBytes !== manifest.archive.sizeBytes) {
    throw new Error(
      `ARCHIVE SIZE MISMATCH for ${path.basename(resolvedArchive)}: expected ${manifest.archive.sizeBytes} bytes, got ${actualSizeBytes} bytes.`
    );
  }

  const actualArchiveHash = computeSha256(resolvedArchive);
  if (actualArchiveHash.toLowerCase() !== manifest.archive.sha256.toLowerCase()) {
    throw new Error(
      `CHECKSUM MISMATCH for ${path.basename(resolvedArchive)}: expected ${manifest.archive.sha256}, got ${actualArchiveHash}`
    );
  }

  // 4. Inspect archive tar metadata for symlinks, hardlinks, special files, path traversal, and exact file allowlist
  const verboseOutput = execFileSync('tar', ['-tvf', resolvedArchive], { encoding: 'utf8' });
  const verboseLines = verboseOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of verboseLines) {
    const typeChar = line[0];
    if (
      typeChar === 'l' ||
      typeChar === 'h' ||
      typeChar === 'c' ||
      typeChar === 'b' ||
      typeChar === 'p' ||
      typeChar === 's' ||
      /\slink to\s/i.test(line) ||
      /\s->\s/.test(line)
    ) {
      throw new Error(
        `SECURITY ALERT: Archive contains forbidden link or special file entry: "${line}"`
      );
    }
  }

  const listOutput = execFileSync('tar', ['-tzf', resolvedArchive], { encoding: 'utf8' });
  const archiveEntries = listOutput
    .split(/\r?\n/)
    .map((e) => e.trim())
    .filter(Boolean);

  const normalizedFiles = new Set();
  for (const rawEntry of archiveEntries) {
    if (
      rawEntry.startsWith('/') ||
      rawEntry.startsWith('\\') ||
      /^[A-Za-z]:/.test(rawEntry) ||
      rawEntry.includes('\\') ||
      rawEntry.includes('..')
    ) {
      throw new Error(`SECURITY ALERT: Archive contains unsafe path entry: "${rawEntry}"`);
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(rawEntry)) {
        throw new Error(`SECURITY ALERT: Archive contains forbidden file: "${rawEntry}"`);
      }
    }

    const stripped = rawEntry.replace(/^\.\//, '');
    if (!stripped || rawEntry === '.' || rawEntry === './' || stripped.endsWith('/')) {
      const dirClean = stripped.replace(/\/+$/, '') || '.';
      if (!ALLOWED_ARCHIVE_DIRS.has(dirClean)) {
        throw new Error(
          `SECURITY ALERT: Archive contains unexpected extra directory: "${rawEntry}"`
        );
      }
      continue;
    }

    if (normalizedFiles.has(stripped)) {
      throw new Error(`SECURITY ALERT: Archive contains duplicate file entry: "${stripped}"`);
    }
    if (!allowedArchiveFiles.has(stripped)) {
      throw new Error(`SECURITY ALERT: Archive contains unexpected extra file: "${stripped}"`);
    }
    normalizedFiles.add(stripped);
  }

  for (const reqFile of allowedArchiveFiles) {
    if (!normalizedFiles.has(reqFile)) {
      throw new Error(
        `INCOMPLETE OR STALE ARCHIVE: Mandatory file "${reqFile}" is missing from ${path.basename(resolvedArchive)}.`
      );
    }
  }

  // 5. Extract into an isolated 0700 temp directory and verify per-file SHA-256 digests (+ optional workspace freshness)
  const extractTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-verify-'));
  try {
    fs.chmodSync(extractTmp, 0o700);
    execFileSync('tar', ['-xzf', resolvedArchive, '-C', extractTmp], { stdio: 'pipe' });

    assertExtractedTreeHasNoLinks(extractTmp);

    const extractedReleaseJsonPath = path.join(extractTmp, 'release.json');
    if (!fs.existsSync(extractedReleaseJsonPath)) {
      throw new Error('INCOMPLETE OR STALE ARCHIVE: Extracted release.json is missing.');
    }
    let releaseMeta;
    try {
      releaseMeta = JSON.parse(fs.readFileSync(extractedReleaseJsonPath, 'utf8'));
    } catch (err) {
      throw new Error(`ARCHIVE INTEGRITY MISMATCH: Invalid release.json inside archive (${err.message}).`);
    }
    if (
      releaseMeta.version !== manifest.version ||
      releaseMeta.architecture !== manifest.architecture
    ) {
      throw new Error(
        'ARCHIVE INTEGRITY MISMATCH: Embedded release.json version/architecture differs from signed manifest.'
      );
    }

    for (const req of REQUIRED_FILES) {
      const posixReq = req.replace(/\\/g, '/');
      const recordedHash = manifest.sourceFiles[posixReq];
      const extractedFile = path.join(extractTmp, req);
      if (!fs.existsSync(extractedFile)) {
        throw new Error(`INCOMPLETE OR STALE ARCHIVE: Missing extracted file "${posixReq}".`);
      }

      const extractedHash = computeSha256(extractedFile);
      if (extractedHash.toLowerCase() !== recordedHash.toLowerCase()) {
        throw new Error(
          `ARCHIVE INTEGRITY MISMATCH: Archived "${posixReq}" (${extractedHash.slice(0, 12)}...) differs from signed manifest.sourceFiles (${recordedHash.slice(0, 12)}...).`
        );
      }

      if (checkWorkspace) {
        const wsFile = path.join(workspaceRoot, req);
        if (!fs.existsSync(wsFile)) {
          throw new Error(`Workspace file missing during freshness check: ${posixReq}`);
        }
        const currentWsHash = computeSha256(wsFile);
        if (currentWsHash.toLowerCase() !== recordedHash.toLowerCase()) {
          throw new Error(
            `STALE RELEASE DETECTED: Workspace file "${posixReq}" (${currentWsHash.slice(0, 12)}...) differs from signed manifest (${recordedHash.slice(0, 12)}...). Rebuild and re-sign dist/!`
          );
        }
      }
    }
  } finally {
    try {
      fs.rmSync(extractTmp, { recursive: true, force: true });
    } catch (_) {}
  }

  return {
    valid: true,
    version: manifest.version,
    name: manifest.name,
    architecture: manifest.architecture,
    archivePath: resolvedArchive,
    archiveSha256: actualArchiveHash,
    workspaceFresh: checkWorkspace,
    usedPinnedProductionKey,
  };
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const rawArgs = process.argv.slice(2);
  let checkWorkspace = false;
  const positional = [];

  for (const arg of rawArgs) {
    if (arg === '--check-workspace') {
      checkWorkspace = true;
    } else if (arg.startsWith('--')) {
      console.error(`❌ [VERIFICATION FAILED] Unknown option: ${arg}`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  const [manifestPath, sigPath, thirdArg, fourthArg] = positional;
  let pubKeyPath = PINNED_PUBLIC_KEY_PATH;
  let archiveOverride = null;

  if (thirdArg) {
    if (thirdArg.endsWith('.tar.gz') && !fourthArg) {
      archiveOverride = thirdArg;
    } else {
      pubKeyPath = thirdArg;
      archiveOverride = fourthArg || null;
    }
  }

  if (!manifestPath || !sigPath || positional.length > 4) {
    console.error(
      'Usage: node scripts/verify-release.js <manifest.json> <signature.sig> [publicKey.pem] [archive.tar.gz] [--check-workspace]'
    );
    process.exit(1);
  }

  try {
    const res = verifyRelease({
      manifestPath,
      sigPath,
      pubKeyPath,
      archivePath: archiveOverride || null,
      checkWorkspace,
    });

    console.log('✅ Manifest Ed25519 signature is VALID.');
    if (res.usedPinnedProductionKey) {
      console.log('✅ Trust Anchor: Pinned production public key (keys/release-key.pub.pem).');
    } else {
      console.warn(
        `⚠️  [NON-PRODUCTION KEY] Verified against unpinned custom public key (${pubKeyPath}).`
      );
    }
    console.log(`   Release: ${res.name} v${res.version} (${res.architecture})`);
    console.log(`✅ Archive SHA-256 checksum matches: ${res.archiveSha256}`);
    console.log(`✅ All ${REQUIRED_FILES.length} required files verified inside archive.`);
    if (res.workspaceFresh) {
      console.log(
        '✅ Workspace freshness check PASSED (dist/ matches current source tree byte-for-byte).'
      );
    }
    console.log('\n🎉 RELEASE VERIFICATION PASSED: Authentic and untampered release.\n');
    process.exit(0);
  } catch (err) {
    console.error(`❌ [VERIFICATION FAILED] ${err.message}`);
    process.exit(1);
  }
}
