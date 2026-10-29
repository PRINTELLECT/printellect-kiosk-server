import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { buildRelease, REQUIRED_FILES } from '../scripts/package-release.js';
import { generateEd25519KeyPair, computeSha256, signData } from '../scripts/crypto-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const BOOTSTRAP_SCRIPT = 'scripts/bootstrap.sh';

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Helper to run bootstrap.sh inside Linux bash via stdin (-s) so Windows bash.exe
 * does not mangle metacharacters or multiline arguments across WSL interop.
 */
function runBootstrap(args = []) {
  const scriptLine = ['exec bash', shQuote(BOOTSTRAP_SCRIPT), ...args.map(shQuote)].join(' ') + '\n';
  return spawnSync('bash', ['-s'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    input: scriptLine,
  });
}

function toPosixRel(p) {
  return path.relative(ROOT_DIR, p).replace(/\\/g, '/');
}

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
  entries.push({
    name: 'release.json',
    typeflag: '0',
    content: Buffer.from(
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
    ),
  });
  return { entries, sourceFiles };
}

function writeSignedDist(distDir, archiveBuf, sourceFiles, privKeyPem, overrides = {}) {
  fs.mkdirSync(distDir, { recursive: true });
  const archiveName = 'printellect-kiosk-daemon-1.0.0.tar.gz';
  const archivePath = path.join(distDir, archiveName);
  fs.writeFileSync(archivePath, archiveBuf);
  const sha256 = computeSha256(archivePath);
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
      filename: archiveName,
      sha256,
      sizeBytes: fs.statSync(archivePath).size,
    },
    sourceFiles,
    ...overrides,
  };
  const manifestJson = JSON.stringify(manifestObj, null, 2) + '\n';
  fs.writeFileSync(path.join(distDir, 'manifest.json'), manifestJson);
  fs.writeFileSync(
    path.join(distDir, 'manifest.json.sig'),
    signData(Buffer.from(manifestJson, 'utf8'), privKeyPem)
  );
}

describe('Bootstrap Installer — Script Integrity and Argument Validation', () => {
  it('should pass bash shell syntax check (bash -n)', () => {
    const res = spawnSync('bash', ['-n', BOOTSTRAP_SCRIPT], { cwd: ROOT_DIR, encoding: 'utf8' });
    assert.equal(res.status, 0, `Shell syntax check failed: ${res.stderr}`);
  });

  it('should display help and exit code 0 when --help is passed', () => {
    const res = runBootstrap(['--help']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /PRINTELLECT Kiosk Server — Bootstrap Installer/);
    assert.match(res.stdout, /--session-id/);
  });

  it('should fail cleanly on missing --session-id, malformed CLI flags, or command/env injection attempts in --session-id', () => {
    const missingRes = runBootstrap([]);
    assert.equal(missingRes.status, 1);
    assert.match(missingRes.stderr, /Kiosk Session ID is required/);

    const unknownFlag = runBootstrap(['--session-id', 'valid_station', '--bogus-flag']);
    assert.equal(unknownFlag.status, 1);
    assert.match(unknownFlag.stderr, /Unknown option: --bogus-flag/);

    const missingVal = runBootstrap(['--session-id']);
    assert.equal(missingVal.status, 1);
    assert.match(missingVal.stderr, /requires a non-empty value/);

    // Reject shell command substitution and newline env injection in --session-id
    for (const badId of ['station$(id)', 'station`whoami`', 'station\nATTACK=1', 'station space', '"quoted"']) {
      const injRes = runBootstrap(['--session-id', badId, '--dry-run', '--allow-unsupported-arch']);
      assert.equal(injRes.status, 1, `Expected malformed session-id "${badId}" to fail`);
      assert.match(injRes.stderr, /Invalid --session-id format/);
    }
  });

  it('should fail when running on unsupported architecture without --allow-unsupported-arch', () => {
    if (process.arch === 'arm64') {
      return;
    }
    const res = runBootstrap(['--session-id', 'test_station', '--dry-run']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Unsupported architecture/);
  });

  it('should reject insecure http:// and unsupported ftp:///file:// --release-url by default', () => {
    const httpRes = runBootstrap([
      '--session-id', 'test_station',
      '--release-url', 'http://example.invalid/releases',
      '--dry-run',
      '--allow-unsupported-arch',
    ]);
    assert.equal(httpRes.status, 1);
    assert.match(httpRes.stderr, /Insecure HTTP release URL rejected/);

    const ftpRes = runBootstrap([
      '--session-id', 'test_station',
      '--release-url', 'ftp://example.invalid/releases',
      '--dry-run',
      '--allow-unsupported-arch',
    ]);
    assert.equal(ftpRes.status, 1);
    assert.match(ftpRes.stderr, /Unsupported release URL scheme/);
  });
});

