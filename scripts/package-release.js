#!/usr/bin/env node

/**
 * PRINTELLECT Kiosk Server — Deterministic Release Packaging Script
 *
 * Packages production source files into a reproducible, versioned Linux ARM64
 * POSIX ustar (.tar.gz) release archive with normalized timestamps/permissions
 * and per-file SHA-256 provenance hashes (manifest schemaVersion 2).
 *
 * Usage:
 *   node scripts/package-release.js [--version <version>] [--key <path_to_private_key>] [--out-dir <dist>] [--source-date-epoch <epoch>]
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { computeSha256, signData } from './crypto-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// Mandatory source files that must be included in every production release (15 files + release.json = 16 archive entries)
export const REQUIRED_FILES = [
  'index.js',
  'printer.js',
  'firebase.js',
  'config.js',
  'setup.js',
  'package.json',
  'package-lock.json',
  path.join('bin', 'printellect-setup'),
  path.join('systemd', 'printellect.service'),
  path.join('systemd', 'printellect-migration-recover.service'),
  path.join('scripts', 'install-service.sh'),
  path.join('scripts', 'recover-migration.sh'),
  path.join('scripts', 'stage-node-runtime.sh'),
  path.join('scripts', 'validate-legacy-node24.sh'),
  path.join('scripts', 'verify-print-acceptance.js'),
];

// Archive entries that must receive executable 0755 permissions inside the POSIX ustar archive
export const EXECUTABLE_ARCHIVE_PATHS = new Set([
  'bin/printellect-setup',
  'scripts/install-service.sh',
  'scripts/recover-migration.sh',
  'scripts/stage-node-runtime.sh',
  'scripts/validate-legacy-node24.sh',
  'scripts/verify-print-acceptance.js',
]);

// Files that MUST NEVER be included in any release package
export const FORBIDDEN_PATTERNS = [
  /config\.json$/,
  /\.env.*/i,
  /\.git/i,
  /node_modules/i,
  /(^|\/)test(\/|$)/i,
  /\.pem$/i,
  /\.keys/i,
  /\.bak/i,
];

/**
 * Parses CLI arguments strictly.
 */
function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    version: null,
    signingKeyPath: process.env.PRINTELLECT_SIGNING_KEY || null,
    outDir: path.join(ROOT_DIR, 'dist'),
    sourceDateEpoch: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version') {
      if (!argv[i + 1]) throw new Error('Option --version requires a value.');
      options.version = argv[++i];
    } else if (arg === '--key') {
      if (!argv[i + 1]) throw new Error('Option --key requires a value.');
      options.signingKeyPath = path.resolve(argv[++i]);
    } else if (arg === '--out-dir') {
      if (!argv[i + 1]) throw new Error('Option --out-dir requires a value.');
      options.outDir = path.resolve(argv[++i]);
    } else if (arg === '--source-date-epoch') {
      if (!argv[i + 1]) throw new Error('Option --source-date-epoch requires an integer value.');
      options.sourceDateEpoch = Number(argv[++i]);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

/**
 * Gets git commit hash if available.
 */
function getGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
  } catch (_) {
    return 'unknown';
  }
}

/**
 * Resolves deterministic Unix epoch seconds (SOURCE_DATE_EPOCH -> git HEAD commit timestamp -> current time).
 */
export function resolveSourceDateEpoch(explicitEpoch = null) {
  if (explicitEpoch !== null && explicitEpoch !== undefined) {
    const parsed = Number(explicitEpoch);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`Invalid sourceDateEpoch: "${explicitEpoch}". Expected non-negative integer.`);
    }
    return parsed;
  }

  if (process.env.SOURCE_DATE_EPOCH !== undefined && process.env.SOURCE_DATE_EPOCH !== '') {
    const parsed = Number(process.env.SOURCE_DATE_EPOCH);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `Invalid SOURCE_DATE_EPOCH="${process.env.SOURCE_DATE_EPOCH}". Expected non-negative integer.`
      );
    }
    return parsed;
  }

  try {
    const raw = execFileSync('git', ['log', '-1', '--format=%ct'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    }).trim();
    const gitEpoch = Number(raw);
    if (Number.isInteger(gitEpoch) && gitEpoch >= 0) {
      return gitEpoch;
    }
  } catch (_) {}

  return Math.floor(Date.now() / 1000);
}

