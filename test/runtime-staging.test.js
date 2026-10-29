import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { computeSha256 } from '../scripts/crypto-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const STAGE_SCRIPT = 'scripts/stage-node-runtime.sh';
const VALIDATE_LEGACY_SCRIPT = 'scripts/validate-legacy-node24.sh';
const NODE24_DIR = path.dirname(process.execPath);

function toPosixRel(targetPath) {
  return path.relative(ROOT_DIR, targetPath).replace(/\\/g, '/');
}

function runStager(args = [], extraEnv = {}) {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  return spawnSync('bash', [STAGE_SCRIPT, ...args], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      [pathKey]: `${NODE24_DIR}${sep}${process.env[pathKey] || ''}`,
      ...extraEnv,
    },
  });
}

function runLegacyValidator(args = [], extraEnv = {}) {
  const relMockDir = extraEnv.PREPEND_PATH ? toPosixRel(extraEnv.PREPEND_PATH) : '';
  const mergedEnv = {
    ...process.env,
    ...extraEnv,
    PRINTELLECT_TEST_PATH_PREFIX: relMockDir,
    WSLENV: [
      process.env.WSLENV,
      'PRINTELLECT_TEST_SYSTEMD',
      'PRINTELLECT_TEST_PATH_PREFIX',
      'MOCK_CANARY_MODE',
    ]
      .filter(Boolean)
      .join(':'),
  };
  delete mergedEnv.PREPEND_PATH;

  return spawnSync('bash', [VALIDATE_LEGACY_SCRIPT, ...args], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    env: mergedEnv,
  });
}