describe('Bootstrap Installer — Dry Run, Cryptographic Authentication, Adversarial Tar Checks, and Upgrade Safety', () => {
  let tempDir;
  let relDistDir;
  let relPubkeyPath;
  let testPrivkeyPath;

  beforeEach(async () => {
    const tmpRoot = path.join(ROOT_DIR, '.dist_tmp');
    if (!fs.existsSync(tmpRoot)) {
      fs.mkdirSync(tmpRoot, { recursive: true });
    }
    tempDir = fs.mkdtempSync(path.join(tmpRoot, 'boot-test-'));

    const { publicKey, privateKey } = generateEd25519KeyPair();
    const pubPath = path.join(tempDir, 'release-key.pub.pem');
    testPrivkeyPath = path.join(tempDir, 'release-key.pem');
    fs.writeFileSync(pubPath, publicKey);
    fs.writeFileSync(testPrivkeyPath, privateKey);

    const distDir = path.join(tempDir, 'dist');
    await buildRelease({
      outDir: distDir,
      version: '1.0.0',
      signingKeyPath: testPrivkeyPath,
    });

    relDistDir = toPosixRel(distDir);
    relPubkeyPath = toPosixRel(pubPath);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('should succeed in dry-run mode without printing session credentials or mutating config/backups/services', () => {
    const installRoot = path.join(tempDir, 'mock_root');
    const existingCfgDir = path.join(installRoot, 'var', 'lib', 'printellect');
    const existingBakDir = path.join(existingCfgDir, 'backups');
    const existingSysDir = path.join(installRoot, 'etc', 'systemd', 'system');
    fs.mkdirSync(existingBakDir, { recursive: true });
    fs.mkdirSync(existingSysDir, { recursive: true });

    const origConfigJson = JSON.stringify({ bwPrinter: 'Canon_GX6100', colorPrinter: null }) + '\n';
    fs.writeFileSync(path.join(existingCfgDir, 'config.json'), origConfigJson);
    fs.writeFileSync(path.join(existingBakDir, 'kiosk-daemon.service.bak'), 'BACKUP_PAYLOAD\n');
    fs.writeFileSync(path.join(existingSysDir, 'kiosk-daemon.service'), '[Service]\nExecStart=/usr/bin/node index.js\n');

    const secretToken = 'secret_kiosk_prod_token_42';
    const res = runBootstrap([
      '--session-id', secretToken,
      '--local-release-dir', relDistDir,
      '--pubkey', relPubkeyPath,
      '--allow-untrusted-pubkey',
      '--root-dir', toPosixRel(installRoot),
      '--dry-run',
      '--allow-unsupported-arch',
    ]);

    assert.equal(res.status, 0, `Dry run failed: ${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout, /Manifest Ed25519 signature is VALID/);
    assert.match(res.stdout, /Archive SHA-256 checksum MATCHES/);
    assert.match(
      res.stdout,
      /Archive safety, per-file SHA-256 integrity, and completeness validation passed \(16 mandatory files verified\)/
    );
    assert.match(res.stdout, /DRY RUN VALIDATION SUCCEEDED/);

    assert.equal(res.stdout.includes(secretToken), false, 'Cleartext SESSION_ID leaked in stdout');
    assert.equal(res.stderr.includes(secretToken), false, 'Cleartext SESSION_ID leaked in stderr');
    assert.match(res.stdout, /sec\*\*\*\*42/);

    assert.equal(fs.readFileSync(path.join(existingCfgDir, 'config.json'), 'utf8'), origConfigJson);
    assert.equal(fs.readFileSync(path.join(existingBakDir, 'kiosk-daemon.service.bak'), 'utf8'), 'BACKUP_PAYLOAD\n');
    assert.equal(fs.existsSync(path.join(installRoot, 'opt', 'printellect', 'releases')), false);
    assert.equal(fs.existsSync(path.join(installRoot, 'etc', 'printellect', 'kiosk.env')), false);
  });

  it('should extract release, set permissions/symlinks, preserve config & backups, protect against symlink overwrite, and NOT cut over systemd services', () => {
    const installRoot = path.join(tempDir, 'real_root');
    const relRoot = toPosixRel(installRoot);
    const cfgDir = path.join(installRoot, 'var', 'lib', 'printellect');
    const bakDir = path.join(cfgDir, 'backups');
    const envDir = path.join(installRoot, 'etc', 'printellect');
    const sysDir = path.join(installRoot, 'etc', 'systemd', 'system');
    fs.mkdirSync(bakDir, { recursive: true });
    fs.mkdirSync(envDir, { recursive: true });
    fs.mkdirSync(sysDir, { recursive: true });

    const origConfigJson = JSON.stringify({ bwPrinter: 'HP_LaserJet', colorPrinter: 'Canon_GX6100' }, null, 2) + '\n';
    fs.writeFileSync(path.join(cfgDir, 'config.json'), origConfigJson);
    fs.writeFileSync(path.join(bakDir, 'preserved.bak'), 'DO_NOT_DELETE\n');

    const victimFile = path.join(installRoot, 'victim.txt');
    fs.writeFileSync(victimFile, 'UNTOUCHED_VICTIM\n');
    const symlinkRes = spawnSync('bash', ['-c', `ln -s "${toPosixRel(victimFile)}" "${relRoot}/etc/printellect/kiosk.env"`], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
    assert.equal(symlinkRes.status, 0);

    const secretToken = 'station_secret_session_8899';
    const res = runBootstrap([
      '--session-id', secretToken,
      '--local-release-dir', relDistDir,
      '--pubkey', relPubkeyPath,
      '--allow-untrusted-pubkey',
      '--root-dir', relRoot,
      '--skip-npm-ci',
      '--skip-printer-setup',
      '--allow-unsupported-arch',
    ]);

    assert.equal(res.status, 0, `Real bootstrap staging failed: ${res.stderr}\n${res.stdout}`);
    assert.equal(res.stdout.includes(secretToken), false, 'Cleartext SESSION_ID leaked in stdout');
    assert.equal(res.stderr.includes(secretToken), false, 'Cleartext SESSION_ID leaked in stderr');
    assert.match(res.stdout, /Service Cutover\s+:\s+NOT EXECUTED/);

    assert.equal(fs.readFileSync(victimFile, 'utf8'), 'UNTOUCHED_VICTIM\n');
    const checkPosix = spawnSync(
      'bash',
      [
        '-c',
        `test ! -L "${relRoot}/etc/printellect/kiosk.env" && ` +
        `test -L "${relRoot}/opt/printellect/current" && ` +
        `test -f "${relRoot}/opt/printellect/current/scripts/install-service.sh" && ` +
        `test -f "${relRoot}/opt/printellect/current/scripts/recover-migration.sh" && ` +
        `test -f "${relRoot}/opt/printellect/current/scripts/stage-node-runtime.sh" && ` +
        `test -f "${relRoot}/opt/printellect/current/scripts/validate-legacy-node24.sh" && ` +
        `test -f "${relRoot}/opt/printellect/current/scripts/verify-print-acceptance.js" && ` +
        `test -f "${relRoot}/opt/printellect/current/systemd/printellect-migration-recover.service"`,
      ],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    assert.equal(checkPosix.status, 0, `POSIX file/symlink check failed: ${checkPosix.stderr}`);

    // Verify exact POSIX file modes on native Linux ext4 (/tmp)
    const ext4Script = [
      'set -euo pipefail',
      'EXT4_ROOT="$(mktemp -d /tmp/printellect-ext4-perm.XXXXXX)"',
      'trap \'rm -rf "${EXT4_ROOT}"\' EXIT',
      'bash "$1" --session-id "$2" --local-release-dir "$3" --pubkey "$4" --allow-untrusted-pubkey --root-dir "${EXT4_ROOT}" --skip-npm-ci --skip-printer-setup --allow-unsupported-arch >/dev/null',
      'ENV_MODE="$(stat -c \'%a\' "${EXT4_ROOT}/etc/printellect/kiosk.env")"',
      'BAK_MODE="$(stat -c \'%a\' "${EXT4_ROOT}/var/lib/printellect/backups")"',
      'INST_MODE="$(stat -c \'%a\' "${EXT4_ROOT}/opt/printellect/current/scripts/install-service.sh")"',
      'REC_MODE="$(stat -c \'%a\' "${EXT4_ROOT}/opt/printellect/current/scripts/recover-migration.sh")"',
      'VAL_MODE="$(stat -c \'%a\' "${EXT4_ROOT}/opt/printellect/current/scripts/validate-legacy-node24.sh")"',
      'ACC_MODE="$(stat -c \'%a\' "${EXT4_ROOT}/opt/printellect/current/scripts/verify-print-acceptance.js")"',
      'echo "${ENV_MODE}:${BAK_MODE}:${INST_MODE}:${REC_MODE}:${VAL_MODE}:${ACC_MODE}"',
    ].join('\n');
    const ext4ModeCheck = spawnSync(
      'bash',
      ['-s', '--', BOOTSTRAP_SCRIPT, secretToken, relDistDir, relPubkeyPath],
      { cwd: ROOT_DIR, encoding: 'utf8', input: ext4Script }
    );
    assert.equal(ext4ModeCheck.status, 0, `ext4 POSIX mode verification failed: ${ext4ModeCheck.stderr}`);
    const [envMode, bakMode, instMode, recMode, valMode, accMode] = ext4ModeCheck.stdout.trim().split(':');
    assert.ok(envMode === '600' || envMode === '640', `Expected kiosk.env mode 600 or 640 on ext4, got ${envMode}`);
    assert.equal(bakMode, '700', `Expected backups dir mode 700 on ext4, got ${bakMode}`);
    assert.equal(instMode, '755', `Expected install-service.sh mode 755 on ext4, got ${instMode}`);
    assert.equal(recMode, '755', `Expected recover-migration.sh mode 755 on ext4, got ${recMode}`);
    assert.equal(valMode, '755', `Expected validate-legacy-node24.sh mode 755 on ext4, got ${valMode}`);
    assert.equal(accMode, '755', `Expected verify-print-acceptance.js mode 755 on ext4, got ${accMode}`);

    const envContents = fs.readFileSync(path.join(envDir, 'kiosk.env'), 'utf8');
    assert.match(envContents, new RegExp(`KIOSK_SESSION_ID="${secretToken}"`));

    assert.equal(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'), origConfigJson);
    assert.equal(fs.readFileSync(path.join(bakDir, 'preserved.bak'), 'utf8'), 'DO_NOT_DELETE\n');
    assert.equal(fs.existsSync(path.join(sysDir, 'printellect.service')), false);
  });

  it('should support idempotent repeat installation, version upgrade (1.0.0 -> 1.0.1), and preserve working release on interrupted download or extraction', async () => {
    const installRoot = path.join(tempDir, 'upgrade_root');
    const relRoot = toPosixRel(installRoot);
    const cfgDir = path.join(installRoot, 'var', 'lib', 'printellect');
    fs.mkdirSync(cfgDir, { recursive: true });
    const savedCfg = JSON.stringify({ bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' }) + '\n';
    fs.writeFileSync(path.join(cfgDir, 'config.json'), savedCfg);

    const commonArgs = [
      '--session-id', 'station_upgrade_01',
      '--pubkey', relPubkeyPath,
      '--allow-untrusted-pubkey',
      '--root-dir', relRoot,
      '--skip-npm-ci',
      '--skip-printer-setup',
      '--allow-unsupported-arch',
    ];

    // 1. Initial install of v1.0.0
    const r1 = runBootstrap([...commonArgs, '--local-release-dir', relDistDir]);
    assert.equal(r1.status, 0, r1.stderr);

    // 2. Repeat idempotent install of v1.0.0
    const r2 = runBootstrap([...commonArgs, '--local-release-dir', relDistDir]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'), savedCfg);

    // 3. Interrupted download while v1.0.0 is active (unreachable HTTPS endpoint)
    const failedDl = runBootstrap([
      ...commonArgs,
      '--release-url', 'https://127.0.0.1:1/unreachable-release',
    ]);
    assert.equal(failedDl.status, 1);
    assert.equal(
      fs.existsSync(path.join(installRoot, 'opt', 'printellect', 'releases', '1.0.0', 'index.js')),
      true,
      'Previous v1.0.0 release must remain intact after interrupted download'
    );

    // 4. Interrupted / corrupted archive during upgrade to v1.0.1 must leave v1.0.0 active
    const corruptDist = path.join(tempDir, 'corrupt_101');
    await buildRelease({
      outDir: corruptDist,
      version: '1.0.1',
      signingKeyPath: testPrivkeyPath,
    });
    // Corrupt the tar.gz bytes after signing
    fs.writeFileSync(
      path.join(corruptDist, 'printellect-kiosk-daemon-1.0.1.tar.gz'),
      Buffer.from('corrupted_truncated_stream')
    );

    const failedExtract = runBootstrap([
      ...commonArgs,
      '--local-release-dir', toPosixRel(corruptDist),
    ]);
    assert.equal(failedExtract.status, 1);

    const checkSymlinkStill100 = spawnSync(
      'bash',
      ['-c', `readlink "${relRoot}/opt/printellect/current"`],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    assert.equal(checkSymlinkStill100.stdout.trim(), 'releases/1.0.0');
    assert.equal(fs.existsSync(path.join(installRoot, 'opt', 'printellect', 'releases', '1.0.1')), false);

    // 5. Valid upgrade from v1.0.0 to v1.0.1 updates current symlink and preserves config.json & v1.0.0 rollback dir
    const valid101Dist = path.join(tempDir, 'valid_101');
    await buildRelease({
      outDir: valid101Dist,
      version: '1.0.1',
      signingKeyPath: testPrivkeyPath,
    });
    const okUpgrade = runBootstrap([
      ...commonArgs,
      '--local-release-dir', toPosixRel(valid101Dist),
    ]);
    assert.equal(okUpgrade.status, 0, okUpgrade.stderr);

    const checkSymlink101 = spawnSync(
      'bash',
      ['-c', `readlink "${relRoot}/opt/printellect/current"`],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    assert.equal(checkSymlink101.stdout.trim(), 'releases/1.0.1');
    assert.equal(fs.existsSync(path.join(installRoot, 'opt', 'printellect', 'releases', '1.0.0', 'index.js')), true);
    assert.equal(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'), savedCfg);
  });

  it('should reject wrong public key, unsigned release, corrupted signature, tampered checksum, and tampered manifest', () => {
    const differentKey = generateEd25519KeyPair();
    const untrustedPubkey = path.join(tempDir, 'untrusted.pub.pem');
    fs.writeFileSync(untrustedPubkey, differentKey.publicKey);

    // Wrong public key (even with --allow-untrusted-pubkey, signature mismatch is rejected)
    let res = runBootstrap([
      '--session-id', 'kiosk_station_01',
      '--local-release-dir', relDistDir,
      '--pubkey', toPosixRel(untrustedPubkey),
      '--allow-untrusted-pubkey',
      '--dry-run',
      '--allow-unsupported-arch',
    ]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /CRYPTOGRAPHIC VERIFICATION FAILED/);

    // Truncated signature
    const sigFile = path.join(ROOT_DIR, relDistDir, 'manifest.json.sig');
    const origSig = fs.readFileSync(sigFile);
    fs.writeFileSync(sigFile, origSig.subarray(0, 20));
    res = runBootstrap([
      '--session-id', 'kiosk_station_01',
      '--local-release-dir', relDistDir,
      '--pubkey', relPubkeyPath,
      '--allow-untrusted-pubkey',
      '--dry-run',
      '--allow-unsupported-arch',
    ]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /CRYPTOGRAPHIC VERIFICATION FAILED/);

    // Unsigned release (missing manifest.json.sig)
    fs.unlinkSync(sigFile);
    res = runBootstrap([
      '--session-id', 'kiosk_station_01',
      '--local-release-dir', relDistDir,
      '--pubkey', relPubkeyPath,
      '--allow-untrusted-pubkey',
      '--dry-run',
      '--allow-unsupported-arch',
    ]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /manifest\.json\.sig not found/);

    // Restore signature, tamper manifest
    fs.writeFileSync(sigFile, origSig);
    const manifestPath = path.join(ROOT_DIR, relDistDir, 'manifest.json');
    const origManifest = fs.readFileSync(manifestPath);
    const parsed = JSON.parse(origManifest.toString('utf8'));
    parsed.version = '9.9.9';
    fs.writeFileSync(manifestPath, JSON.stringify(parsed, null, 2) + '\n');
    res = runBootstrap([
      '--session-id', 'kiosk_station_01',
      '--local-release-dir', relDistDir,
      '--pubkey', relPubkeyPath,
      '--allow-untrusted-pubkey',
      '--dry-run',
      '--allow-unsupported-arch',
    ]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /CRYPTOGRAPHIC VERIFICATION FAILED/);

    // Restore manifest, corrupt archive byte (same size -> CHECKSUM MISMATCH)
    fs.writeFileSync(manifestPath, origManifest);
    const archivePath = path.join(ROOT_DIR, relDistDir, 'printellect-kiosk-daemon-1.0.0.tar.gz');
    const archiveBuf = fs.readFileSync(archivePath);
    archiveBuf[archiveBuf.length - 5] ^= 0xff;
    fs.writeFileSync(archivePath, archiveBuf);
    res = runBootstrap([
      '--session-id', 'kiosk_station_01',
      '--local-release-dir', relDistDir,
      '--pubkey', relPubkeyPath,
      '--allow-untrusted-pubkey',
      '--dry-run',
      '--allow-unsupported-arch',
    ]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /CHECKSUM MISMATCH/);
  });

  it('should reject modified packaged file, extra file, missing file, invalid schema/version/checksum, symlinks, hardlinks, traversal, and absolute paths', () => {
    const privPem = fs.readFileSync(testPrivkeyPath, 'utf8');
    const { entries, sourceFiles } = buildValidBaseEntries();
    const advDir = path.join(tempDir, 'adv_dist');
    const relAdv = toPosixRel(advDir);

    const runAdv = () =>
      runBootstrap([
        '--session-id', 'kiosk_station_01',
        '--local-release-dir', relAdv,
        '--pubkey', relPubkeyPath,
        '--allow-untrusted-pubkey',
        '--dry-run',
        '--allow-unsupported-arch',
      ]);

    // 1. Modified individual packaged file (outer archive re-signed, inner index.js differs from sourceFiles)
    writeSignedDist(
      advDir,
      craftRawUstarTarGz(
        entries.map((e) => (e.name === 'index.js' ? { ...e, content: Buffer.from('evil();\n') } : e))
      ),
      sourceFiles,
      privPem
    );
    let res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ARCHIVE INTEGRITY MISMATCH/);

    // 2. Unexpected extra file
    writeSignedDist(
      advDir,
      craftRawUstarTarGz([...entries, { name: 'extra-rogue.js', typeflag: '0', content: Buffer.from('1') }]),
      sourceFiles,
      privPem
    );
    res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /SECURITY ALERT: Archive contains unexpected extra file/);

    // 3. Forbidden file (.env.secret)
    writeSignedDist(
      advDir,
      craftRawUstarTarGz([...entries, { name: '.env.secret', typeflag: '0', content: Buffer.from('SECRET=1') }]),
      sourceFiles,
      privPem
    );
    res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /SECURITY ALERT: Archive contains forbidden file/);

    // 4. Missing required file (scripts/recover-migration.sh)
    writeSignedDist(
      advDir,
      craftRawUstarTarGz(entries.filter((e) => e.name !== 'scripts/recover-migration.sh')),
      sourceFiles,
      privPem
    );
    res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /INCOMPLETE RELEASE ARCHIVE/);

    // 5. Malicious symlink inside tar
    writeSignedDist(
      advDir,
      craftRawUstarTarGz([...entries, { name: 'bad-link', typeflag: '2', linkname: '/etc/shadow' }]),
      sourceFiles,
      privPem
    );
    res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /SECURITY ALERT: Archive contains forbidden link/);

    // 6. Malicious hardlink inside tar
    writeSignedDist(
      advDir,
      craftRawUstarTarGz([...entries, { name: 'bad-hlink', typeflag: '1', linkname: '/etc/passwd' }]),
      sourceFiles,
      privPem
    );
    res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /SECURITY ALERT: Archive contains forbidden link/);

    // 7. Path traversal inside tar
    writeSignedDist(
      advDir,
      craftRawUstarTarGz([...entries, { name: '../escape.sh', typeflag: '0', content: Buffer.from('x') }]),
      sourceFiles,
      privPem
    );
    res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /SECURITY ALERT: Archive contains unsafe path entry/);

    // 8. Absolute path inside tar
    writeSignedDist(
      advDir,
      craftRawUstarTarGz([...entries, { name: '/etc/pwn.sh', typeflag: '0', content: Buffer.from('x') }]),
      sourceFiles,
      privPem
    );
    res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /SECURITY ALERT: Archive contains unsafe path entry/);

    // 9. Invalid manifest schema (schemaVersion: 1)
    writeSignedDist(advDir, craftRawUstarTarGz(entries), sourceFiles, privPem, { schemaVersion: 1 });
    res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /INVALID MANIFEST SCHEMA|Manifest schema validation failed/);

    // 10. Unsupported version (0.0.0) and bad checksum in manifest
    writeSignedDist(advDir, craftRawUstarTarGz(entries), sourceFiles, privPem, { version: '0.0.0' });
    res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /UNSUPPORTED OR INVALID VERSION|Manifest schema validation failed/);

    writeSignedDist(advDir, craftRawUstarTarGz(entries), sourceFiles, privPem, {
      archive: { filename: 'printellect-kiosk-daemon-1.0.0.tar.gz', sha256: 'bad_hex', sizeBytes: 100 },
    });
    res = runAdv();
    assert.equal(res.status, 1);
    assert.match(res.stderr, /INVALID MANIFEST SCHEMA|Manifest schema validation failed/);
  });

  it('should enforce pinned production trust anchor by default, block unpinned --pubkey overrides without --allow-untrusted-pubkey, and never mutate production state on invalid releases', () => {
    const prodRoot = path.join(tempDir, 'prod_state_guard');
    const relProdRoot = toPosixRel(prodRoot);
    const cfgDir = path.join(prodRoot, 'var', 'lib', 'printellect');
    const bakDir = path.join(cfgDir, 'backups');
    const envDir = path.join(prodRoot, 'etc', 'printellect');
    fs.mkdirSync(bakDir, { recursive: true });
    fs.mkdirSync(envDir, { recursive: true });

    const sentinelCfg = '{"bwPrinter":"Canon_GX6100","colorPrinter":"Canon_GX6100"}\n';
    const sentinelEnv = 'KIOSK_SESSION_ID="existing_live_session"\n';
    const sentinelBak = 'EXISTING_UNIT_BACKUP\n';
    fs.writeFileSync(path.join(cfgDir, 'config.json'), sentinelCfg);
    fs.writeFileSync(path.join(envDir, 'kiosk.env'), sentinelEnv);
    fs.writeFileSync(path.join(bakDir, 'legacy.service.bak'), sentinelBak);

    const assertProdStateUntouched = () => {
      assert.equal(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'), sentinelCfg);
      assert.equal(fs.readFileSync(path.join(envDir, 'kiosk.env'), 'utf8'), sentinelEnv);
      assert.equal(fs.readFileSync(path.join(bakDir, 'legacy.service.bak'), 'utf8'), sentinelBak);
      assert.equal(fs.existsSync(path.join(prodRoot, 'opt', 'printellect', 'current')), false);
      assert.equal(fs.existsSync(path.join(prodRoot, 'opt', 'printellect', 'releases')), false);
    };

    // 1. Co-downloaded / attacker --pubkey WITHOUT --allow-untrusted-pubkey MUST fail closed before state changes
    const bypassAttempt = runBootstrap([
      '--session-id', 'attacker_session_01',
      '--local-release-dir', relDistDir,
      '--pubkey', relPubkeyPath,
      '--root-dir', relProdRoot,
      '--skip-npm-ci',
      '--skip-printer-setup',
      '--allow-unsupported-arch',
    ]);
    assert.equal(bypassAttempt.status, 1);
    assert.match(bypassAttempt.stderr, /TRUST ANCHOR VIOLATION/);
    assertProdStateUntouched();

    // 2. Default production invocation (NO --pubkey) MUST reject ephemeral/attacker-signed release before state changes
    const wrongSignerNoFlag = runBootstrap([
      '--session-id', 'prod_station_01',
      '--local-release-dir', relDistDir,
      '--root-dir', relProdRoot,
      '--skip-npm-ci',
      '--skip-printer-setup',
      '--allow-unsupported-arch',
    ]);
    assert.equal(wrongSignerNoFlag.status, 1);
    assert.match(wrongSignerNoFlag.stderr, /CRYPTOGRAPHIC VERIFICATION FAILED/);
    assertProdStateUntouched();

    // 3. Modified extracted file in non-dry-run mode MUST fail closed before mutating production state
    const privPem = fs.readFileSync(testPrivkeyPath, 'utf8');
    const { entries, sourceFiles } = buildValidBaseEntries();
    const tamperedExtractDir = path.join(tempDir, 'tampered_extract_dist');
    writeSignedDist(
      tamperedExtractDir,
      craftRawUstarTarGz(
        entries.map((e) => (e.name === 'printer.js' ? { ...e, content: Buffer.from('// tampered\n') } : e))
      ),
      sourceFiles,
      privPem
    );
    const tamperedExtractRun = runBootstrap([
      '--session-id', 'prod_station_01',
      '--local-release-dir', toPosixRel(tamperedExtractDir),
      '--pubkey', relPubkeyPath,
      '--allow-untrusted-pubkey',
      '--root-dir', relProdRoot,
      '--skip-npm-ci',
      '--skip-printer-setup',
      '--allow-unsupported-arch',
    ]);
    assert.equal(tamperedExtractRun.status, 1);
    assert.match(tamperedExtractRun.stderr, /ARCHIVE INTEGRITY MISMATCH/);
    assertProdStateUntouched();

    // 4. Default production invocation (NO --pubkey) against repository's production-signed dist/ MUST succeed
    const prodSignedRun = runBootstrap([
      '--session-id', 'prod_station_01',
      '--local-release-dir', 'dist',
      '--root-dir', relProdRoot,
      '--skip-npm-ci',
      '--skip-printer-setup',
      '--allow-unsupported-arch',
    ]);
    assert.equal(prodSignedRun.status, 0, `Expected pinned prod dist/ verification to pass: ${prodSignedRun.stderr}`);
    assert.match(prodSignedRun.stdout, /Using pinned official production public key/);
    assert.equal(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'), sentinelCfg);
    assert.equal(fs.readFileSync(path.join(bakDir, 'legacy.service.bak'), 'utf8'), sentinelBak);
    assert.equal(fs.existsSync(path.join(prodRoot, 'opt', 'printellect', 'current', 'index.js')), true);
  });
});