/**
 * Builds a single 512-byte POSIX.1-1988 ustar header block for a regular file.
 */
function createUstarFileHeader(posixPath, sizeBytes, mode, mtimeEpoch) {
  if (posixPath.startsWith('/') || posixPath.includes('\\') || posixPath.includes('..')) {
    throw new Error(`Unsafe archive entry path rejected: "${posixPath}"`);
  }

  let name = posixPath;
  let prefix = '';
  if (Buffer.byteLength(posixPath, 'utf8') > 100) {
    const slashIdx = posixPath.lastIndexOf('/');
    if (slashIdx <= 0) {
      throw new Error(`Archive entry filename exceeds POSIX ustar 100-byte limit: "${posixPath}"`);
    }
    prefix = posixPath.slice(0, slashIdx);
    name = posixPath.slice(slashIdx + 1);
    if (Buffer.byteLength(prefix, 'utf8') > 155 || Buffer.byteLength(name, 'utf8') > 100) {
      throw new Error(`Archive entry path exceeds POSIX ustar prefix+name limit: "${posixPath}"`);
    }
  }

  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Buffer.byteLength(name, 'utf8'), 'utf8');
  header.write(`${(mode & 0o7777).toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii'); // uid = 0
  header.write('0000000\0', 116, 8, 'ascii'); // gid = 0
  header.write(`${sizeBytes.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write(`${mtimeEpoch.toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  header.fill(0x20, 148, 156); // 8 spaces placeholder during checksum calculation
  header[156] = 0x30; // typeflag '0' (regular file)
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 4, 'ascii');
  header.write('root', 297, 4, 'ascii');
  header.write('0000000\0', 329, 8, 'ascii');
  header.write('0000000\0', 337, 8, 'ascii');
  if (prefix) {
    header.write(prefix, 345, Buffer.byteLength(prefix, 'utf8'), 'utf8');
  }

  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/**
 * Creates a deterministic, cross-platform reproducible .tar.gz Buffer from sorted file entries.
 * @param {Array<{ posixPath: string, content: Buffer, mode: number }>} entries
 * @param {number} sourceDateEpoch
 * @returns {Buffer}
 */
export function createDeterministicTarGz(entries, sourceDateEpoch) {
  const sorted = [...entries].sort((a, b) =>
    a.posixPath < b.posixPath ? -1 : a.posixPath > b.posixPath ? 1 : 0
  );

  const blocks = [];
  for (const item of sorted) {
    const header = createUstarFileHeader(
      item.posixPath,
      item.content.length,
      item.mode,
      sourceDateEpoch
    );
    blocks.push(header);
    if (item.content.length > 0) {
      blocks.push(item.content);
      const remainder = item.content.length % 512;
      if (remainder !== 0) {
        blocks.push(Buffer.alloc(512 - remainder, 0));
      }
    }
  }
  // Standard POSIX tar end-of-archive marker: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024, 0));

  const tarBuffer = Buffer.concat(blocks);
  const gzBuffer = zlib.gzipSync(tarBuffer, { level: 9 });

  // Normalize RFC 1952 10-byte gzip header: zero MTIME (bytes 4..7) and set OS=Unix (byte 9 = 0x03)
  if (gzBuffer.length >= 10 && gzBuffer[0] === 0x1f && gzBuffer[1] === 0x8b && (gzBuffer[3] & 0x02) === 0) {
    gzBuffer[4] = 0;
    gzBuffer[5] = 0;
    gzBuffer[6] = 0;
    gzBuffer[7] = 0;
    gzBuffer[9] = 0x03;
  }

  return gzBuffer;
}

/**
 * Packages the release deterministically.
 */
export async function buildRelease(opts = {}) {
  const defaults = {
    version: null,
    signingKeyPath: process.env.PRINTELLECT_SIGNING_KEY || null,
    outDir: path.join(ROOT_DIR, 'dist'),
    sourceDateEpoch: null,
  };
  const options = { ...defaults, ...opts };

  console.log('\n======================================================');
  console.log('   PRINTELLECT KIOSK DAEMON — RELEASE PACKAGER        ');
  console.log('======================================================\n');

  // 1. Authoritative version resolution
  const packageJsonPath = path.join(ROOT_DIR, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = options.version || pkg.version;

  if (
    !version ||
    typeof version !== 'string' ||
    version === '0.0.0' ||
    !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(version)
  ) {
    throw new Error(
      `Invalid release version format: "${version}". Expected non-zero SemVer (e.g. 1.0.0).`
    );
  }

  const sourceDateEpoch = resolveSourceDateEpoch(options.sourceDateEpoch);
  const builtAt = new Date(sourceDateEpoch * 1000).toISOString();
  const commit = getGitCommit();

  console.log(`Release Version : v${version}`);
  console.log(`Target System   : Linux ARM64 (Debian / Raspberry Pi OS)`);
  console.log(`Build Timestamp : ${builtAt} (epoch ${sourceDateEpoch})`);
  console.log(`Output Directory: ${options.outDir}`);

  // 2. Validate all required source files exist and collect deterministic file buffers + hashes
  console.log('\nVerifying required release source files...');
  const unsortedHashes = {};
  const archiveInputs = [];

  for (const relPath of REQUIRED_FILES) {
    const fullPath = path.join(ROOT_DIR, relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Mandatory release file missing: ${relPath}`);
    }
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Mandatory release file must be a regular non-symlink file: ${relPath}`);
    }
    const content = fs.readFileSync(fullPath);
    const posixRel = relPath.replace(/\\/g, '/');
    unsortedHashes[posixRel] = computeSha256(content);
    archiveInputs.push({
      posixPath: posixRel,
      content,
      mode: EXECUTABLE_ARCHIVE_PATHS.has(posixRel) ? 0o755 : 0o644,
    });
    console.log(`  ✓ ${posixRel}`);
  }

  const sourceFiles = {};
  for (const key of Object.keys(unsortedHashes).sort()) {
    sourceFiles[key] = unsortedHashes[key];
  }

  // 3. Embed deterministic release.json metadata inside archive
  const releaseMeta = {
    name: pkg.name || 'printellect-kiosk-daemon',
    version,
    architecture: 'linux-arm64',
    builtAt,
    sourceDateEpoch,
    commit,
    nodeVersionRequired: '>=24.0.0',
    sourceFiles,
  };
  const releaseJsonBuf = Buffer.from(JSON.stringify(releaseMeta, null, 2) + '\n', 'utf8');
  archiveInputs.push({
    posixPath: 'release.json',
    content: releaseJsonBuf,
    mode: 0o644,
  });

  // 4. Create output directory and write deterministic tar.gz archive
  if (!fs.existsSync(options.outDir)) {
    fs.mkdirSync(options.outDir, { recursive: true });
  }

  const archiveFilename = `printellect-kiosk-daemon-${version}.tar.gz`;
  const archivePath = path.join(options.outDir, archiveFilename);

  console.log(`\nCreating deterministic release archive: ${archiveFilename}...`);
  const archiveGzBuffer = createDeterministicTarGz(archiveInputs, sourceDateEpoch);
  fs.writeFileSync(archivePath, archiveGzBuffer);

  const archiveSize = fs.statSync(archivePath).size;
  console.log(`  ✓ Archive size: ${(archiveSize / 1024).toFixed(2)} KB (${archiveSize} bytes)`);

  // 5. Validate archive contents defensively using system tar
  console.log('\nValidating archive contents and security boundaries...');
  const listOutput = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  const archiveFiles = listOutput
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean);

  for (const entry of archiveFiles) {
    if (entry.startsWith('/') || entry.startsWith('\\') || entry.includes('..')) {
      throw new Error(`SECURITY ALERT: Archive contains unsafe path traversal entry: "${entry}"`);
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(entry)) {
        throw new Error(
          `SECURITY ALERT: Archive contains forbidden development or secret file: "${entry}"`
        );
      }
    }
  }

  for (const req of REQUIRED_FILES) {
    const normalizedReq = req.replace(/\\/g, '/');
    const found = archiveFiles.some((f) => f.replace(/^\.\//, '') === normalizedReq);
    if (!found) {
      throw new Error(`Archive validation failed: missing expected file "${req}" inside tar.`);
    }
  }
  if (!archiveFiles.some((f) => f.replace(/^\.\//, '') === 'release.json')) {
    throw new Error('Archive validation failed: missing release.json inside tar.');
  }
  if (archiveFiles.length !== REQUIRED_FILES.length + 1) {
    throw new Error(
      `Archive validation failed: expected ${REQUIRED_FILES.length + 1} entries, got ${archiveFiles.length}.`
    );
  }
  console.log(
    `  ✓ All ${REQUIRED_FILES.length} required modules and release.json verified inside archive.`
  );
  console.log('  ✓ No credentials, symlinks, local configs, or test files detected.');

  // 6. Compute SHA-256 Checksum
  const sha256 = computeSha256(archivePath);
  console.log(`  ✓ SHA-256: ${sha256}`);

  const sumsPath = path.join(options.outDir, 'SHA256SUMS');
  fs.writeFileSync(sumsPath, `${sha256}  ${archiveFilename}\n`);

  // 7. Generate Release Manifest (schemaVersion 2 with deterministic timestamps and sourceFiles map)
  const manifest = {
    schemaVersion: 2,
    name: pkg.name || 'printellect-kiosk-daemon',
    version,
    architecture: 'linux-arm64',
    minNodeVersion: '>=24.0.0',
    builtAt,
    sourceDateEpoch,
    commit,
    archive: {
      filename: archiveFilename,
      sha256,
      sizeBytes: archiveSize,
    },
    sourceFiles,
  };

  const manifestPath = path.join(options.outDir, 'manifest.json');
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(manifestPath, manifestJson);
  console.log(`  ✓ Generated manifest: ${path.basename(manifestPath)}`);

  // 8. Sign manifest if key provided; otherwise remove any stale signature file!
  const sigPath = path.join(options.outDir, 'manifest.json.sig');
  let isSigned = false;

  if (options.signingKeyPath) {
    if (!fs.existsSync(options.signingKeyPath)) {
      throw new Error(`Signing key not found at ${options.signingKeyPath}`);
    }
    console.log(`\nSigning release manifest with Ed25519 key: ${options.signingKeyPath}...`);
    const privKey = fs.readFileSync(options.signingKeyPath, 'utf8');
    const sig = signData(Buffer.from(manifestJson, 'utf8'), privKey);
    fs.writeFileSync(sigPath, sig);
    isSigned = true;
    console.log(`  ✓ Cryptographic signature written: ${path.basename(sigPath)} (${sig.length} bytes)`);
  } else {
    if (fs.existsSync(sigPath)) {
      fs.unlinkSync(sigPath);
    }
    console.log('\n⚠️  [DEVELOPMENT NOTICE] No signing key provided.');
    console.log(
      '   Release generated without cryptographic signature (any stale manifest.json.sig was removed).'
    );
    console.log(
      '   To sign for production, provide --key <release-key.pem> or set PRINTELLECT_SIGNING_KEY.'
    );
  }

  console.log('\n======================================================');
  console.log('   RELEASE PACKAGING COMPLETED SUCCESSFULLY          ');
  console.log('======================================================');
  console.log(`Archive   : ${archivePath}`);
  console.log(`Manifest  : ${manifestPath}`);
  console.log(`Checksums : ${sumsPath}`);
  if (isSigned) {
    console.log(`Signature : ${sigPath}`);
  }
  console.log('======================================================\n');

  return {
    success: true,
    version,
    builtAt,
    sourceDateEpoch,
    archivePath,
    manifestPath,
    sumsPath,
    sigPath: isSigned ? sigPath : null,
    sha256,
    sourceFiles,
    isSigned,
  };
}

// CLI entrypoint
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  Promise.resolve()
    .then(() => buildRelease(parseArgs()))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\n[FATAL PACKAGING ERROR] ${err.message}\n`);
      process.exit(1);
    });
}