describe('Versioned Node.js 24 Runtime Staging & Pre-Upgrade Validation', () => {
  let tempRoot;

  beforeEach(() => {
    const tmpBase = path.join(ROOT_DIR, '.dist_tmp');
    if (!fs.existsSync(tmpBase)) {
      fs.mkdirSync(tmpBase, { recursive: true });
    }
    tempRoot = fs.mkdtempSync(path.join(tmpBase, 'runtime-stage-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('should pass bash shell syntax check (bash -n)', () => {
    const res = spawnSync('bash', ['-n', STAGE_SCRIPT], { cwd: ROOT_DIR, encoding: 'utf8' });
    assert.equal(res.status, 0, `Syntax error in ${STAGE_SCRIPT}: ${res.stderr}`);
  });

  it('should reject EOL or pre-24 Node.js versions (e.g. v20.19.2)', () => {
    const res = runStager(['--version', 'v20.19.2', '--dry-run']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Node\.js >= 24 LTS is required/);
  });

  it('should reject runtime binaries inside /home or /root due to ProtectHome=true', () => {
    const relRoot = toPosixRel(tempRoot);
    const homeNodeDir = path.join(tempRoot, 'home', 'aaryan', '.nvm', 'bin');
    fs.mkdirSync(homeNodeDir, { recursive: true });
    const homeNodeBin = path.join(homeNodeDir, 'node');
    fs.writeFileSync(homeNodeBin, '#!/usr/bin/env bash\necho "v24.14.0"\n', { mode: 0o755 });

    const res = runStager([
      '--validate-only',
      '--root-dir', relRoot,
      '--node-bin', `${relRoot}/home/aaryan/.nvm/bin/node`,
    ]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ProtectHome=true/);
  });

  it('should stage a verified versioned Node.js 24 archive into isolated /opt/printellect/runtime without touching /usr/bin/node', () => {
    const relRoot = toPosixRel(tempRoot);
    const unameRes = spawnSync('bash', ['-c', 'uname -m'], { encoding: 'utf8' });
    const arch = unameRes.stdout.trim() === 'aarch64' || unameRes.stdout.trim() === 'arm64' ? 'arm64' : 'x64';
    const stem = `node-v24.14.0-linux-${arch}`;

    const buildDir = path.join(tempRoot, 'tar_build', stem, 'bin');
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'node'), '#!/usr/bin/env bash\necho "v24.14.0"\n', { mode: 0o755 });

    const archiveName = `${stem}.tar.gz`;
    const archivePath = path.join(tempRoot, archiveName);
    const tarRes = spawnSync('tar', ['-czf', toPosixRel(archivePath), '-C', toPosixRel(path.join(tempRoot, 'tar_build')), stem], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
    assert.equal(tarRes.status, 0, `tar build failed: ${tarRes.stderr}`);

    const sha256 = computeSha256(archivePath);
    const shasumsPath = path.join(tempRoot, 'SHASUMS256.txt');
    fs.writeFileSync(shasumsPath, `${sha256}  ${archiveName}\n`);

    const res = runStager([
      '--version', 'v24.14.0',
      '--tarball', toPosixRel(archivePath),
      '--shasums', toPosixRel(shasumsPath),
      '--root-dir', relRoot,
      '--allow-unsupported-arch',
    ]);

    assert.equal(res.status, 0, `Staging failed: ${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout, /SHA-256 verified/);
    assert.match(res.stdout, /Active \/usr\/bin\/node was NOT modified/);

    const stagedBin = path.join(tempRoot, 'opt', 'printellect', 'runtime', stem, 'bin', 'node');
    assert.equal(fs.existsSync(stagedBin), true, 'Staged versioned node binary must exist');

    const currentBin = path.join(tempRoot, 'opt', 'printellect', 'runtime', 'current', 'bin', 'node');
    assert.equal(fs.existsSync(currentBin), true, 'current runtime symlink/dir must resolve to bin/node');
  });

  it('should abort staging when archive SHA-256 does not match SHASUMS256.txt', () => {
    const relRoot = toPosixRel(tempRoot);
    const archivePath = path.join(tempRoot, 'node-v24.14.0-linux-x64.tar.gz');
    fs.writeFileSync(archivePath, 'tampered-payload');

    const shasumsPath = path.join(tempRoot, 'SHASUMS256.txt');
    fs.writeFileSync(
      shasumsPath,
      '0000000000000000000000000000000000000000000000000000000000000000  node-v24.14.0-linux-x64.tar.gz\n'
    );

    const res = runStager([
      '--version', 'v24.14.0',
      '--tarball', toPosixRel(archivePath),
      '--shasums', toPosixRel(shasumsPath),
      '--root-dir', relRoot,
      '--allow-unsupported-arch',
    ]);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /SHA-256 mismatch/);
  });

  it('should validate current daemon workdir under Node.js 24 and confirm zero native .node addons', () => {
    const res = runStager([
      '--validate-only',
      '--node-bin', toPosixRel(process.execPath),
      '--validate-workdir', '.',
    ]);

    assert.equal(res.status, 0, `Validation failed: ${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout, /Zero compiled native \(\.node\) addons/);
    assert.match(res.stdout, /5 JavaScript module\(s\) in \. passed Node 24 syntax check/);
  });

  it('should detect incompatible native .node addon in legacy workdir before runtime switch', () => {
    const mockLegacyDir = path.join(tempRoot, 'legacy_daemon');
    const mockAddonDir = path.join(mockLegacyDir, 'node_modules', 'legacy_native');
    fs.mkdirSync(mockAddonDir, { recursive: true });
    fs.writeFileSync(path.join(mockLegacyDir, 'index.js'), 'console.log("legacy");\n');
    fs.writeFileSync(path.join(mockAddonDir, 'binding.node'), 'NOT_A_VALID_NODE24_ELF_ADDON');

    const res = runStager([
      '--validate-only',
      '--node-bin', toPosixRel(process.execPath),
      '--validate-workdir', toPosixRel(mockLegacyDir),
    ]);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /Native addon ABI incompatibility detected under Node 24/);
    assert.match(res.stderr, /npm rebuild/);
  });
});

describe('Phase 4.4 — Gated Legacy Daemon Validation on Staged Node.js 24 (validate-legacy-node24.sh)', () => {
  let tempRoot;

  beforeEach(() => {
    const tmpBase = path.join(ROOT_DIR, '.dist_tmp');
    if (!fs.existsSync(tmpBase)) {
      fs.mkdirSync(tmpBase, { recursive: true });
    }
    tempRoot = fs.mkdtempSync(path.join(tmpBase, 'legacy-node24-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  function seedLegacyHost() {
    const relRoot = toPosixRel(tempRoot);

    // 1. Existing /usr/bin/node stays on Node v20.19.2 and MUST NEVER be modified
    const usrBinDir = path.join(tempRoot, 'usr', 'bin');
    fs.mkdirSync(usrBinDir, { recursive: true });
    const sysNodePath = path.join(usrBinDir, 'node');
    const sysNodeContent = '#!/usr/bin/env bash\necho "v20.19.2"\n';
    fs.writeFileSync(sysNodePath, sysNodeContent, { mode: 0o755 });

    // 2. Side-by-side staged Node.js 24 under /opt/printellect/runtime/current/bin/node
    const stagedBinDir = path.join(tempRoot, 'opt', 'printellect', 'runtime', 'current', 'bin');
    fs.mkdirSync(stagedBinDir, { recursive: true });
    const stagedNodePath = path.join(stagedBinDir, 'node');
    fs.writeFileSync(stagedNodePath, '#!/usr/bin/env bash\necho "v24.14.0"\n', { mode: 0o755 });

    // 3. Legacy systemd unit + admin drop-in override.conf with secret session ID
    const sysDir = path.join(tempRoot, 'etc', 'systemd', 'system');
    const dropinDir = path.join(sysDir, 'printellect-kiosk.service.d');
    fs.mkdirSync(dropinDir, { recursive: true });

    const unitPath = path.join(sysDir, 'printellect-kiosk.service');
    const unitContent = `[Unit]
Description=Legacy Printellect Kiosk Daemon
After=network-online.target cups.service

[Service]
User=aaryan
WorkingDirectory=/home/aaryan/printellect-kiosk-server
Environment=FIREBASE_ENV=prod
ExecStart=/usr/bin/node /home/aaryan/printellect-kiosk-server/index.js secret_legacy_sid_7788

[Install]
WantedBy=multi-user.target
`;
    fs.writeFileSync(unitPath, unitContent);
    const existingOverride = '[Service]\nEnvironment=CUSTOM_TIMEOUT=30\n';
    fs.writeFileSync(path.join(dropinDir, 'override.conf'), existingOverride);

    // 4. Mock systemctl + journalctl tracking concurrent listener count & canary drop-in content
    const mockBinDir = path.join(tempRoot, 'mock-bin');
    const mockStateDir = path.join(tempRoot, 'mock-state');
    fs.mkdirSync(mockBinDir, { recursive: true });
    fs.mkdirSync(mockStateDir, { recursive: true });
    fs.writeFileSync(path.join(mockStateDir, 'printellect-kiosk.service.active'), 'active');
    fs.writeFileSync(path.join(mockStateDir, 'active_listeners.count'), '1');
    fs.writeFileSync(path.join(mockStateDir, 'max_listeners.count'), '1');
    fs.writeFileSync(path.join(mockStateDir, 'commands.log'), '');

    const relState = toPosixRel(mockStateDir);
    const relDropin = toPosixRel(dropinDir);

    const systemctlSh = `#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${relState}"
DROPIN_DIR="${relDropin}"
CMD="\${1:-}"
UNIT="\${2:-}"
echo "\$*" >> "\${STATE_DIR}/commands.log"

case "\${CMD}" in
  is-active)
    st="\$(cat "\${STATE_DIR}/\${UNIT}.active" 2>/dev/null || echo "inactive")"
    echo "\${st}"
    [[ "\${st}" == "active" ]] && exit 0 || exit 3
    ;;
  restart)
    # Single-unit restart stops existing process BEFORE launching replacement (never >1 listener)
    echo "0" > "\${STATE_DIR}/active_listeners.count"
    echo "inactive" > "\${STATE_DIR}/\${UNIT}.active"
    if [[ -f "\${DROPIN_DIR}/99-printellect-node24-canary.conf" ]]; then
      cp "\${DROPIN_DIR}/99-printellect-node24-canary.conf" "\${STATE_DIR}/captured_canary.conf"
    fi
    echo "1" > "\${STATE_DIR}/active_listeners.count"
    echo "active" > "\${STATE_DIR}/\${UNIT}.active"
    ;;
  stop)
    echo "0" > "\${STATE_DIR}/active_listeners.count"
    echo "inactive" > "\${STATE_DIR}/\${UNIT}.active"
    ;;
  show)
    st="\$(cat "\${STATE_DIR}/\${UNIT}.active" 2>/dev/null || echo "inactive")"
    mode="\${MOCK_CANARY_MODE:-healthy}"
    if [[ "\${mode}" == "crash_loop" && -f "\${DROPIN_DIR}/99-printellect-node24-canary.conf" ]]; then
      printf "ActiveState=activating\\nSubState=auto-restart\\nMainPID=0\\nNRestarts=2\\nResult=exit-code\\nExecMainStatus=1\\n"
    else
      printf "ActiveState=%s\\nSubState=running\\nMainPID=5150\\nNRestarts=0\\nResult=success\\nExecMainStatus=0\\n" "\${st}"
    fi
    ;;
  daemon-reload|reset-failed)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

    const journalctlSh = `#!/usr/bin/env bash
mode="\${MOCK_CANARY_MODE:-healthy}"
if [[ "\${mode}" == "firebase_error" ]]; then
  echo "Starting Kiosk Print Daemon..."
  echo "Firebase Auth Error: auth/network-request-failed"
else
  echo "Starting Kiosk Print Daemon..."
  echo "Connected to Firebase."
  echo "Listening for print jobs (waiting for payment confirmation)..."
fi
`;
    fs.writeFileSync(path.join(mockBinDir, 'systemctl'), systemctlSh, { mode: 0o755 });
    fs.writeFileSync(path.join(mockBinDir, 'journalctl'), journalctlSh, { mode: 0o755 });

    return {
      relRoot,
      sysNodePath,
      sysNodeContent,
      stagedNodePath,
      unitPath,
      unitContent,
      dropinDir,
      existingOverride,
      mockBinDir,
      mockStateDir,
    };
  }

  it('should pass bash shell syntax check (bash -n)', () => {
    const res = spawnSync('bash', ['-n', VALIDATE_LEGACY_SCRIPT], { cwd: ROOT_DIR, encoding: 'utf8' });
    assert.equal(res.status, 0, `Syntax error in ${VALIDATE_LEGACY_SCRIPT}: ${res.stderr}`);
  });

  it('should refuse --run-validation without explicit --confirm-restart gate and reject /usr/bin/node or /home paths', () => {
    const { relRoot } = seedLegacyHost();

    // Missing --confirm-restart
    const unconfirmed = runLegacyValidator(['--run-validation', '--root-dir', relRoot]);
    assert.equal(unconfirmed.status, 1);
    assert.match(unconfirmed.stderr, /requires explicit '--confirm-restart'/);

    // Reject /usr/bin/node
    const sysNodeReject = runLegacyValidator([
      '--preflight',
      '--root-dir', relRoot,
      '--node-bin', `${relRoot}/usr/bin/node`,
    ]);
    assert.equal(sysNodeReject.status, 1);
    assert.match(sysNodeReject.stderr, /NOT \/usr\/bin\/node/);

    // Reject /home/*
    const homeReject = runLegacyValidator([
      '--preflight',
      '--root-dir', relRoot,
      '--node-bin', `${relRoot}/home/aaryan/.nvm/node`,
    ]);
    assert.equal(homeReject.status, 1);
    assert.match(homeReject.stderr, /resides under \/home or \/root/);
  });

  it('should mask KIOSK_SESSION_ID in --preflight / --dry-run and leave /usr/bin/node and service untouched', () => {
    const { relRoot, sysNodePath, sysNodeContent, dropinDir, mockStateDir } = seedLegacyHost();

    const res = runLegacyValidator(['--dry-run', '--root-dir', relRoot], {
      PRINTELLECT_TEST_SYSTEMD: '1',
      PREPEND_PATH: path.join(tempRoot, 'mock-bin'),
    });

    assert.equal(res.status, 0, `Dry-run failed: ${res.stderr}\n${res.stdout}`);
    assert.equal(res.stdout.includes('secret_legacy_sid_7788'), false, 'Cleartext session ID leaked in stdout');
    assert.equal(res.stderr.includes('secret_legacy_sid_7788'), false, 'Cleartext session ID leaked in stderr');
    assert.match(res.stdout, /sec\*\*\*\*88/);
    assert.equal(fs.readFileSync(sysNodePath, 'utf8'), sysNodeContent, '/usr/bin/node must stay untouched');
    assert.equal(fs.existsSync(path.join(dropinDir, '99-printellect-node24-canary.conf')), false);

    const cmds = fs.readFileSync(path.join(mockStateDir, 'commands.log'), 'utf8');
    assert.equal(cmds.includes('restart'), false, 'Dry-run must not restart live service');
  });

  it('should execute gated --run-validation --confirm-restart, preserve original unit context, verify clean shutdown, and deterministically restore baseline', () => {
    const {
      relRoot,
      sysNodePath,
      sysNodeContent,
      unitPath,
      unitContent,
      dropinDir,
      existingOverride,
      mockBinDir,
      mockStateDir,
    } = seedLegacyHost();

    const res = runLegacyValidator(
      [
        '--run-validation',
        '--confirm-restart',
        '--root-dir', relRoot,
        '--timeout', '4',
        '--stable-sec', '1',
      ],
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mockBinDir,
        MOCK_CANARY_MODE: 'healthy',
      }
    );

    assert.equal(res.status, 0, `Gated validation failed: ${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout, /LEGACY DAEMON STAGED NODE 24 VALIDATION PASSED/);
    assert.equal(res.stdout.includes('secret_legacy_sid_7788'), false);

    // Verify captured canary drop-in ONLY overrode ExecStart node binary while preserving session arg
    const capturedCanary = fs.readFileSync(path.join(mockStateDir, 'captured_canary.conf'), 'utf8');
    assert.match(
      capturedCanary,
      /ExecStart=\/opt\/printellect\/runtime\/current\/bin\/node \/home\/aaryan\/printellect-kiosk-server\/index\.js secret_legacy_sid_7788/
    );

    // Verify canary drop-in was deterministically removed while original unit, override.conf, and /usr/bin/node v20.19.2 remain intact
    assert.equal(fs.existsSync(path.join(dropinDir, '99-printellect-node24-canary.conf')), false);
    assert.equal(fs.readFileSync(path.join(dropinDir, 'override.conf'), 'utf8'), existingOverride);
    assert.equal(fs.readFileSync(unitPath, 'utf8'), unitContent);
    assert.equal(fs.readFileSync(sysNodePath, 'utf8'), sysNodeContent);
    assert.equal(
      fs.readFileSync(path.join(mockStateDir, 'printellect-kiosk.service.active'), 'utf8').trim(),
      'active'
    );

    const meta = JSON.parse(
      fs.readFileSync(path.join(tempRoot, 'etc', 'printellect', 'legacy-node24-validation.json'), 'utf8')
    );
    assert.equal(meta.status, 'passed_and_restored');
  });

  it('should automatically restore baseline and leave /usr/bin/node untouched when legacy daemon fails under staged Node 24, and support standalone --restore', () => {
    const { relRoot, sysNodePath, sysNodeContent, dropinDir, existingOverride, mockBinDir, mockStateDir } =
      seedLegacyHost();

    const failRes = runLegacyValidator(
      [
        '--run-validation',
        '--confirm-restart',
        '--root-dir', relRoot,
        '--timeout', '3',
        '--stable-sec', '1',
      ],
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mockBinDir,
        MOCK_CANARY_MODE: 'crash_loop',
      }
    );

    assert.equal(failRes.status, 1);
    assert.match(failRes.stderr, /failed staged Node\.js 24 validation/);
    assert.equal(fs.existsSync(path.join(dropinDir, '99-printellect-node24-canary.conf')), false);
    assert.equal(fs.readFileSync(path.join(dropinDir, 'override.conf'), 'utf8'), existingOverride);
    assert.equal(fs.readFileSync(sysNodePath, 'utf8'), sysNodeContent);
    assert.equal(
      fs.readFileSync(path.join(mockStateDir, 'printellect-kiosk.service.active'), 'utf8').trim(),
      'active'
    );

    // Plant a lingering canary override (simulating hard power loss mid-canary) and test standalone --restore
    fs.writeFileSync(
      path.join(dropinDir, '99-printellect-node24-canary.conf'),
      '[Service]\nExecStart=\nExecStart=/opt/printellect/runtime/current/bin/node index.js\n'
    );
    const restoreRes = runLegacyValidator(['--restore', '--root-dir', relRoot], {
      PRINTELLECT_TEST_SYSTEMD: '1',
      PREPEND_PATH: mockBinDir,
    });
    assert.equal(restoreRes.status, 0, `Standalone --restore failed: ${restoreRes.stderr}`);
    assert.equal(fs.existsSync(path.join(dropinDir, '99-printellect-node24-canary.conf')), false);
    assert.equal(fs.readFileSync(path.join(dropinDir, 'override.conf'), 'utf8'), existingOverride);
  });
});

describe('Phase 4.4 — Actual Daemon Code-Path Execution Under Node.js 24 Runtime', () => {
  let suiteDir;
  let lpBinDir;

  before(() => {
    assert.ok(
      Number(process.versions.node.split('.')[0]) >= 24,
      `Test suite must run on Node.js >= 24 (current: ${process.version})`
    );
    suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-daemon-n24-'));
    lpBinDir = path.join(suiteDir, 'bin');
    fs.mkdirSync(lpBinDir, { recursive: true });

    const lpRecordJs = path.join(suiteDir, 'lp-record.mjs');
    fs.writeFileSync(
      lpRecordJs,
      `import fs from 'fs';
const args = process.argv.slice(2);
if (process.env.DAEMON_LP_LOG) {
  fs.appendFileSync(process.env.DAEMON_LP_LOG, JSON.stringify(args) + '\\n');
}
process.stdout.write('request id is HP_BW-201 (1 file(s))\\n');
`,
      'utf8'
    );

    if (process.platform === 'win32') {
      const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
      const csPath = path.join(suiteDir, 'LpShim.cs');
      const exePath = path.join(lpBinDir, 'lp.exe');
      fs.writeFileSync(
        csPath,
        `using System;
using System.Diagnostics;
using System.Text;
class LpShim {
  static string Q(string a) { return a.IndexOfAny(new char[]{' ','\\t','\"'}) >= 0 ? "\\"" + a.Replace("\\"", "\\\\\\"") + "\\"" : a; }
  static int Main(string[] args) {
    var sb = new StringBuilder();
    sb.Append(Q(Environment.GetEnvironmentVariable("DAEMON_LP_JS")));
    foreach (var a in args) sb.Append(" ").Append(Q(a));
    var psi = new ProcessStartInfo(Environment.GetEnvironmentVariable("DAEMON_NODE_EXE"), sb.ToString());
    psi.UseShellExecute = false;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    using (var p = Process.Start(psi)) {
      Console.Out.Write(p.StandardOutput.ReadToEnd());
      Console.Error.Write(p.StandardError.ReadToEnd());
      p.WaitForExit();
      return p.ExitCode;
    }
  }
}
`,
        'utf8'
      );
      const cr = spawnSync(cscPath, ['/nologo', '/target:exe', `/out:${exePath}`, csPath], {
        encoding: 'utf8',
      });
      assert.equal(cr.status, 0, `csc.exe failed: ${cr.stdout}\n${cr.stderr}`);
    } else {
      fs.writeFileSync(
        path.join(lpBinDir, 'lp'),
        `#!/usr/bin/env bash\nexec "${process.execPath}" "${lpRecordJs}" "$@"\n`,
        { mode: 0o755 }
      );
    }
  });

  after(() => {
    if (suiteDir && fs.existsSync(suiteDir)) {
      try {
        fs.rmSync(suiteDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('should load real unmocked firebase.js, config.js, and printer.js modules and enforce index.js CLI/config startup guards on Node 24', async () => {
    // 1. Unmocked ESM import of production modules on Node.js 24
    const fbMod = await import('../firebase.js');
    const cfgMod = await import('../config.js');
    const prnMod = await import('../printer.js');

    assert.ok(fbMod.db && fbMod.auth, 'Real Firebase v12 SDK db and auth instances must initialize on Node 24');
    assert.equal(typeof cfgMod.loadConfig, 'function');
    assert.equal(typeof prnMod.print, 'function');

    // 2. Real subprocess execution of index.js: missing KIOSK_SESSION_ID guard
    const envNoSid = { ...process.env };
    delete envNoSid.KIOSK_SESSION_ID;
    const noSidRes = spawnSync(process.execPath, [path.join(ROOT_DIR, 'index.js')], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      env: envNoSid,
    });
    assert.equal(noSidRes.status, 1);
    assert.match(noSidRes.stderr, /\[FATAL ERROR\] Kiosk Session ID is required/);

    // 3. Real subprocess execution of index.js: invalid PRINTELLECT_CONFIG_PATH guard
    const badCfgRes = spawnSync(process.execPath, [path.join(ROOT_DIR, 'index.js'), 'station_test_24'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      env: {
        ...envNoSid,
        PRINTELLECT_CONFIG_PATH: path.join(suiteDir, 'nonexistent-config.json'),
      },
    });
    assert.equal(badCfgRes.status, 1);
    assert.match(badCfgRes.stderr, /\[FATAL CONFIG ERROR\]/);
  });

  it('should execute index.js startup, masked logging, loopback PDF fetch, CUPS job routing, Firestore completion, and clean SIGTERM shutdown on Node 24 (Firebase RPCs stubbed via node:module hook)', async () => {
    // Start a real loopback HTTP server serving a test PDF for index.js downloadFile()
    const pdfPayload = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n', 'ascii');
    const server = http.createServer((req, res) => {
      if (req.url === '/kiosk-job-1.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdfPayload.length });
        res.end(pdfPayload);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const cfgPath = path.join(suiteDir, 'daemon-config.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ bwPrinter: 'HP_BW', colorPrinter: 'Canon_Color' }, null, 2) + '\n'
      );
      const lpLogPath = path.join(suiteDir, 'daemon-lp.jsonl');
      fs.writeFileSync(lpLogPath, '');

      // Out-of-band Node 24 module.register() preload hook: stubs ONLY cloud Firebase Auth/Firestore RPCs
      // and exposes stdin trigger for SIGTERM so Windows & Linux both test index.js's real SIGTERM handler.
      const stubAuthPath = path.join(suiteDir, 'stub-firebase-auth.mjs');
      const stubFirestorePath = path.join(suiteDir, 'stub-firebase-firestore.mjs');
      const loaderHookPath = path.join(suiteDir, 'firebase-loader-hook.mjs');
      const preloadPath = path.join(suiteDir, 'firebase-preload.mjs');

      fs.writeFileSync(
        stubAuthPath,
        `export function getAuth() { return { type: 'stub-auth' }; }
export async function signInAnonymously() { return { user: { uid: 'node24-test-uid' } }; }
`,
        'utf8'
      );

      const pdfUrl = `http://127.0.0.1:${port}/kiosk-job-1.pdf`;
      fs.writeFileSync(
        stubFirestorePath,
        `export function getFirestore() { return { type: 'stub-db' }; }
export function collection(_db, p) { return { path: p }; }
export function query(...args) { return { args }; }
export function where(...args) { return { args }; }
export function doc(_db, col, id) { return { col, id }; }
export function onSnapshot(_q, onNext) {
  setTimeout(() => {
    onNext({
      docChanges: () => [{
        doc: {
          id: 'job_node24_001',
          data: () => ({ status: 'on-queue', shopid: 'shop_01' })
        }
      }]
    });
  }, 40);
  return () => { console.log('[STUB_VERIFY] FIRESTORE_UNSUBSCRIBED'); };
}
export async function getDocs() {
  return {
    empty: false,
    docs: [{
      id: 'file_01',
      data: () => ({
        'file-url': ${JSON.stringify(pdfUrl)},
        'file-name': 'node24-canary-doc.pdf',
        'color': false,
        'copies': 2,
        'fb': true,
        'total-pages': 3
      })
    }]
  };
}
export async function updateDoc(ref, payload) {
  console.log('[STUB_VERIFY] FIRESTORE_UPDATED:' + JSON.stringify({ id: ref.id, status: payload.status, trays: payload['collection-trays'] }));
}
`,
        'utf8'
      );

      fs.writeFileSync(
        loaderHookPath,
        `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'firebase/auth') {
    return { shortCircuit: true, url: ${JSON.stringify(pathToFileURL(stubAuthPath).href)} };
  }
  if (specifier === 'firebase/firestore') {
    return { shortCircuit: true, url: ${JSON.stringify(pathToFileURL(stubFirestorePath).href)} };
  }
  return nextResolve(specifier, context);
}
`,
        'utf8'
      );

      fs.writeFileSync(
        preloadPath,
        `import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(loaderHookPath).href)});
process.stdin.on('data', (buf) => {
  if (buf.toString().includes('TRIGGER_SIGTERM')) {
    process.emit('SIGTERM');
  }
});
`,
        'utf8'
      );

      const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
      const secretSessionId = 'live_secret_session_2424';

      const child = spawn(
        process.execPath,
        ['--import', pathToFileURL(preloadPath).href, path.join(ROOT_DIR, 'index.js')],
        {
          cwd: ROOT_DIR,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            [pathKey]: `${lpBinDir}${path.delimiter}${process.env[pathKey] || ''}`,
            KIOSK_SESSION_ID: secretSessionId,
            PRINTELLECT_CONFIG_PATH: cfgPath,
            PRINTELLECT_FORCE_CUPS: '1',
            DAEMON_NODE_EXE: process.execPath,
            DAEMON_LP_JS: path.join(suiteDir, 'lp-record.mjs'),
            DAEMON_LP_LOG: lpLogPath,
          },
        }
      );

      let stdout = '';
      let stderr = '';
      let sigtermSent = false;

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (!sigtermSent && stdout.includes('[STUB_VERIFY] FIRESTORE_UPDATED:')) {
          sigtermSent = true;
          child.stdin.write('TRIGGER_SIGTERM\n');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Daemon Node 24 test timed out.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        }, 12000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      assert.equal(exitCode, 0, `Expected clean exit 0 on SIGTERM, got ${exitCode}.\nSTDERR:\n${stderr}`);

      // 1. Secret masking check
      assert.equal(stdout.includes(secretSessionId), false, 'Cleartext KIOSK_SESSION_ID must never be logged');
      assert.equal(stderr.includes(secretSessionId), false, 'Cleartext KIOSK_SESSION_ID must never be logged');
      assert.match(stdout, /Listening for Kiosk Session ID: liv\*\*\*\*24 \(length: 24\)/);

      // 2. Startup, Firebase readiness, and listener attachment markers
      assert.match(stdout, /Connected to Firebase\./);
      assert.match(stdout, /Listening for print jobs \(waiting for payment confirmation\)\.\.\./);

      // 3. Real loopback HTTP download + real printer.js CUPS option mapping + Firestore completion
      const lpArgsList = fs
        .readFileSync(lpLogPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      assert.equal(lpArgsList.length, 1);
      assert.deepEqual(lpArgsList[0].slice(0, -1), [
        '-d', 'HP_BW',
        '-n', '2',
        '-o', 'ColorModel=Gray',
        '-o', 'sides=two-sided-long-edge',
        '-o', 'fit-to-page',
      ]);
      assert.equal(fs.existsSync(lpArgsList[0][lpArgsList[0].length - 1]), false, 'Temp job PDF must be unlinked');
      assert.match(
        stdout,
        /\[STUB_VERIFY\] FIRESTORE_UPDATED:\{"id":"job_node24_001","status":"completed","trays":\["Tray 1"\]\}/
      );

      // 4. Clean SIGTERM listener unsubscribe & shutdown
      assert.match(stdout, /Received SIGTERM\. Unsubscribing Firestore listener and shutting down cleanly\.\.\./);
      assert.match(stdout, /\[STUB_VERIFY\] FIRESTORE_UNSUBSCRIBED/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
