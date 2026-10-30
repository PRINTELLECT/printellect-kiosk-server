import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildRelease, REQUIRED_FILES } from '../scripts/package-release.js';
import { verifyRelease } from '../scripts/verify-release.js';
import {
  generateEd25519KeyPair,
  signData,
  verifySignature,
  computeSha256,
} from '../scripts/crypto-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Crafts a raw 512-byte POSIX ustar archive (.tar.gz) including arbitrary raw entry names
 * and typeflags ('0'=file, '1'=hardlink, '2'=symlink) for adversarial tar header testing.
 */
function craftRawUstarTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = entry.content ? Buffer.from(entry.content) : Buffer.alloc(0);
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, Math.min(Buffer.byteLength(entry.name), 100), 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    const sizeVal = entry.typeflag === '1' || entry.typeflag === '2' ? 0 : content.length;
    header.write(`${sizeVal.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write(`${(1700000000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = (entry.typeflag || '0').charCodeAt(0);
    if (entry.linkname) {
      header.write(entry.linkname, 157, Math.min(Buffer.byteLength(entry.linkname), 100), 'utf8');
    }
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write('root', 265, 4, 'ascii');
    header.write('root', 297, 4, 'ascii');
    header.write('0000000\0', 329, 8, 'ascii');
    header.write('0000000\0', 337, 8, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    if (sizeVal > 0) {
      blocks.push(content);
      const rem = sizeVal % 512;
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

function buildValidBaseEntries() {
  const sourceFiles = {};
  const entries = [];
  for (const rel of REQUIRED_FILES) {
    const posixRel = rel.replace(/\\/g, '/');
    const buf = fs.readFileSync(path.join(ROOT_DIR, rel));
    sourceFiles[posixRel] = computeSha256(buf);
    entries.push({ name: posixRel, typeflag: '0', content: buf });
  }
  const releaseJson = Buffer.from(
    JSON.stringify(
      {
        name: 'printellect-kiosk-daemon',
        version: '1.0.0',
        architecture: 'linux-arm64',
        nodeVersionRequired: '>=24.0.0',
        sourceFiles,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  entries.push({ name: 'release.json', typeflag: '0', content: releaseJson });
  return { entries, sourceFiles };
}

function signManifestForArchive(dir, archivePath, sourceFiles, privateKey, overrides = {}) {
  const sha256 = computeSha256(archivePath);
  const sizeBytes = fs.statSync(archivePath).size;
  const manifestObj = {
    schemaVersion: 2,
    name: 'printellect-kiosk-daemon',
    version: '1.0.0',
    architecture: 'linux-arm64',
    minNodeVersion: '>=24.0.0',
    builtAt: '2026-01-01T00:00:00.000Z',
    sourceDateEpoch: 1767225600,
    commit: 'deadbeef',
    archive: {
      filename: path.basename(archivePath),
      sha256,
      sizeBytes,
    },
    sourceFiles,
    ...overrides,
  };
  const manifestJson = JSON.stringify(manifestObj, null, 2) + '\n';
  const manifestPath = path.join(dir, 'manifest.json');
  const sigPath = path.join(dir, 'manifest.json.sig');
  fs.writeFileSync(manifestPath, manifestJson);
  fs.writeFileSync(sigPath, signData(Buffer.from(manifestJson, 'utf8'), privateKey));
  return { manifestPath, sigPath };
}

describe('Release Packaging Pipeline & Reproducibility', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-pack-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should package a clean release archive and schemaVersion 2 manifest with valid checksums and sourceFiles', async () => {
    const result = await buildRelease({
      outDir: tempDir,
      version: '1.0.0',
    });

    assert.equal(result.success, true);
    assert.equal(result.version, '1.0.0');
    assert.equal(fs.existsSync(result.archivePath), true);
    assert.equal(fs.existsSync(result.manifestPath), true);
    assert.equal(fs.existsSync(result.sumsPath), true);

    const calculatedHash = computeSha256(result.archivePath);
    assert.equal(result.sha256, calculatedHash);

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.name, 'printellect-kiosk-daemon');
    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.architecture, 'linux-arm64');
    assert.equal(manifest.minNodeVersion, '>=24.0.0');
    assert.equal(manifest.archive.sha256, calculatedHash);
    assert.equal(manifest.archive.filename, 'printellect-kiosk-daemon-1.0.0.tar.gz');
    assert.ok(manifest.sourceFiles && typeof manifest.sourceFiles === 'object');

    for (const req of REQUIRED_FILES) {
      const posixReq = req.replace(/\\/g, '/');
      const expectedFileHash = computeSha256(path.join(ROOT_DIR, req));
      assert.equal(
        manifest.sourceFiles[posixReq],
        expectedFileHash,
        `manifest.sourceFiles[${posixReq}] must match workspace SHA-256`
      );
    }
  });

  it('should produce bit-for-bit identical archive and manifest SHA-256 hashes across consecutive builds', async () => {
    const out1 = path.join(tempDir, 'build1');
    const out2 = path.join(tempDir, 'build2');
    const fixedEpoch = 1767225600;

    const r1 = await buildRelease({ outDir: out1, version: '1.0.0', sourceDateEpoch: fixedEpoch });
    const r2 = await buildRelease({ outDir: out2, version: '1.0.0', sourceDateEpoch: fixedEpoch });

    assert.equal(r1.sha256, r2.sha256, 'Consecutive release tarballs must have identical SHA-256');
    assert.equal(
      computeSha256(r1.manifestPath),
      computeSha256(r2.manifestPath),
      'Consecutive manifests must have identical SHA-256'
    );
  });

  it('should include all 15 required runtime, installer, systemd, recovery, and print-gate files and exclude forbidden files', async () => {
    assert.equal(REQUIRED_FILES.length, 15, 'Expected 15 mandatory files in REQUIRED_FILES');

    const result = await buildRelease({
      outDir: tempDir,
      version: '1.0.0',
    });

    const tarOutput = execFileSync('tar', ['-tzf', result.archivePath], { encoding: 'utf8' });
    const files = tarOutput
      .split(/\r?\n/)
      .map((f) => f.replace(/^\.\//, '').trim())
      .filter(Boolean);

    const expectedRequired = [
      'index.js',
      'printer.js',
      'firebase.js',
      'config.js',
      'setup.js',
      'package.json',
      'package-lock.json',
      'release.json',
      'bin/printellect-setup',
      'systemd/printellect.service',
      'systemd/printellect-migration-recover.service',
      'scripts/install-service.sh',
      'scripts/recover-migration.sh',
      'scripts/stage-node-runtime.sh',
      'scripts/validate-legacy-node24.sh',
      'scripts/verify-print-acceptance.js',
    ];
    assert.equal(files.length, expectedRequired.length);
    for (const req of expectedRequired) {
      assert.ok(files.includes(req), `Archive should contain required file: ${req}`);
    }

    for (const file of files) {
      assert.ok(!file.endsWith('config.json'), `config.json should not be in archive`);
      assert.ok(!file.includes('.git'), `.git should not be in archive`);
      assert.ok(!file.includes('node_modules'), `node_modules should not be in archive`);
      assert.ok(!file.includes('test/'), `test files should not be in archive`);
      assert.ok(!file.endsWith('.pem'), `Key files should not be in archive`);
      assert.ok(!file.includes('.keys'), `.keys should not be in archive`);
    }
  });

  it('should sign manifest when signing key is provided and remove stale manifest.json.sig on unsigned rebuild', async () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const keyPath = path.join(tempDir, 'test-key.pem');
    fs.writeFileSync(keyPath, privateKey);

    const signedRes = await buildRelease({
      outDir: tempDir,
      version: '1.0.0',
      signingKeyPath: keyPath,
    });

    assert.equal(signedRes.isSigned, true);
    assert.ok(signedRes.sigPath);
    assert.equal(fs.existsSync(signedRes.sigPath), true);

    const manifestBuf = fs.readFileSync(signedRes.manifestPath);
    const sigBuf = fs.readFileSync(signedRes.sigPath);
    assert.equal(verifySignature(manifestBuf, sigBuf, publicKey), true);

    const unsignedRes = await buildRelease({
      outDir: tempDir,
      version: '1.0.0',
      signingKeyPath: null,
    });
    assert.equal(unsignedRes.isSigned, false);
    assert.equal(
      fs.existsSync(path.join(tempDir, 'manifest.json.sig')),
      false,
      'Stale manifest.json.sig must be deleted when rebuilding without a signing key'
    );
  });

  it('should verify workspace freshness with verifyRelease(--check-workspace) and reject stale dist/ after source changes', async () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const privPath = path.join(tempDir, 'release-key.pem');
    const pubPath = path.join(tempDir, 'release-key.pub.pem');
    fs.writeFileSync(privPath, privateKey);
    fs.writeFileSync(pubPath, publicKey);

    const distOut = path.join(tempDir, 'dist');
    const res = await buildRelease({
      outDir: distOut,
      version: '1.0.0',
      signingKeyPath: privPath,
    });

    const verified = verifyRelease({
      manifestPath: res.manifestPath,
      sigPath: res.sigPath,
      pubKeyPath: pubPath,
      checkWorkspace: true,
      workspaceRoot: ROOT_DIR,
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.workspaceFresh, true);

    const mockWs = path.join(tempDir, 'modified_workspace');
    for (const req of REQUIRED_FILES) {
      const dst = path.join(mockWs, req);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT_DIR, req), dst);
    }
    fs.appendFileSync(path.join(mockWs, 'index.js'), '\n// post-release edit\n');

    assert.throws(
      () =>
        verifyRelease({
          manifestPath: res.manifestPath,
          sigPath: res.sigPath,
          pubKeyPath: pubPath,
          checkWorkspace: true,
          workspaceRoot: mockWs,
        }),
      /STALE RELEASE DETECTED.*index\.js/
    );
  });

  it('should verify tracked keys/release-key.pub.pem matches embedded bootstrap.sh public key and repository dist/ artifacts', () => {
    const trackedPubPath = path.join(ROOT_DIR, 'keys', 'release-key.pub.pem');
    assert.equal(fs.existsSync(trackedPubPath), true, 'keys/release-key.pub.pem must exist');

    const trackedPubText = fs.readFileSync(trackedPubPath, 'utf8').trim();
    const bootstrapText = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'bootstrap.sh'), 'utf8');
    const keyMatch = bootstrapText.match(
      /DEFAULT_PUBLIC_KEY="(-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----)"/
    );
    assert.ok(keyMatch, 'DEFAULT_PUBLIC_KEY must be embedded in scripts/bootstrap.sh');
    assert.equal(
      keyMatch[1].trim(),
      trackedPubText,
      'Tracked keys/release-key.pub.pem must match DEFAULT_PUBLIC_KEY in bootstrap.sh'
    );

    const distDir = path.join(ROOT_DIR, 'dist');
    const verified = verifyRelease({
      manifestPath: path.join(distDir, 'manifest.json'),
      sigPath: path.join(distDir, 'manifest.json.sig'),
      pubKeyPath: trackedPubPath,
      checkWorkspace: true,
      workspaceRoot: ROOT_DIR,
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.workspaceFresh, true);
  });
});

describe('Adversarial Release Verification Security Matrix (All Tamper & Tar Attacks)', () => {
  let tempDir;
  let publicKey;
  let privateKey;
  let pubPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-adv-pack-'));
    ({ publicKey, privateKey } = generateEd25519KeyPair());
    pubPath = path.join(tempDir, 'pub.pem');
    fs.writeFileSync(pubPath, publicKey);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects unsigned releases and corrupted or truncated Ed25519 signatures', async () => {
    const privPath = path.join(tempDir, 'priv.pem');
    fs.writeFileSync(privPath, privateKey);
    const res = await buildRelease({ outDir: tempDir, version: '1.0.0', signingKeyPath: privPath });

    // Missing signature file (unsigned release)
    assert.throws(
      () =>
        verifyRelease({
          manifestPath: res.manifestPath,
          sigPath: path.join(tempDir, 'missing.sig'),
          pubKeyPath: pubPath,
        }),
      /Signature file not found/
    );

    // Truncated signature (32 bytes instead of 64)
    const truncatedSig = path.join(tempDir, 'truncated.sig');
    fs.writeFileSync(truncatedSig, fs.readFileSync(res.sigPath).subarray(0, 32));
    assert.throws(
      () =>
        verifyRelease({
          manifestPath: res.manifestPath,
          sigPath: truncatedSig,
          pubKeyPath: pubPath,
        }),
      /CRYPTOGRAPHIC VERIFICATION FAILED/
    );

    // Bit-flipped 64-byte signature
    const corruptedBuf = Buffer.from(fs.readFileSync(res.sigPath));
    corruptedBuf[10] ^= 0xff;
    const corruptedSig = path.join(tempDir, 'corrupted.sig');
    fs.writeFileSync(corruptedSig, corruptedBuf);
    assert.throws(
      () =>
        verifyRelease({
          manifestPath: res.manifestPath,
          sigPath: corruptedSig,
          pubKeyPath: pubPath,
        }),
      /CRYPTOGRAPHIC VERIFICATION FAILED/
    );
  });

  it('rejects tampered archive bytes and modified individual packaged files', () => {
    const { entries, sourceFiles } = buildValidBaseEntries();
    // Mutate index.js inside the archive WITHOUT updating sourceFiles['index.js'], then re-sign outer archive hash
    const tamperedEntries = entries.map((e) =>
      e.name === 'index.js'
        ? { ...e, content: Buffer.from('console.log("backdoored");\n', 'utf8') }
        : e
    );
    const archivePath = path.join(tempDir, 'printellect-kiosk-daemon-1.0.0.tar.gz');
    fs.writeFileSync(archivePath, craftRawUstarTarGz(tamperedEntries));
    const { manifestPath, sigPath } = signManifestForArchive(
      tempDir,
      archivePath,
      sourceFiles,
      privateKey
    );

    assert.throws(
      () => verifyRelease({ manifestPath, sigPath, pubKeyPath: pubPath }),
      /ARCHIVE INTEGRITY MISMATCH.*index\.js/
    );

    // Appending trailing byte to archive must fail size/checksum validation
    fs.appendFileSync(archivePath, Buffer.from([0x99]));
    assert.throws(
      () => verifyRelease({ manifestPath, sigPath, pubKeyPath: pubPath }),
      /ARCHIVE SIZE MISMATCH|CHECKSUM MISMATCH/
    );
  });

  it('rejects missing required files and unexpected extra files even when validly signed', () => {
    const { entries, sourceFiles } = buildValidBaseEntries();

    // Case A: Missing required file (scripts/recover-migration.sh omitted from archive)
    const missingEntries = entries.filter((e) => e.name !== 'scripts/recover-migration.sh');
    const missingArchive = path.join(tempDir, 'printellect-kiosk-daemon-1.0.0.tar.gz');
    fs.writeFileSync(missingArchive, craftRawUstarTarGz(missingEntries));
    const signedMissing = signManifestForArchive(
      tempDir,
      missingArchive,
      sourceFiles,
      privateKey
    );
    assert.throws(
      () =>
        verifyRelease({
          manifestPath: signedMissing.manifestPath,
          sigPath: signedMissing.sigPath,
          pubKeyPath: pubPath,
        }),
      /INCOMPLETE OR STALE ARCHIVE.*recover-migration\.sh/
    );

    // Case B: Unexpected extra file inside archive
    const extraEntries = [
      ...entries,
      { name: 'scripts/sneaky-extra.sh', typeflag: '0', content: Buffer.from('id\n') },
    ];
    fs.writeFileSync(missingArchive, craftRawUstarTarGz(extraEntries));
    const signedExtra = signManifestForArchive(tempDir, missingArchive, sourceFiles, privateKey);
    assert.throws(
      () =>
        verifyRelease({
          manifestPath: signedExtra.manifestPath,
          sigPath: signedExtra.sigPath,
          pubKeyPath: pubPath,
        }),
      /SECURITY ALERT: Archive contains unexpected extra file.*sneaky-extra\.sh/
    );
  });

  it('rejects invalid manifest schema, unsupported version/arch, and missing or malformed checksums', async () => {
    await assert.rejects(
      () => buildRelease({ outDir: tempDir, version: 'invalid-version' }),
      /Invalid release version format/
    );
    await assert.rejects(
      () => buildRelease({ outDir: tempDir, version: '0.0.0' }),
      /Invalid release version format/
    );

    const { entries, sourceFiles } = buildValidBaseEntries();
    const archivePath = path.join(tempDir, 'printellect-kiosk-daemon-1.0.0.tar.gz');
    fs.writeFileSync(archivePath, craftRawUstarTarGz(entries));

    // Invalid schemaVersion
    let signed = signManifestForArchive(tempDir, archivePath, sourceFiles, privateKey, {
      schemaVersion: 1,
    });
    assert.throws(
      () =>
        verifyRelease({
          manifestPath: signed.manifestPath,
          sigPath: signed.sigPath,
          pubKeyPath: pubPath,
        }),
      /INVALID MANIFEST SCHEMA/
    );

    // Unsupported version 0.0.0
    signed = signManifestForArchive(tempDir, archivePath, sourceFiles, privateKey, {
      version: '0.0.0',
    });
    assert.throws(
      () =>
        verifyRelease({
          manifestPath: signed.manifestPath,
          sigPath: signed.sigPath,
          pubKeyPath: pubPath,
        }),
      /UNSUPPORTED OR INVALID VERSION/
    );

    // Unsupported architecture
    signed = signManifestForArchive(tempDir, archivePath, sourceFiles, privateKey, {
      architecture: 'linux-x64',
    });
    assert.throws(
      () =>
        verifyRelease({
          manifestPath: signed.manifestPath,
          sigPath: signed.sigPath,
          pubKeyPath: pubPath,
        }),
      /UNSUPPORTED ARCHITECTURE/
    );

    // Bad/malformed SHA-256 checksum in manifest
    signed = signManifestForArchive(tempDir, archivePath, sourceFiles, privateKey, {
      archive: {
        filename: 'printellect-kiosk-daemon-1.0.0.tar.gz',
        sha256: 'not_a_64_char_sha256',
        sizeBytes: fs.statSync(archivePath).size,
      },
    });
    assert.throws(
      () =>
        verifyRelease({
          manifestPath: signed.manifestPath,
          sigPath: signed.sigPath,
          pubKeyPath: pubPath,
        }),
      /INVALID MANIFEST SCHEMA/
    );
  });

  it('rejects malicious symlinks, hardlinks, path traversal, and absolute paths inside tar archives', () => {
    const { entries, sourceFiles } = buildValidBaseEntries();
    const archivePath = path.join(tempDir, 'printellect-kiosk-daemon-1.0.0.tar.gz');

    const attacks = [
      {
        label: 'symlink escape',
        entry: { name: 'evil-symlink', typeflag: '2', linkname: '/etc/shadow' },
        expected: /SECURITY ALERT: Archive contains forbidden link/,
      },
      {
        label: 'hardlink escape',
        entry: { name: 'evil-hardlink', typeflag: '1', linkname: '/etc/passwd' },
        expected: /SECURITY ALERT: Archive contains forbidden link/,
      },
      {
        label: 'relative path traversal',
        entry: { name: '../escaped.js', typeflag: '0', content: Buffer.from('x') },
        expected: /SECURITY ALERT: Archive contains unsafe path entry/,
      },
      {
        label: 'absolute path entry',
        entry: { name: '/etc/cron.d/pwn', typeflag: '0', content: Buffer.from('x') },
        expected: /SECURITY ALERT: Archive contains unsafe path entry/,
      },
    ];

    for (const attack of attacks) {
      fs.writeFileSync(archivePath, craftRawUstarTarGz([...entries, attack.entry]));
      const { manifestPath, sigPath } = signManifestForArchive(
        tempDir,
        archivePath,
        sourceFiles,
        privateKey
      );
      assert.throws(
        () => verifyRelease({ manifestPath, sigPath, pubKeyPath: pubPath }),
        attack.expected,
        `Expected verifyRelease to block ${attack.label}`
      );
    }
  });

  it('rejects unknown CLI flags in verify-release.js and crypto-utils computeSha256 throws ENOENT on missing path', () => {
    const cliRes = spawnSync(
      process.execPath,
      [path.join(ROOT_DIR, 'scripts', 'verify-release.js'), '--bogus-flag'],
      { encoding: 'utf8' }
    );
    assert.equal(cliRes.status, 1);
    assert.match(cliRes.stderr, /Unknown option: --bogus-flag/);

    assert.throws(
      () => computeSha256(path.join(tempDir, 'nonexistent-file-12345.bin')),
      /ENOENT/
    );
  });
});

describe('Cryptographic Release Trust', () => {
  it('should successfully verify valid Ed25519 signatures', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const data = Buffer.from('Printellect Kiosk Server Release v1.0.0');

    const signature = signData(data, privateKey);
    assert.equal(signature.length, 64);

    const verified = verifySignature(data, signature, publicKey);
    assert.equal(verified, true);
  });

  it('should reject tampered data or invalid signatures', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const originalData = Buffer.from('Original Data');
    const tamperedData = Buffer.from('Tampered Data');

    const signature = signData(originalData, privateKey);
    const verified = verifySignature(tamperedData, signature, publicKey);
    assert.equal(verified, false);
  });

  it('should reject signature with wrong public key', () => {
    const keypair1 = generateEd25519KeyPair();
    const keypair2 = generateEd25519KeyPair();
    const data = Buffer.from('Release Payload');

    const signature = signData(data, keypair1.privateKey);
    const verified = verifySignature(data, signature, keypair2.publicKey);
    assert.equal(verified, false);
  });
});
