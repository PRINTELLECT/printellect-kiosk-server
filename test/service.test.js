import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const INSTALL_SCRIPT = 'scripts/install-service.sh';
const UNIT_TEMPLATE = path.join(ROOT_DIR, 'systemd', 'printellect.service');
const RECOVER_UNIT_TEMPLATE = path.join(ROOT_DIR, 'systemd', 'printellect-migration-recover.service');
const NODE24_DIR = path.dirname(process.execPath);

function runInstaller(args = [], cwd = ROOT_DIR, extraEnv = {}, scriptPath = INSTALL_SCRIPT) {
  const relNodeDir = path.relative(cwd, NODE24_DIR).replace(/\\/g, '/') || '.';
  const relMockDir = extraEnv.PREPEND_PATH
    ? path.relative(cwd, extraEnv.PREPEND_PATH).replace(/\\/g, '/')
    : '';
  const pathPrefix = relMockDir ? `${relMockDir}:${relNodeDir}` : relNodeDir;
  const mergedEnv = {
    ...process.env,
    MSYS: 'winsymlinks:lnk',
    ...extraEnv,
    PRINTELLECT_TEST_PATH_PREFIX: pathPrefix,
    WSLENV: [
      process.env.WSLENV,
      'PRINTELLECT_TEST_SYSTEMD',
      'PRINTELLECT_TEST_PATH_PREFIX',
      'PRINTELLECT_TEST_CRASH_AT_PHASE',
      'MOCK_HEALTH_MODE',
      'MOCK_FAIL_ON',
      'MOCK_FAIL_UNIT',
    ].filter(Boolean).join(':'),
  };
  delete mergedEnv.PREPEND_PATH;

  return spawnSync('bash', [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: mergedEnv,
  });
}

describe('Systemd Service Unit — Directives & Security Hardening', () => {
  it('should exist and be readable', () => {
    assert.equal(fs.existsSync(UNIT_TEMPLATE), true, 'Unit template must exist');
  });

  it('should configure correct service identity, paths, and lifecycle', () => {
    const content = fs.readFileSync(UNIT_TEMPLATE, 'utf8');

    // Identity
    assert.match(content, /^User=printellect$/m);
    assert.match(content, /^Group=printellect$/m);
    assert.match(content, /^SupplementaryGroups=lp$/m);

    // Paths
    assert.match(content, /^WorkingDirectory=\/opt\/printellect\/current$/m);
    assert.match(content, /^EnvironmentFile=\/etc\/printellect\/kiosk\.env$/m);
    assert.match(content, /^ExecStart=\/usr\/bin\/node \/opt\/printellect\/current\/index\.js$/m);

    // Lifecycle
    assert.match(content, /^Type=simple$/m);
    assert.match(content, /^Restart=on-failure$/m);
    assert.match(content, /^RestartSec=5s$/m);
    assert.match(content, /^TimeoutStopSec=15s$/m);

    // Unit rate limiting in [Unit] section
    assert.match(content, /^StartLimitIntervalSec=60s$/m);
    assert.match(content, /^StartLimitBurst=5$/m);

    // Should NOT use deprecated/insecure KillMode=process
    assert.equal(/KillMode=process/.test(content), false, 'KillMode=process must not be used');

    // Dependencies
    assert.match(content, /^After=network-online\.target cups\.service$/m);
    assert.match(content, /^Wants=network-online\.target cups\.service$/m);

    // Logging
    assert.match(content, /^StandardOutput=journal$/m);
    assert.match(content, /^StandardError=journal$/m);
  });

  it('should configure all essential security hardening directives', () => {
    const content = fs.readFileSync(UNIT_TEMPLATE, 'utf8');

    assert.match(content, /^NoNewPrivileges=true$/m);
    assert.match(content, /^PrivateTmp=true$/m);
    assert.match(content, /^ProtectSystem=strict$/m);
    assert.match(content, /^ProtectHome=true$/m);
    assert.match(content, /^ProtectKernelTunables=true$/m);
    assert.match(content, /^ProtectKernelModules=true$/m);
    assert.match(content, /^ProtectControlGroups=true$/m);
    assert.match(content, /^RestrictRealtime=true$/m);
    assert.match(content, /^RestrictSUIDSGID=true$/m);
    assert.match(content, /^ReadWritePaths=\/var\/lib\/printellect \/tmp$/m);
  });

  it('should pass systemd-analyze verify without unknown key warnings if available', () => {
    const analyzeCheck = spawnSync('which', ['systemd-analyze'], { encoding: 'utf8' });
    if (analyzeCheck.status === 0) {
      const res = spawnSync('systemd-analyze', ['verify', UNIT_TEMPLATE], { encoding: 'utf8' });
      const output = `${res.stdout}\n${res.stderr}`;
      // Verify no 'Unknown key' warnings exist in systemd-analyze output
      assert.equal(/Unknown key name/.test(output), false, `Unknown key in unit: ${output}`);
    }
  });
});

describe('Service Installer — Syntax, Preflight, and Simulation', () => {
  let tempRoot;

  beforeEach(() => {
    const tmpBase = path.join(ROOT_DIR, '.dist_tmp');
    if (!fs.existsSync(tmpBase)) {
      fs.mkdirSync(tmpBase, { recursive: true });
    }
    tempRoot = fs.mkdtempSync(path.join(tmpBase, 'service-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('should pass bash shell syntax check (bash -n)', () => {
    const res = spawnSync('bash', ['-n', INSTALL_SCRIPT], { cwd: ROOT_DIR, encoding: 'utf8' });
    assert.equal(res.status, 0, `Syntax error in ${INSTALL_SCRIPT}: ${res.stderr}`);
  });

  it('should display help and exit code 0 when --help is passed', () => {
    const res = runInstaller(['--help']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /PRINTELLECT Kiosk Server — Service Installer/);
    assert.match(res.stdout, /--migrate-legacy/);
    assert.match(res.stdout, /--rollback/);
  });

  it('should successfully run preflight check in isolated directory', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const res = runInstaller(['--preflight-only', '--root-dir', relRoot, '--session-id', 'test_station']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /PREFLIGHT VALIDATION COMPLETED/);
  });

  it('should install service unit and environment file into isolated root', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const res = runInstaller([
      '--root-dir', relRoot,
      '--session-id', 'kiosk_station_alpha',
    ]);

    assert.equal(res.status, 0, `Installation failed: ${res.stderr}\n${res.stdout}`);

    // Verify unit file installed
    const installedUnit = path.join(tempRoot, 'etc', 'systemd', 'system', 'printellect.service');
    assert.equal(fs.existsSync(installedUnit), true, 'Unit file must be installed');

    // Verify environment file created
    const envFile = path.join(tempRoot, 'etc', 'printellect', 'kiosk.env');
    assert.equal(fs.existsSync(envFile), true, 'Environment file must be created');
    const envContent = fs.readFileSync(envFile, 'utf8');
    assert.match(envContent, /KIOSK_SESSION_ID="kiosk_station_alpha"/);
    assert.match(envContent, /PRINTELLECT_CONFIG_PATH=".*config\.json"/);

    // Verify persistent directory created
    const configDir = path.join(tempRoot, 'var', 'lib', 'printellect');
    assert.equal(fs.existsSync(configDir), true, 'State directory must be created');
  });

  it('should be idempotent when run repeatedly without corrupting configuration', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const run1 = runInstaller(['--root-dir', relRoot, '--session-id', 'station_idem']);
    assert.equal(run1.status, 0);

    // Simulate persistent printer config
    const configFile = path.join(tempRoot, 'var', 'lib', 'printellect', 'config.json');
    const printerConfig = { bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' };
    fs.writeFileSync(configFile, JSON.stringify(printerConfig, null, 2));

    // Run installer again
    const run2 = runInstaller(['--root-dir', relRoot, '--session-id', 'station_idem']);
    assert.equal(run2.status, 0);

    // Ensure printer config was NOT deleted or overwritten
    assert.equal(fs.existsSync(configFile), true);
    const readBack = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.deepEqual(readBack, printerConfig);
  });
});

describe('Historical Legacy Service Migration (aaryan user & custom paths)', () => {
  let tempRoot;

  beforeEach(() => {
    const tmpBase = path.join(ROOT_DIR, '.dist_tmp');
    if (!fs.existsSync(tmpBase)) {
      fs.mkdirSync(tmpBase, { recursive: true });
    }
    tempRoot = fs.mkdtempSync(path.join(tmpBase, 'migrate-hist-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('should auto-discover legacy service running as aaryan, preserve state, and extract session ID without logging secret', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');

    // Create legacy working directory for user aaryan
    const legacyWorkDir = path.join(tempRoot, 'home', 'aaryan', 'printellect', 'printellect-kiosk-server');
    fs.mkdirSync(legacyWorkDir, { recursive: true });

    // Legacy config in user directory
    const legacyConfig = { bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' };
    fs.writeFileSync(path.join(legacyWorkDir, 'config.json'), JSON.stringify(legacyConfig, null, 2));

    // Setup legacy systemd unit
    const systemdDir = path.join(tempRoot, 'etc', 'systemd', 'system');
    fs.mkdirSync(systemdDir, { recursive: true });
    const legacyUnitPath = path.join(systemdDir, 'printellect-kiosk.service');
    const secretSessionId = 'secret_kiosk_aaryan_12345';
    const legacyUnitContent = `[Unit]
Description=Historical Printellect Kiosk Server
After=network.target

[Service]
Type=simple
User=aaryan
WorkingDirectory=/home/aaryan/printellect/printellect-kiosk-server
ExecStart=/usr/bin/node /home/aaryan/printellect/printellect-kiosk-server/index.js ${secretSessionId}
Restart=always

[Install]
WantedBy=multi-user.target
`;
    fs.writeFileSync(legacyUnitPath, legacyUnitContent);

    // Execute migration with auto-discovery
    const res = runInstaller([
      '--root-dir', relRoot,
      '--migrate-legacy', 'auto',
    ]);

    assert.equal(res.status, 0, `Migration failed: ${res.stderr}\n${res.stdout}`);

    // Verify session ID was NOT logged in cleartext to stdout
    assert.equal(
      res.stdout.includes(secretSessionId),
      false,
      'Secret session ID must NOT appear in cleartext in installer logs'
    );
    assert.match(res.stdout, /fingerprint:/, 'Installer should log masked fingerprint');

    // Verify session ID was properly written to /etc/printellect/kiosk.env
    const envFile = path.join(tempRoot, 'etc', 'printellect', 'kiosk.env');
    assert.equal(fs.existsSync(envFile), true);
    const envContent = fs.readFileSync(envFile, 'utf8');
    assert.match(envContent, new RegExp(`KIOSK_SESSION_ID="${secretSessionId}"`));

    // Verify legacy printer configuration was migrated to /var/lib/printellect/config.json
    const destConfigFile = path.join(tempRoot, 'var', 'lib', 'printellect', 'config.json');
    assert.equal(fs.existsSync(destConfigFile), true);
    const destConfig = JSON.parse(fs.readFileSync(destConfigFile, 'utf8'));
    assert.deepEqual(destConfig, legacyConfig);

    // Verify legacy unit was backed up with timestamp
    const backupDir = path.join(tempRoot, 'var', 'lib', 'printellect', 'backups');
    const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith('printellect-kiosk.service.bak.'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'), legacyUnitContent);

    // Verify migration metadata captured historical user and workdir
    const metaFile = path.join(tempRoot, 'etc', 'printellect', 'migration.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.equal(meta.legacyUnitName, 'printellect-kiosk.service');
    assert.equal(meta.legacyUser, 'aaryan');
    assert.equal(meta.legacyWorkDir, '/home/aaryan/printellect/printellect-kiosk-server');
  });

  it('should abort cleanly when multiple candidate legacy services exist to prevent modifying the wrong service', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const systemdDir = path.join(tempRoot, 'etc', 'systemd', 'system');
    fs.mkdirSync(systemdDir, { recursive: true });

    // Create two conflicting legacy units
    fs.writeFileSync(path.join(systemdDir, 'kiosk-daemon.service'), '[Service]\nExecStart=node index.js id1\n');
    fs.writeFileSync(path.join(systemdDir, 'kiosk-server.service'), '[Service]\nExecStart=node index.js id2\n');

    const res = runInstaller(['--root-dir', relRoot, '--migrate-legacy', 'auto']);
    assert.equal(res.status, 1, 'Installer must abort with non-zero exit code');
    assert.match(res.stderr, /Multiple candidate legacy services discovered/);
    assert.match(res.stderr, /ambiguous/i);
  });

  it('should abort cleanly when session ID cannot be determined from legacy unit', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const systemdDir = path.join(tempRoot, 'etc', 'systemd', 'system');
    fs.mkdirSync(systemdDir, { recursive: true });

    // Legacy unit with no session ID argument
    fs.writeFileSync(
      path.join(systemdDir, 'kiosk-daemon.service'),
      '[Service]\nExecStart=/usr/bin/node /home/pi/index.js\n'
    );

    const res = runInstaller(['--root-dir', relRoot, '--migrate-legacy', 'kiosk-daemon.service']);
    assert.equal(res.status, 1, 'Installer must abort when session ID is missing');
    assert.match(res.stderr, /Could not unambiguously determine KIOSK_SESSION_ID/);
  });

  it('should fail with clear error when specified legacy unit does not exist', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const res = runInstaller(['--root-dir', relRoot, '--migrate-legacy', 'non-existent.service']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Specified legacy unit .* does not exist/);
  });
});

describe('Service Rollback Resilience & Failure Recovery', () => {
  let tempRoot;

  beforeEach(() => {
    const tmpBase = path.join(ROOT_DIR, '.dist_tmp');
    if (!fs.existsSync(tmpBase)) {
      fs.mkdirSync(tmpBase, { recursive: true });
    }
    tempRoot = fs.mkdtempSync(path.join(tmpBase, 'rollback-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('should fail safely with manual recovery instructions when migration metadata is missing', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const res = runInstaller(['--root-dir', relRoot, '--rollback']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Migration metadata file not found/);
    assert.match(res.stderr, /Manual recovery instructions/);
  });

  it('should fail safely with manual recovery instructions when backup file is missing or metadata is corrupt', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const envDir = path.join(tempRoot, 'etc', 'printellect');
    fs.mkdirSync(envDir, { recursive: true });

    // Corrupt metadata
    fs.writeFileSync(path.join(envDir, 'migration.json'), '{"legacyUnitName": "old.service", "unitBackup": "/bad/path"}');

    const res = runInstaller(['--root-dir', relRoot, '--rollback']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /incomplete or backup file is missing/);
    assert.match(res.stderr, /Manual recovery instructions/);
  });

  it('should execute full rollback, restore legacy unit, remove new unit, and preserve backups on disk', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');

    // 1. Create legacy unit
    const systemdDir = path.join(tempRoot, 'etc', 'systemd', 'system');
    fs.mkdirSync(systemdDir, { recursive: true });
    const legacyPath = path.join(systemdDir, 'kiosk-daemon.service');
    const originalLegacyContent = '[Unit]\nDescription=Production Legacy\n[Service]\nExecStart=node index.js shop_orig\n';
    fs.writeFileSync(legacyPath, originalLegacyContent);

    // 2. Perform migration
    const migRes = runInstaller(['--root-dir', relRoot, '--migrate-legacy', 'kiosk-daemon.service']);
    assert.equal(migRes.status, 0);

    const newUnitPath = path.join(systemdDir, 'printellect.service');
    assert.equal(fs.existsSync(newUnitPath), true);

    // Corrupt or alter legacy path to verify restoration
    fs.writeFileSync(legacyPath, '# Corrupted or altered state');

    // 3. Perform Rollback
    const rollRes = runInstaller(['--root-dir', relRoot, '--rollback']);
    assert.equal(rollRes.status, 0, `Rollback failed: ${rollRes.stderr}\n${rollRes.stdout}`);
    assert.match(rollRes.stdout, /ROLLBACK COMPLETED SUCCESSFULLY/);

    // Verify original content restored
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), originalLegacyContent);

    // Verify printellect.service was removed
    assert.equal(fs.existsSync(newUnitPath), false);

    // Verify unit backup was NOT deleted from backups directory
    const backupDir = path.join(tempRoot, 'var', 'lib', 'printellect', 'backups');
    const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith('kiosk-daemon.service.bak.'));
    assert.equal(backups.length, 1, 'Backup unit file must be permanently preserved');

    // Verify metadata marked as rolled_back
    const meta = JSON.parse(fs.readFileSync(path.join(tempRoot, 'etc', 'printellect', 'migration.json'), 'utf8'));
    assert.equal(meta.status, 'rolled_back');
    assert.equal(typeof meta.rolledBackAt, 'string');
  });

  it('should backup and restore drop-in configuration directories during migration and rollback', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');

    // 1. Setup legacy unit with a drop-in override directory
    const systemdDir = path.join(tempRoot, 'etc', 'systemd', 'system');
    fs.mkdirSync(systemdDir, { recursive: true });
    const legacyPath = path.join(systemdDir, 'kiosk-daemon.service');
    fs.writeFileSync(legacyPath, '[Unit]\nDescription=Dropin Test\n[Service]\nExecStart=node index.js shop_dropin\n');

    const dropinDir = path.join(systemdDir, 'kiosk-daemon.service.d');
    fs.mkdirSync(dropinDir, { recursive: true });
    const dropinContent = '[Service]\nEnvironment=CUSTOM_ENV=1\n';
    fs.writeFileSync(path.join(dropinDir, 'override.conf'), dropinContent);

    // 2. Run migration
    const migRes = runInstaller(['--root-dir', relRoot, '--migrate-legacy', 'kiosk-daemon.service']);
    assert.equal(migRes.status, 0);

    // Verify drop-in backup exists
    const backupDir = path.join(tempRoot, 'var', 'lib', 'printellect', 'backups');
    const dropinBackups = fs.readdirSync(backupDir).filter((f) => f.includes('kiosk-daemon.service.d.bak.'));
    assert.equal(dropinBackups.length, 1);
    const backedUpDropin = fs.readFileSync(path.join(backupDir, dropinBackups[0], 'override.conf'), 'utf8');
    assert.equal(backedUpDropin, dropinContent);

    // 3. Clear drop-in directory to simulate cutover changes
    fs.rmSync(path.join(dropinDir, 'override.conf'));

    // 4. Run rollback
    const rollRes = runInstaller(['--root-dir', relRoot, '--rollback']);
    assert.equal(rollRes.status, 0);

    // Verify drop-in directory restored
    const restoredDropin = fs.readFileSync(path.join(dropinDir, 'override.conf'), 'utf8');
    assert.equal(restoredDropin, dropinContent);
  });

  it('should discover legacy units in /lib/systemd/system and handle symlinked units cleanly', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');

    // Setup vendor unit in /lib/systemd/system
    const vendorDir = path.join(tempRoot, 'lib', 'systemd', 'system');
    fs.mkdirSync(vendorDir, { recursive: true });
    const vendorUnitPath = path.join(vendorDir, 'kiosk-daemon.service');
    const vendorContent = '[Unit]\nDescription=Vendor Kiosk\n[Service]\nExecStart=node index.js shop_vendor\n';
    fs.writeFileSync(vendorUnitPath, vendorContent);

    // Run migration with auto-discovery
    const migRes = runInstaller(['--root-dir', relRoot, '--migrate-legacy', 'auto']);
    assert.equal(migRes.status, 0, `Migration failed: ${migRes.stderr}\n${migRes.stdout}`);
    assert.match(migRes.stdout, /Auto-discovered legacy Printellect service: kiosk-daemon\.service/);

    // Verify session ID extracted
    const envFile = path.join(tempRoot, 'etc', 'printellect', 'kiosk.env');
    const envContent = fs.readFileSync(envFile, 'utf8');
    assert.match(envContent, /KIOSK_SESSION_ID="shop_vendor"/);

    // Run rollback
    const rollRes = runInstaller(['--root-dir', relRoot, '--rollback']);
    assert.equal(rollRes.status, 0);
  });
});

/**
 * Helper to create POSIX symlinks via Git Bash / Linux bash (supports broken and /dev/null targets).
 */
function createBashSymlink(target, linkAbsPath) {
  const relLink = path.relative(ROOT_DIR, linkAbsPath).replace(/\\/g, '/');
  fs.mkdirSync(path.dirname(linkAbsPath), { recursive: true });
  const res = spawnSync('bash', ['-c', 'ln -sfn "$1" "$2" && test -L "$2"', '_', target, relLink], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    env: { ...process.env, MSYS: 'winsymlinks:lnk' },
  });
  return res.status === 0;
}

/**
 * Creates an isolated mock `systemctl` + `journalctl` harness inside `tempRoot/mock-bin`
 * to exercise every non-atomic failure point, health-check failure mode, and rollback step.
 */
function setupMockSystemd(tempRoot, initialUnits = {}) {
  const mockBinDir = path.join(tempRoot, 'mock-bin');
  const mockStateDir = path.join(tempRoot, 'mock-systemd-state');
  fs.mkdirSync(mockBinDir, { recursive: true });
  fs.mkdirSync(mockStateDir, { recursive: true });

  const cmdLogPath = path.join(mockStateDir, 'commands.log');
  fs.writeFileSync(cmdLogPath, '');

  for (const [unitName, st] of Object.entries(initialUnits)) {
    fs.writeFileSync(path.join(mockStateDir, `${unitName}.active`), st.active ? 'active' : 'inactive');
    fs.writeFileSync(path.join(mockStateDir, `${unitName}.enabled`), st.enabled ? 'enabled' : 'disabled');
  }

  const relStateDir = path.relative(ROOT_DIR, mockStateDir).replace(/\\/g, '/');

  const systemctlScript = `#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${relStateDir}"
CMD="\${1:-}"
UNIT="\${2:-}"
if [[ "\${UNIT}" == "--no-block" ]]; then
  UNIT="\${3:-}"
fi
echo "\$*" >> "\${STATE_DIR}/commands.log"

check_no_dual_daemons() {
  local new_st="inactive"
  new_st="\$(cat "\${STATE_DIR}/printellect.service.active" 2>/dev/null || echo "inactive")"
  if [[ "\${new_st}" == "active" ]]; then
    for af in "\${STATE_DIR}"/*.service.active; do
      [[ ! -f "\${af}" ]] && continue
      local bname
      bname="\$(basename "\${af}" .active)"
      [[ "\${bname}" == "printellect.service" || "\${bname}" == "printellect-migration-recover.service" ]] && continue
      local ost
      ost="\$(cat "\${af}" 2>/dev/null || echo "inactive")"
      if [[ "\${ost}" == "active" ]]; then
        echo "DUAL_DAEMON_VIOLATION: printellect.service and \${bname} both active on '\$*'" >> "\${STATE_DIR}/dual_daemon_violations.log"
      fi
    done
  fi
}

if [[ -n "\${MOCK_FAIL_ON:-}" && "\${CMD}" == "\${MOCK_FAIL_ON}" ]]; then
  if [[ -z "\${MOCK_FAIL_UNIT:-}" || "\${UNIT}" == "\${MOCK_FAIL_UNIT}" ]]; then
    echo "Simulated systemctl failure on: \$*" >&2
    exit 1
  fi
fi

case "\${CMD}" in
  is-enabled)
    st="\$(cat "\${STATE_DIR}/\${UNIT}.enabled" 2>/dev/null || echo "disabled")"
    [[ "\${st}" == "enabled" ]] && exit 0 || exit 1
    ;;
  is-active)
    if [[ "\${UNIT}" == "printellect.service" && "\${MOCK_HEALTH_MODE:-healthy}" == "crash_loop" ]]; then
      echo "activating"
      exit 3
    fi
    st="\$(cat "\${STATE_DIR}/\${UNIT}.active" 2>/dev/null || echo "inactive")"
    echo "\${st}"
    [[ "\${st}" == "active" ]] && exit 0 || exit 3
    ;;
  stop)
    echo "inactive" > "\${STATE_DIR}/\${UNIT}.active"
    ;;
  disable)
    echo "disabled" > "\${STATE_DIR}/\${UNIT}.enabled"
    ;;
  enable)
    echo "enabled" > "\${STATE_DIR}/\${UNIT}.enabled"
    ;;
  start|restart)
    if [[ "\${CMD}" == "restart" ]]; then
      echo "inactive" > "\${STATE_DIR}/\${UNIT}.active"
    fi
    if [[ "\${UNIT}" == "printellect.service" && "\${MOCK_HEALTH_MODE:-healthy}" == "immediate_fail" ]]; then
      echo "failed" > "\${STATE_DIR}/\${UNIT}.active"
    else
      echo "active" > "\${STATE_DIR}/\${UNIT}.active"
    fi
    echo "0" > "\${STATE_DIR}/show_calls.count"
    check_no_dual_daemons "\$*"
    ;;
  daemon-reload|reset-failed|kill)
    if [[ "\${CMD}" == "kill" && -n "\${3:-}" ]]; then
      echo "inactive" > "\${STATE_DIR}/\${3}.active"
    fi
    exit 0
    ;;
  list-units)
    exit 0
    ;;
  show)
    calls="\$(cat "\${STATE_DIR}/show_calls.count" 2>/dev/null || echo "0")"
    calls=\$((calls + 1))
    echo "\${calls}" > "\${STATE_DIR}/show_calls.count"
    mode="\${MOCK_HEALTH_MODE:-healthy}"
    cur_active="\$(cat "\${STATE_DIR}/\${UNIT}.active" 2>/dev/null || echo "inactive")"

    if [[ "\${mode}" == "crash_loop" ]]; then
      printf "ActiveState=activating\\nSubState=auto-restart\\nMainPID=0\\nNRestarts=1\\nResult=exit-code\\nExecMainStatus=1\\n"
    elif [[ "\${mode}" == "unstable_pid" && "\${calls}" -ge 2 ]]; then
      printf "ActiveState=active\\nSubState=running\\nMainPID=9999\\nNRestarts=1\\nResult=success\\nExecMainStatus=0\\n"
    else
      printf "ActiveState=%s\\nSubState=running\\nMainPID=4242\\nNRestarts=0\\nResult=success\\nExecMainStatus=0\\n" "\${cur_active}"
    fi
    ;;
  *)
    exit 0
    ;;
esac
`;

  const journalctlScript = `#!/usr/bin/env bash
mode="\${MOCK_HEALTH_MODE:-healthy}"
case "\${mode}" in
  healthy|unstable_pid)
    echo "Started PRINTELLECT Kiosk Print Daemon."
    echo "Connected to Firebase."
    echo "Listening for print jobs (waiting for payment confirmation)..."
    ;;
  stale_previous_pid_logs)
    if [[ "\$*" == *"_PID=4242"* ]]; then
      # New PID 4242 has emitted zero readiness markers (empty / silent hang)
      exit 0
    else
      # Unscoped unit journal still contains a PREVIOUS service run's readiness markers and raw secrets
      echo "Old run PID 1111: Connected to Firebase."
      echo "Old run PID 1111: Listening for print jobs (waiting for payment confirmation)..."
      echo "Old run args: /usr/bin/node /opt/printellect/current/index.js leak_test_secret_sid_555"
      echo "Old run env: KIOSK_SESSION_ID=leak_test_secret_sid_555"
    fi
    ;;
  firebase_fatal)
    echo "Starting Kiosk Print Daemon..."
    echo "Firebase Auth Error: network request failed"
    echo "[FATAL ERROR] Unable to authenticate"
    ;;
  timeout_hang)
    echo "Starting Kiosk Print Daemon..."
    ;;
  *)
    echo "Daemon running"
    ;;
esac
`;

  fs.writeFileSync(path.join(mockBinDir, 'systemctl'), systemctlScript.replace(/\r\n/g, '\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(mockBinDir, 'journalctl'), journalctlScript.replace(/\r\n/g, '\n'), { mode: 0o755 });

  return {
    mockBinDir,
    mockStateDir,
    readCommands: () => fs.readFileSync(cmdLogPath, 'utf8').trim().split('\n').filter(Boolean),
    getUnitState: (unitName) => ({
      active: (fs.existsSync(path.join(mockStateDir, `${unitName}.active`))
        ? fs.readFileSync(path.join(mockStateDir, `${unitName}.active`), 'utf8').trim()
        : 'inactive'),
      enabled: (fs.existsSync(path.join(mockStateDir, `${unitName}.enabled`))
        ? fs.readFileSync(path.join(mockStateDir, `${unitName}.enabled`), 'utf8').trim()
        : 'disabled'),
    }),
  };
}

describe('Phase 4.3 — Legacy Discovery Coverage, Drop-Ins, Symlinks & Vendor Protection', () => {
  let tempRoot;

  beforeEach(() => {
    const tmpBase = path.join(ROOT_DIR, '.dist_tmp');
    if (!fs.existsSync(tmpBase)) {
      fs.mkdirSync(tmpBase, { recursive: true });
    }
    tempRoot = fs.mkdtempSync(path.join(tmpBase, 'p43-disc-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it('should discover units in /usr/lib/systemd/system with drop-in overrides and EnvironmentFile without modifying vendor files', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');

    // 1. Vendor base unit in /usr/lib/systemd/system with generic ExecStart & User
    const usrLibDir = path.join(tempRoot, 'usr', 'lib', 'systemd', 'system');
    fs.mkdirSync(usrLibDir, { recursive: true });
    const vendorUnitPath = path.join(usrLibDir, 'kiosk.service');
    const vendorContent = '[Unit]\nDescription=Generic Vendor Unit\n[Service]\nUser=nobody\nExecStart=/usr/bin/node /usr/share/generic.js\n';
    fs.writeFileSync(vendorUnitPath, vendorContent, { mode: 0o444 });

    // Vendor drop-in in /usr/lib/systemd/system/kiosk.service.d (must also stay untouched!)
    const vendorDropinDir = path.join(usrLibDir, 'kiosk.service.d');
    fs.mkdirSync(vendorDropinDir, { recursive: true });
    const vendorDropinFile = path.join(vendorDropinDir, '10-vendor.conf');
    const vendorDropinContent = '[Service]\nWorkingDirectory=/usr/share\n';
    fs.writeFileSync(vendorDropinFile, vendorDropinContent, { mode: 0o444 });

    // 2. Admin drop-in in /etc/systemd/system/kiosk.service.d overriding User, WorkingDirectory, ExecStart (with reset line!), and EnvironmentFile
    const etcDropinDir = path.join(tempRoot, 'etc', 'systemd', 'system', 'kiosk.service.d');
    fs.mkdirSync(etcDropinDir, { recursive: true });
    const legacyWorkDir = path.join(tempRoot, 'home', 'aaryan', 'printellect-kiosk-server');
    fs.mkdirSync(legacyWorkDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyWorkDir, 'config.json'),
      JSON.stringify({ bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' })
    );

    const legacyEnvFile = path.join(tempRoot, 'etc', 'default', 'legacy-kiosk');
    fs.mkdirSync(path.dirname(legacyEnvFile), { recursive: true });
    fs.writeFileSync(legacyEnvFile, 'KIOSK_SESSION_ID="envfile_secret_session_77"\n');

    const adminDropinContent = `[Service]
User=aaryan
WorkingDirectory=/home/aaryan/printellect-kiosk-server
EnvironmentFile=-/etc/default/legacy-kiosk
ExecStart=
ExecStart=/usr/bin/node /home/aaryan/printellect-kiosk-server/index.js
`;
    fs.writeFileSync(path.join(etcDropinDir, 'override.conf'), adminDropinContent);

    // 3. Migrate
    const migRes = runInstaller(['--root-dir', relRoot, '--migrate-legacy', 'auto']);
    assert.equal(migRes.status, 0, `Migration failed: ${migRes.stderr}\n${migRes.stdout}`);
    assert.match(migRes.stdout, /Auto-discovered legacy Printellect service: kiosk\.service/);

    // Verify drop-in overrides and EnvironmentFile session ID were extracted accurately
    const meta = JSON.parse(fs.readFileSync(path.join(tempRoot, 'etc', 'printellect', 'migration.json'), 'utf8'));
    assert.equal(meta.legacyUnitName, 'kiosk.service');
    assert.equal(meta.legacyUnitIsVendor, true);
    assert.equal(meta.legacyUser, 'aaryan');
    assert.equal(meta.legacyWorkDir, '/home/aaryan/printellect-kiosk-server');

    const envOut = fs.readFileSync(path.join(tempRoot, 'etc', 'printellect', 'kiosk.env'), 'utf8');
    assert.match(envOut, /KIOSK_SESSION_ID="envfile_secret_session_77"/);

    // 4. Rollback (vendor files are mode 0444 read-only — any write attempt to /usr/lib would fail or alter them!)
    const rollRes = runInstaller(['--root-dir', relRoot, '--rollback']);
    assert.equal(rollRes.status, 0, `Rollback failed: ${rollRes.stderr}\n${rollRes.stdout}`);
    assert.equal(fs.readFileSync(vendorUnitPath, 'utf8'), vendorContent);
    assert.equal(fs.readFileSync(vendorDropinFile, 'utf8'), vendorDropinContent);
  });

  it('should abort without stopping anything if legacy unit is empty/unreadable', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const systemdDir = path.join(tempRoot, 'etc', 'systemd', 'system');
    fs.mkdirSync(systemdDir, { recursive: true });
    // 0-byte corrupt/empty legacy unit
    fs.writeFileSync(path.join(systemdDir, 'printellect-kiosk.service'), '');

    const mock = setupMockSystemd(tempRoot, {
      'printellect-kiosk.service': { active: true, enabled: true },
    });

    const res = runInstaller(
      ['--root-dir', relRoot, '--migrate-legacy', 'auto', '--session-id', 'test_sid'],
      ROOT_DIR,
      { PRINTELLECT_TEST_SYSTEMD: '1', PREPEND_PATH: mock.mockBinDir }
    );

    assert.equal(res.status, 1);
    assert.match(res.stderr, /unreadable or empty/);
    // Confirm legacy service was NOT stopped!
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');
    assert.equal(mock.readCommands().some((c) => c.startsWith('stop ')), false);
  });

  it('should handle enabled .target.wants symlinks, masked units, broken symlinks, and symlinked unit files safely', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const systemdDir = path.join(tempRoot, 'etc', 'systemd', 'system');
    fs.mkdirSync(systemdDir, { recursive: true });

    // Check if host bash environment supports real -L symlinks
    const probeLink = path.join(tempRoot, 'probe.lnk');
    if (!createBashSymlink('/dev/null', probeLink)) {
      return; // Skip symlink-specific assertions only if OS completely forbids symlinks
    }
    fs.rmSync(probeLink, { force: true });

    // 1. Broken candidate symlink must ABORT cleanly without stopping anything
    const brokenPath = path.join(systemdDir, 'printellect-broken.service');
    createBashSymlink('/nonexistent/missing-kiosk.service', brokenPath);
    const brokenRes = runInstaller(['--root-dir', relRoot, '--migrate-legacy', 'auto', '--session-id', 'sid1']);
    assert.equal(brokenRes.status, 1);
    assert.match(brokenRes.stderr, /Broken symlink detected/);
    fs.rmSync(brokenPath, { force: true });

    // 2. Masked unit (-> /dev/null) is skipped in auto mode, and rejected if explicitly requested
    const maskedPath = path.join(systemdDir, 'kiosk-masked.service');
    createBashSymlink('/dev/null', maskedPath);
    const explicitMasked = runInstaller(['--root-dir', relRoot, '--migrate-legacy', 'kiosk-masked.service', '--session-id', 'sid1']);
    assert.equal(explicitMasked.status, 1);
    assert.match(explicitMasked.stderr, /masked/);

    // 3. Enabled unit existing ONLY via multi-user.target.wants symlink -> custom user path
    const customUnitDir = path.join(tempRoot, 'home', 'aaryan', 'custom-systemd');
    fs.mkdirSync(customUnitDir, { recursive: true });
    const customUnitFile = path.join(customUnitDir, 'aaryan-kiosk.service');
    const customUnitContent = '[Unit]\nDescription=Linked Kiosk\n[Service]\nExecStart=/usr/bin/node /home/aaryan/index.js linked_sid_88\n';
    fs.writeFileSync(customUnitFile, customUnitContent);

    const wantsLink = path.join(systemdDir, 'multi-user.target.wants', 'aaryan-kiosk.service');
    createBashSymlink('/home/aaryan/custom-systemd/aaryan-kiosk.service', wantsLink);

    const autoRes = runInstaller(['--root-dir', relRoot, '--migrate-legacy', 'auto']);
    assert.equal(autoRes.status, 0, `Auto discovery via .wants failed: ${autoRes.stderr}\n${autoRes.stdout}`);
    assert.match(autoRes.stdout, /Skipping masked systemd unit: kiosk-masked\.service/);
    assert.match(autoRes.stdout, /Auto-discovered legacy Printellect service: aaryan-kiosk\.service/);

    const meta = JSON.parse(fs.readFileSync(path.join(tempRoot, 'etc', 'printellect', 'migration.json'), 'utf8'));
    assert.equal(meta.wasEnabled, true);
  });

  it('should support --node-bin versioned runtime drop-in and reject /home paths', () => {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');

    // Reject /home path due to ProtectHome=true
    const badBinRes = runInstaller([
      '--root-dir', relRoot,
      '--session-id', 'sid_nodebin',
      '--node-bin', `${relRoot}/home/pi/node24/bin/node`,
    ]);
    assert.equal(badBinRes.status, 1);
    assert.match(badBinRes.stderr, /ProtectHome=true/);

    // Valid staged runtime in /opt/printellect/runtime/current/bin/node
    const stagedBinDir = path.join(tempRoot, 'opt', 'printellect', 'runtime', 'current', 'bin');
    fs.mkdirSync(stagedBinDir, { recursive: true });
    const stagedBin = path.join(stagedBinDir, 'node');
    fs.writeFileSync(stagedBin, '#!/usr/bin/env bash\necho "v24.14.0"\n', { mode: 0o755 });

    const relStagedBin = path.relative(ROOT_DIR, stagedBin).replace(/\\/g, '/');
    const okRes = runInstaller([
      '--root-dir', relRoot,
      '--session-id', 'sid_nodebin',
      '--node-bin', relStagedBin,
    ]);
    assert.equal(okRes.status, 0, `Custom node-bin install failed: ${okRes.stderr}\n${okRes.stdout}`);

    const runtimeDropin = path.join(tempRoot, 'etc', 'systemd', 'system', 'printellect.service.d', '10-runtime.conf');
    assert.equal(fs.existsSync(runtimeDropin), true);
    const dropinText = fs.readFileSync(runtimeDropin, 'utf8');
    assert.match(dropinText, /ExecStart=\/opt\/printellect\/runtime\/current\/bin\/node \/opt\/printellect\/current\/index\.js/);
  });
});

describe('Phase 4.3 — Non-Atomic Failure Points, Health-Check Gate & Reboot Rollback', () => {
  let tempRoot;

  beforeEach(() => {
    const tmpBase = path.join(ROOT_DIR, '.dist_tmp');
    if (!fs.existsSync(tmpBase)) {
      fs.mkdirSync(tmpBase, { recursive: true });
    }
    tempRoot = fs.mkdtempSync(path.join(tmpBase, 'p43-txn-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  function seedLegacyEnvironment() {
    const relRoot = path.relative(ROOT_DIR, tempRoot).replace(/\\/g, '/');
    const legacyWorkDir = path.join(tempRoot, 'home', 'aaryan', 'printellect-kiosk-server');
    fs.mkdirSync(legacyWorkDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyWorkDir, 'config.json'),
      JSON.stringify({ bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' })
    );

    const vendorDir = path.join(tempRoot, 'lib', 'systemd', 'system');
    fs.mkdirSync(vendorDir, { recursive: true });
    const legacyUnitPath = path.join(vendorDir, 'printellect-kiosk.service');
    const legacyContent = `[Unit]
Description=Legacy Kiosk Service
[Service]
User=aaryan
WorkingDirectory=/home/aaryan/printellect-kiosk-server
ExecStart=/usr/bin/node /home/aaryan/printellect-kiosk-server/index.js prod_station_01
[Install]
WantedBy=multi-user.target
`;
    fs.writeFileSync(legacyUnitPath, legacyContent, { mode: 0o444 });

    const mock = setupMockSystemd(tempRoot, {
      'printellect-kiosk.service': { active: true, enabled: true },
      'printellect.service': { active: false, enabled: false },
    });

    return { relRoot, legacyUnitPath, legacyContent, mock };
  }

  it('should pass multi-criteria health-check gate and mark checkpoint status=completed', () => {
    const { relRoot, mock } = seedLegacyEnvironment();

    const res = runInstaller(
      [
        '--root-dir', relRoot,
        '--migrate-legacy', 'auto',
        '--enable',
        '--start',
        '--health-timeout', '4',
        '--health-stable-sec', '1',
      ],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        MOCK_HEALTH_MODE: 'healthy',
      }
    );

    assert.equal(res.status, 0, `Migration failed: ${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout, /Health-check gate PASSED/);

    const meta = JSON.parse(fs.readFileSync(path.join(tempRoot, 'etc', 'printellect', 'migration.json'), 'utf8'));
    assert.equal(meta.status, 'completed');
    assert.equal(meta.checkpointPhase, 'health_check_passed');
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'inactive');
    assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'disabled');
    assert.equal(mock.getUnitState('printellect.service').active, 'active');
    assert.equal(mock.getUnitState('printellect.service').enabled, 'enabled');
  });

  it('Failure Point 1 & 2: should recover cleanly after failure right after legacy stop or disable (and after reboot)', () => {
    const { relRoot, mock } = seedLegacyEnvironment();

    // Inject failure during 'disable' (right AFTER legacy service has been stopped!)
    const failStopRes = runInstaller(
      ['--root-dir', relRoot, '--migrate-legacy', 'auto', '--enable', '--start'],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        MOCK_FAIL_ON: 'disable',
        MOCK_FAIL_UNIT: 'printellect-kiosk.service',
      }
    );

    assert.notEqual(failStopRes.status, 0);
    // Automatic ERR trap rollback must have restored legacy active & enabled state!
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');
    assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'enabled');

    // Now simulate power loss / reboot right AFTER legacy_disabled (in_progress checkpoint persisted on disk, neither service running)
    const metaPath = path.join(tempRoot, 'etc', 'printellect', 'migration.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.status = 'in_progress';
    meta.checkpointPhase = 'legacy_disabled';
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(mock.mockStateDir, 'printellect-kiosk.service.active'), 'inactive');
    fs.writeFileSync(path.join(mock.mockStateDir, 'printellect-kiosk.service.enabled'), 'disabled');

    // Verify interrupted installer guard refuses to clobber in_progress metadata if re-run without --rollback
    const blockedRerun = runInstaller(
      ['--root-dir', relRoot, '--migrate-legacy', 'auto'],
      ROOT_DIR,
      { PRINTELLECT_TEST_SYSTEMD: '1', PREPEND_PATH: mock.mockBinDir }
    );
    assert.equal(blockedRerun.status, 1);
    assert.match(blockedRerun.stderr, /interrupted migration/);

    // Now run --rollback after simulated reboot -> restores enabled + active legacy state!
    const rbRes = runInstaller(
      ['--root-dir', relRoot, '--rollback'],
      ROOT_DIR,
      { PRINTELLECT_TEST_SYSTEMD: '1', PREPEND_PATH: mock.mockBinDir }
    );
    assert.equal(rbRes.status, 0, `Post-reboot rollback failed: ${rbRes.stderr}\n${rbRes.stdout}`);
    assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'enabled');
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');
  });

  it('Failure Point 3 & 4: should recover cleanly after new unit installed (daemon-reload fail) or new service enabled (start fail)', () => {
    const { relRoot, mock } = seedLegacyEnvironment();

    // Failure Point 3: new unit installed on disk, then daemon-reload fails
    const failReload = runInstaller(
      ['--root-dir', relRoot, '--migrate-legacy', 'auto', '--enable', '--start'],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        MOCK_FAIL_ON: 'daemon-reload',
      }
    );
    assert.notEqual(failReload.status, 0);

    // Even if daemon-reload failed during trap, operator --rollback once systemd is healthy recovers cleanly
    const rb3 = runInstaller(
      ['--root-dir', relRoot, '--rollback'],
      ROOT_DIR,
      { PRINTELLECT_TEST_SYSTEMD: '1', PREPEND_PATH: mock.mockBinDir }
    );
    assert.equal(rb3.status, 0);
    assert.equal(fs.existsSync(path.join(tempRoot, 'etc', 'systemd', 'system', 'printellect.service')), false);
    assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'enabled');
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');

    // Failure Point 4: new unit installed AND enabled, then 'systemctl start printellect.service' fails
    const failStart = runInstaller(
      ['--root-dir', relRoot, '--migrate-legacy', 'auto', '--enable', '--start'],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        MOCK_FAIL_ON: 'start',
        MOCK_FAIL_UNIT: 'printellect.service',
      }
    );
    assert.notEqual(failStart.status, 0);
    assert.equal(fs.existsSync(path.join(tempRoot, 'etc', 'systemd', 'system', 'printellect.service')), false);
    assert.equal(mock.getUnitState('printellect.service').enabled, 'disabled');
    assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'enabled');
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');
  });

  it('Failure Point 5: should automatically roll back without touching vendor files when new service starts but fails health checks (Firebase fatal error or crash loop)', () => {
    const { relRoot, legacyUnitPath, legacyContent, mock } = seedLegacyEnvironment();

    // Case 5A: Type=simple reports 'active', but journalctl reports Firebase Auth Error
    const failFirebase = runInstaller(
      [
        '--root-dir', relRoot,
        '--migrate-legacy', 'auto',
        '--enable',
        '--start',
        '--health-timeout', '3',
        '--health-stable-sec', '1',
      ],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        MOCK_HEALTH_MODE: 'firebase_fatal',
      }
    );

    assert.equal(failFirebase.status, 1);
    assert.match(failFirebase.stderr, /failed post-start health-check gate/);
    assert.match(failFirebase.stderr, /fatal daemon error detected in journald output/);

    // Verify automatic rollback restored legacy service, stopped/disabled/removed printellect.service, preserved backups & vendor file
    assert.equal(fs.existsSync(path.join(tempRoot, 'etc', 'systemd', 'system', 'printellect.service')), false);
    assert.equal(mock.getUnitState('printellect.service').active, 'inactive');
    assert.equal(mock.getUnitState('printellect.service').enabled, 'disabled');
    assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'enabled');
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');
    assert.equal(fs.readFileSync(legacyUnitPath, 'utf8'), legacyContent, 'Read-only vendor file must be untouched');

    const metaAfter5A = JSON.parse(fs.readFileSync(path.join(tempRoot, 'etc', 'printellect', 'migration.json'), 'utf8'));
    assert.equal(metaAfter5A.status, 'rolled_back');
    assert.equal(fs.existsSync(path.resolve(ROOT_DIR, metaAfter5A.unitBackup)), true, 'Backup file must remain preserved on disk');

    // Case 5B: Service enters Restart=on-failure crash loop (NRestarts > 0)
    const failCrashLoop = runInstaller(
      [
        '--root-dir', relRoot,
        '--migrate-legacy', 'auto',
        '--enable',
        '--start',
        '--health-timeout', '3',
        '--health-stable-sec', '1',
      ],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        MOCK_HEALTH_MODE: 'crash_loop',
      }
    );

    assert.equal(failCrashLoop.status, 1);
    assert.match(failCrashLoop.stderr, /crash\/restart loop/);
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');
    assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'enabled');
  });
});

describe('Phase 4.4 — Power-Loss Boot Reconciliation Matrix Across Every Checkpoint', () => {
  let tempRoot;

  beforeEach(() => {
    const tmpBase = path.join(ROOT_DIR, '.dist_tmp');
    if (!fs.existsSync(tmpBase)) {
      fs.mkdirSync(tmpBase, { recursive: true });
    }
    tempRoot = fs.mkdtempSync(path.join(tmpBase, 'p44-boot-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  function seedPowerLossFixture(subName) {
    const caseRoot = path.join(tempRoot, subName);
    fs.mkdirSync(caseRoot, { recursive: true });
    const relRoot = path.relative(ROOT_DIR, caseRoot).replace(/\\/g, '/');

    const legacyWorkDir = path.join(caseRoot, 'home', 'aaryan', 'printellect-kiosk-server');
    fs.mkdirSync(legacyWorkDir, { recursive: true });
    const printerCfg = { bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' };
    fs.writeFileSync(path.join(legacyWorkDir, 'config.json'), JSON.stringify(printerCfg));

    // Vendor base unit (0444 read-only) + admin /etc drop-in
    const vendorDir = path.join(caseRoot, 'lib', 'systemd', 'system');
    fs.mkdirSync(vendorDir, { recursive: true });
    const legacyUnitPath = path.join(vendorDir, 'printellect-kiosk.service');
    const legacyContent = `[Unit]
Description=Legacy Kiosk Service
[Service]
User=aaryan
WorkingDirectory=/home/aaryan/printellect-kiosk-server
ExecStart=/usr/bin/node /home/aaryan/printellect-kiosk-server/index.js prod_station_p44
[Install]
WantedBy=multi-user.target
`;
    fs.writeFileSync(legacyUnitPath, legacyContent, { mode: 0o444 });

    const etcDropinDir = path.join(caseRoot, 'etc', 'systemd', 'system', 'printellect-kiosk.service.d');
    fs.mkdirSync(etcDropinDir, { recursive: true });
    const dropinContent = '[Service]\nEnvironment="EXTRA_FLAG=1"\n';
    fs.writeFileSync(path.join(etcDropinDir, '10-custom.conf'), dropinContent);

    const mock = setupMockSystemd(caseRoot, {
      'printellect-kiosk.service': { active: true, enabled: true },
      'printellect.service': { active: false, enabled: false },
      'printellect-migration-recover.service': { active: false, enabled: false },
    });

    return { caseRoot, relRoot, legacyUnitPath, legacyContent, etcDropinDir, dropinContent, printerCfg, mock };
  }

  it('should validate printellect-migration-recover.service unit directives and systemd-analyze verify', () => {
    assert.equal(fs.existsSync(RECOVER_UNIT_TEMPLATE), true, 'Boot recovery unit template must exist');
    const content = fs.readFileSync(RECOVER_UNIT_TEMPLATE, 'utf8');
    assert.match(content, /^After=local-fs\.target$/m);
    assert.match(content, /^Before=printellect\.service$/m);
    assert.match(content, /^ConditionPathExists=\/etc\/printellect\/migration\.json$/m);
    assert.match(content, /^Type=oneshot$/m);
    assert.match(content, /^RemainAfterExit=yes$/m);
    assert.match(content, /^ExecStart=\/bin\/bash \/etc\/printellect\/recover-migration\.sh --reconcile-boot --non-blocking-start$/m);
    assert.match(content, /^WantedBy=multi-user\.target$/m);

    const analyzeCheck = spawnSync('bash', ['-c', 'command -v systemd-analyze'], { encoding: 'utf8' });
    if (analyzeCheck.status === 0) {
      const relUnit = path.relative(ROOT_DIR, RECOVER_UNIT_TEMPLATE).replace(/\\/g, '/');
      const res = spawnSync('bash', ['-c', 'systemd-analyze verify "$1"', '_', relUnit], {
        cwd: ROOT_DIR,
        encoding: 'utf8',
      });
      const output = `${res.stdout}\n${res.stderr}`;
      assert.equal(/Unknown key name/.test(output), false, `Unknown key in recovery unit: ${output}`);
    }
  });

  const ALL_FORWARD_CHECKPOINTS = [
    'checkpoint_saved',
    'legacy_stopped',
    'legacy_disabled',
    'new_unit_installed',
    'daemon_reloaded',
    'new_service_enabled',
    'new_service_started',
  ];

  for (const phase of ALL_FORWARD_CHECKPOINTS) {
    it(`should automatically recover on reboot after sudden power loss at checkpoint '${phase}' without human intervention`, () => {
      const {
        caseRoot,
        relRoot,
        legacyUnitPath,
        legacyContent,
        etcDropinDir,
        dropinContent,
        printerCfg,
        mock,
      } = seedPowerLossFixture(`phase_${phase}`);

      // 1. Run migration and inject sudden SIGKILL / power loss right at `phase` (no ERR trap executes!)
      const crashRes = runInstaller(
        [
          '--root-dir', relRoot,
          '--migrate-legacy', 'auto',
          '--enable',
          '--start',
          '--health-timeout', '4',
          '--health-stable-sec', '1',
        ],
        ROOT_DIR,
        {
          PRINTELLECT_TEST_SYSTEMD: '1',
          PREPEND_PATH: mock.mockBinDir,
          MOCK_HEALTH_MODE: 'healthy',
          PRINTELLECT_TEST_CRASH_AT_PHASE: phase,
        }
      );

      assert.equal(crashRes.status, 137, `Expected simulated power-loss exit 137 at ${phase}, got ${crashRes.status}: ${crashRes.stderr}`);

      // Confirm persistent checkpoint recorded exact interrupted phase
      const metaPath = path.join(caseRoot, 'etc', 'printellect', 'migration.json');
      const interruptedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      assert.equal(interruptedMeta.status, 'in_progress');
      assert.equal(interruptedMeta.checkpointPhase, phase);

      // Confirm boot recovery unit and standalone script were armed BEFORE any stop/disable occurred!
      const selfContainedRecoverScript = path.join(caseRoot, 'etc', 'printellect', 'recover-migration.sh');
      assert.equal(fs.existsSync(selfContainedRecoverScript), true, 'Self-contained /etc/printellect/recover-migration.sh must exist');
      assert.equal(
        fs.existsSync(path.join(caseRoot, 'etc', 'systemd', 'system', 'printellect-migration-recover.service')),
        true
      );
      const orderDropin = path.join(
        caseRoot,
        'etc',
        'systemd',
        'system',
        'printellect-migration-recover.service.d',
        '10-legacy-order.conf'
      );
      assert.equal(fs.existsSync(orderDropin), true);
      assert.match(fs.readFileSync(orderDropin, 'utf8'), /^Before=printellect-kiosk\.service$/m);
      assert.equal(
        mock.getUnitState('printellect-migration-recover.service').enabled,
        'enabled',
        `Boot recovery unit MUST be enabled at checkpoint ${phase}`
      );

      // Notably, at legacy_disabled / new_unit_installed / daemon_reloaded, NEITHER daemon unit is enabled — ONLY the recovery unit is!
      if (['legacy_disabled', 'new_unit_installed', 'daemon_reloaded'].includes(phase)) {
        assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'disabled');
        assert.equal(mock.getUnitState('printellect.service').enabled, 'disabled');
      }

      // 2. Simulate cold OS reboot: volatile runtime `.active` states reset to 'inactive'
      for (const u of ['printellect-kiosk.service', 'printellect.service', 'printellect-migration-recover.service']) {
        fs.writeFileSync(path.join(mock.mockStateDir, `${u}.active`), 'inactive');
      }

      // 3. Systemd runs enabled `printellect-migration-recover.service` FIRST (ordered Before= both daemons)
      // Execute the actual copied `/etc/printellect/recover-migration.sh` standalone script!
      const relRecoverScript = path.relative(ROOT_DIR, selfContainedRecoverScript).replace(/\\/g, '/');
      const bootRes = runInstaller(
        ['--reconcile-boot', '--non-blocking-start', '--root-dir', relRoot],
        ROOT_DIR,
        {
          PRINTELLECT_TEST_SYSTEMD: '1',
          PREPEND_PATH: mock.mockBinDir,
        },
        relRecoverScript
      );

      assert.equal(bootRes.status, 0, `Boot reconciliation failed from ${phase}: ${bootRes.stderr}\n${bootRes.stdout}`);

      // 4. Verify post-boot invariants:
      // - Zero dual-daemon concurrency violations at any point
      const violationsPath = path.join(mock.mockStateDir, 'dual_daemon_violations.log');
      assert.equal(
        fs.existsSync(violationsPath) ? fs.readFileSync(violationsPath, 'utf8') : '',
        '',
        'Both daemon instances must NEVER run concurrently'
      );

      // - printellect.service is inactive, disabled, and removed from /etc/systemd/system
      assert.equal(mock.getUnitState('printellect.service').active, 'inactive');
      assert.equal(mock.getUnitState('printellect.service').enabled, 'disabled');
      assert.equal(fs.existsSync(path.join(caseRoot, 'etc', 'systemd', 'system', 'printellect.service')), false);

      // - Legacy service is enabled and active
      assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'enabled');
      assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');

      // - Vendor file untouched, /etc drop-in preserved, printer config preserved, backups preserved
      assert.equal(fs.readFileSync(legacyUnitPath, 'utf8'), legacyContent);
      assert.equal(fs.readFileSync(path.join(etcDropinDir, '10-custom.conf'), 'utf8'), dropinContent);
      const savedPrinterCfg = JSON.parse(
        fs.readFileSync(path.join(caseRoot, 'var', 'lib', 'printellect', 'config.json'), 'utf8')
      );
      assert.deepEqual(savedPrinterCfg, printerCfg);

      const finalMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      assert.equal(finalMeta.status, 'rolled_back');
      assert.equal(finalMeta.checkpointPhase, 'boot_recovered');
      assert.equal(fs.existsSync(path.resolve(ROOT_DIR, finalMeta.unitBackup)), true);

      // - Boot recovery unit disarmed cleanly after reaching terminal rolled_back state
      assert.equal(mock.getUnitState('printellect-migration-recover.service').enabled, 'disabled');
    });
  }

  it('should survive power failure WHILE boot recovery itself is running (rolling_back) and remain idempotent across repeated runs', () => {
    const { caseRoot, relRoot, mock } = seedPowerLossFixture('mid_recovery_power_loss');

    // 1. Crash during forward migration right at legacy_disabled
    const crash1 = runInstaller(
      ['--root-dir', relRoot, '--migrate-legacy', 'auto', '--enable', '--start'],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        PRINTELLECT_TEST_CRASH_AT_PHASE: 'legacy_disabled',
      }
    );
    assert.equal(crash1.status, 137);

    const relRecoverScript = path
      .relative(ROOT_DIR, path.join(caseRoot, 'etc', 'printellect', 'recover-migration.sh'))
      .replace(/\\/g, '/');

    // 2. First boot attempts recovery, AND power fails AGAIN mid-recovery (phase=rolling_back)!
    const crashDuringRecovery = runInstaller(
      ['--reconcile-boot', '--non-blocking-start', '--root-dir', relRoot],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        PRINTELLECT_TEST_CRASH_AT_PHASE: 'rolling_back',
      },
      relRecoverScript
    );
    assert.equal(crashDuringRecovery.status, 137);

    // Confirm status remained 'in_progress' and boot recovery unit remained 'enabled'!
    const metaMid = JSON.parse(fs.readFileSync(path.join(caseRoot, 'etc', 'printellect', 'migration.json'), 'utf8'));
    assert.equal(metaMid.status, 'in_progress');
    assert.equal(metaMid.checkpointPhase, 'rolling_back');
    assert.equal(mock.getUnitState('printellect-migration-recover.service').enabled, 'enabled');

    // 3. Second boot runs recovery uninterrupted -> converges to healthy restored legacy service!
    const secondBoot = runInstaller(
      ['--reconcile-boot', '--non-blocking-start', '--root-dir', relRoot],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
      },
      relRecoverScript
    );
    assert.equal(secondBoot.status, 0, `Second boot recovery failed: ${secondBoot.stderr}\n${secondBoot.stdout}`);
    assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'enabled');
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');
    assert.equal(mock.getUnitState('printellect.service').active, 'inactive');

    // 4. Repeated recovery invocations when rolled_back, completed, or missing metadata are safe no-ops
    const cmdsBeforeRepeat = mock.readCommands().length;
    const repeatRolledBack = runInstaller(
      ['--reconcile-boot', '--non-blocking-start', '--root-dir', relRoot],
      ROOT_DIR,
      { PRINTELLECT_TEST_SYSTEMD: '1', PREPEND_PATH: mock.mockBinDir },
      relRecoverScript
    );
    assert.equal(repeatRolledBack.status, 0);
    assert.match(repeatRolledBack.stdout, /no interrupted migration to reconcile/);
    // Must not have stopped or restarted the running legacy service!
    const newCmds = mock.readCommands().slice(cmdsBeforeRepeat);
    assert.equal(newCmds.some((c) => c.includes('printellect-kiosk.service')), false);
  });

  it('should never follow destination symlinks when restoring unit files during recovery', () => {
    const caseRoot = path.join(tempRoot, 'symlink_restore_guard');
    fs.mkdirSync(caseRoot, { recursive: true });
    const relRoot = path.relative(ROOT_DIR, caseRoot).replace(/\\/g, '/');

    const systemdDir = path.join(caseRoot, 'etc', 'systemd', 'system');
    fs.mkdirSync(systemdDir, { recursive: true });
    const adminLegacyPath = path.join(systemdDir, 'kiosk-daemon.service');
    const origContent = '[Unit]\nDescription=Admin Legacy\n[Service]\nExecStart=/usr/bin/node /opt/old/index.js sid_sym_99\n[Install]\nWantedBy=multi-user.target\n';
    fs.writeFileSync(adminLegacyPath, origContent);

    const legacyWork = path.join(caseRoot, 'var', 'lib', 'printellect');
    fs.mkdirSync(legacyWork, { recursive: true });
    fs.writeFileSync(path.join(legacyWork, 'config.json'), JSON.stringify({ bwPrinter: 'Canon_GX6100', colorPrinter: null }));

    const mock = setupMockSystemd(caseRoot, {
      'kiosk-daemon.service': { active: true, enabled: true },
      'printellect.service': { active: false, enabled: false },
    });

    // Crash at new_unit_installed
    const crash = runInstaller(
      ['--root-dir', relRoot, '--migrate-legacy', 'kiosk-daemon.service', '--enable', '--start'],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        PRINTELLECT_TEST_CRASH_AT_PHASE: 'new_unit_installed',
      }
    );
    assert.equal(crash.status, 137);

    // Replace destination /etc/systemd/system/kiosk-daemon.service with a symlink to a protected target file
    const protectedTarget = path.join(caseRoot, 'protected-victim.txt');
    const protectedContent = 'DO_NOT_OVERWRITE_VIA_SYMLINK';
    fs.writeFileSync(protectedTarget, protectedContent);
    fs.rmSync(adminLegacyPath, { force: true });
    if (createBashSymlink(path.relative(systemdDir, protectedTarget).replace(/\\/g, '/'), adminLegacyPath)) {
      const bootRes = runInstaller(
        ['--reconcile-boot', '--root-dir', relRoot],
        ROOT_DIR,
        { PRINTELLECT_TEST_SYSTEMD: '1', PREPEND_PATH: mock.mockBinDir }
      );
      assert.equal(bootRes.status, 0);
      // Victim file must NOT have been overwritten through the symlink!
      assert.equal(fs.readFileSync(protectedTarget, 'utf8'), protectedContent);
      assert.equal(fs.readFileSync(adminLegacyPath, 'utf8'), origContent);
    }
  });

  it('should abort migration preflight without stopping legacy service if temporary Node 24 canary drop-in is still attached', () => {
    const { caseRoot, relRoot, etcDropinDir, mock } = seedPowerLossFixture('canary_guard');
    fs.writeFileSync(
      path.join(etcDropinDir, '99-printellect-node24-canary.conf'),
      '[Service]\nExecStart=\nExecStart=/opt/printellect/runtime/current/bin/node /home/aaryan/printellect-kiosk-server/index.js prod_station_p44\n'
    );

    const res = runInstaller(
      ['--root-dir', relRoot, '--migrate-legacy', 'auto', '--enable', '--start'],
      ROOT_DIR,
      { PRINTELLECT_TEST_SYSTEMD: '1', PREPEND_PATH: mock.mockBinDir }
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Temporary staged Node\.js 24 canary override detected/);
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');
    assert.equal(fs.existsSync(path.join(caseRoot, 'etc', 'printellect', 'migration.json')), false);
  });

  it('should pass bash -n and reconcile partial new-service install via standalone scripts/recover-migration.sh', () => {
    const syntaxRes = spawnSync('bash', ['-n', 'scripts/recover-migration.sh'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
    assert.equal(syntaxRes.status, 0, `Syntax error in recover-migration.sh: ${syntaxRes.stderr}`);

    const helpRes = spawnSync('bash', ['scripts/recover-migration.sh', '--help'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
    assert.equal(helpRes.status, 0);
    assert.match(helpRes.stdout, /Migration Crash & Boot Recovery/);

    // Simulate partial new-service install (legacy disabled, printellect.service + partial runtime drop-in left behind)
    const { caseRoot, relRoot, mock } = seedPowerLossFixture('partial_new_service_recover');
    const crashRes = runInstaller(
      ['--root-dir', relRoot, '--migrate-legacy', 'auto', '--enable', '--start'],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        PRINTELLECT_TEST_CRASH_AT_PHASE: 'new_unit_installed',
      }
    );
    assert.equal(crashRes.status, 137);

    // Plant partial printellect.service.d/10-runtime.conf artifact
    const partialDropinDir = path.join(caseRoot, 'etc', 'systemd', 'system', 'printellect.service.d');
    fs.mkdirSync(partialDropinDir, { recursive: true });
    fs.writeFileSync(path.join(partialDropinDir, '10-runtime.conf'), '[Service]\nExecStart=\n');

    const recRes = runInstaller(
      ['--root-dir', relRoot, '--non-blocking-start'],
      ROOT_DIR,
      { PRINTELLECT_TEST_SYSTEMD: '1', PREPEND_PATH: mock.mockBinDir },
      'scripts/recover-migration.sh'
    );
    assert.equal(recRes.status, 0, `recover-migration.sh failed: ${recRes.stderr}\n${recRes.stdout}`);
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');
    assert.equal(mock.getUnitState('printellect-kiosk.service').enabled, 'enabled');
    assert.equal(mock.getUnitState('printellect.service').active, 'inactive');
    assert.equal(fs.existsSync(path.join(caseRoot, 'etc', 'systemd', 'system', 'printellect.service')), false);
    assert.equal(fs.existsSync(path.join(partialDropinDir, '10-runtime.conf')), false);
  });

  it('should fail safely without corrupting checkpoint when migration flock is already held, and succeed once lock releases', () => {
    const lockScript = [
      'set -euo pipefail',
      'EXT4_ROOT="$(mktemp -d /tmp/printellect-lock-test.XXXXXX)"',
      'trap \'rm -rf "${EXT4_ROOT}"\' EXIT',
      'mkdir -p "${EXT4_ROOT}/etc/printellect" "${EXT4_ROOT}/etc/systemd/system" "${EXT4_ROOT}/run" "${EXT4_ROOT}/var/lib/printellect/backups" "${EXT4_ROOT}/lib/systemd/system" "${EXT4_ROOT}/mockbin"',
      'cat > "${EXT4_ROOT}/mockbin/systemctl" <<\'SH\'',
      '#!/usr/bin/env bash',
      'if [[ "${1:-}" == "is-active" ]]; then echo "active"; exit 0; fi',
      'exit 0',
      'SH',
      'chmod 0755 "${EXT4_ROOT}/mockbin/systemctl"',
      'export PATH="${EXT4_ROOT}/mockbin:${PATH}"',
      'printf "[Service]\\nExecStart=/usr/bin/node index.js\\n" > "${EXT4_ROOT}/lib/systemd/system/printellect-kiosk.service"',
      'cp "${EXT4_ROOT}/lib/systemd/system/printellect-kiosk.service" "${EXT4_ROOT}/var/lib/printellect/backups/printellect-kiosk.service.bak"',
      'cat > "${EXT4_ROOT}/etc/printellect/migration.json" <<JSON',
      '{',
      '  "schemaVersion": 2,',
      '  "status": "in_progress",',
      '  "checkpointPhase": "legacy_disabled",',
      '  "legacyUnitName": "printellect-kiosk.service",',
      '  "legacyUnitPath": "${EXT4_ROOT}/lib/systemd/system/printellect-kiosk.service",',
      '  "legacyUnitIsVendor": true,',
      '  "unitBackup": "${EXT4_ROOT}/var/lib/printellect/backups/printellect-kiosk.service.bak",',
      '  "wasEnabled": true,',
      '  "wasActive": true',
      '}',
      'JSON',
      '# Hold exclusive flock on ${EXT4_ROOT}/run/printellect-migration.lock in a background subshell',
      '(',
      '  exec 9>"${EXT4_ROOT}/run/printellect-migration.lock"',
      '  flock -x 9',
      '  echo "LOCK_READY" > "${EXT4_ROOT}/lock.ready"',
      '  sleep 2',
      ') &',
      'HOLDER_PID=$!',
      'for i in 1 2 3 4 5 6 7 8 9 10; do [[ -f "${EXT4_ROOT}/lock.ready" ]] && break; sleep 0.1; done',
      'set +e',
      'OUT="$(bash scripts/recover-migration.sh --reconcile-boot --lock-timeout 0 --root-dir "${EXT4_ROOT}" 2>&1)"',
      'RC=$?',
      'set -e',
      'wait "${HOLDER_PID}" || true',
      'echo "RC=${RC}"',
      'echo "${OUT}"',
      '# Checkpoint must remain untouched (in_progress) while lock was held',
      'grep -q \'"status": "in_progress"\' "${EXT4_ROOT}/etc/printellect/migration.json"',
      '# After lock releases, recovery acquires lock and reconciles cleanly',
      'bash scripts/recover-migration.sh --reconcile-boot --lock-timeout 5 --root-dir "${EXT4_ROOT}" >/dev/null',
      'grep -q \'"status": "rolled_back"\' "${EXT4_ROOT}/etc/printellect/migration.json"',
      'echo "POST_UNLOCK_RECOVERED=true"',
    ].join('\n');

    const res = spawnSync('bash', ['-s'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      input: lockScript,
    });
    assert.equal(res.status, 0, `Lock contention test failed: ${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout, /RC=1/);
    assert.match(res.stdout, /lock is already held/);
    assert.match(res.stdout, /POST_UNLOCK_RECOVERED=true/);
  });

  it('should prevent previous-service journal logs or stale MainPID from satisfying a new service health check, and redact diagnostic logs', () => {
    const { relRoot, mock } = seedPowerLossFixture('stale_journal_isolation');

    // Case A: Unscoped journal contains previous PID 1111 readiness logs + raw secrets, while new PID 4242 has not logged readiness
    const staleLogRes = runInstaller(
      [
        '--root-dir', relRoot,
        '--migrate-legacy', 'auto',
        '--enable',
        '--start',
        '--health-timeout', '2',
        '--health-stable-sec', '1',
      ],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        MOCK_HEALTH_MODE: 'stale_previous_pid_logs',
      }
    );

    assert.equal(staleLogRes.status, 1, 'Previous service logs must NOT satisfy new service health gate');
    assert.match(staleLogRes.stderr, /failed post-start health-check gate/);
    assert.equal(mock.getUnitState('printellect-kiosk.service').active, 'active');
    assert.equal(mock.getUnitState('printellect.service').active, 'inactive');

    // Verify raw session secret from journald / process args was redacted in stderr diagnostic dump
    assert.equal(staleLogRes.stdout.includes('leak_test_secret_sid_555'), false);
    assert.equal(staleLogRes.stderr.includes('leak_test_secret_sid_555'), false);
    assert.match(staleLogRes.stderr, /\[REDACTED/);

    // Case B: Already-active printellect.service whose MainPID fails to change on restart -> rejected as stale MainPID
    const { caseRoot: caseRoot2, relRoot: relRoot2, mock: mock2 } = seedPowerLossFixture('stale_pid_upgrade');
    const prodCfgDir2 = path.join(caseRoot2, 'var', 'lib', 'printellect');
    fs.mkdirSync(prodCfgDir2, { recursive: true });
    fs.writeFileSync(
      path.join(prodCfgDir2, 'config.json'),
      JSON.stringify({ bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' }, null, 2) + '\n'
    );
    fs.writeFileSync(path.join(mock2.mockStateDir, 'printellect.service.active'), 'active');

    const stalePidRes = runInstaller(
      [
        '--root-dir', relRoot2,
        '--session-id', 'upgrade_sid_01',
        '--enable',
        '--start',
        '--health-timeout', '2',
        '--health-stable-sec', '1',
      ],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock2.mockBinDir,
        MOCK_HEALTH_MODE: 'healthy',
      }
    );
    assert.equal(stalePidRes.status, 1, 'Unchanged MainPID across restart must be rejected as stale');
    assert.match(stalePidRes.stderr, /stale MainPID \(4242\) unchanged from previous service instance/);
  });

  it('should auto-detect staged Node 24 runtime without --node-bin, leave /usr/bin/node v20 untouched, and rollback cleanly to legacy on v20', () => {
    const { caseRoot, relRoot, mock } = seedPowerLossFixture('staged_node24_default');

    // 1. Plant legacy service running on /usr/bin/node (v20.19.2)
    const usrBinDir = path.join(caseRoot, 'usr', 'bin');
    fs.mkdirSync(usrBinDir, { recursive: true });
    const eolNodeBin = path.join(usrBinDir, 'node');
    fs.writeFileSync(eolNodeBin, '#!/usr/bin/env bash\necho "v20.19.2"\n', { mode: 0o755 });

    // 2. Plant staged Node.js 24 runtime in /opt/printellect/runtime/current/bin/node
    const stagedBinDir = path.join(caseRoot, 'opt', 'printellect', 'runtime', 'current', 'bin');
    fs.mkdirSync(stagedBinDir, { recursive: true });
    const stagedNodeBin = path.join(stagedBinDir, 'node');
    fs.writeFileSync(stagedNodeBin, '#!/usr/bin/env bash\necho "v24.14.0"\n', { mode: 0o755 });

    // 3. Plant release directory at /opt/printellect/current
    const currentRelDir = path.join(caseRoot, 'opt', 'printellect', 'current');
    fs.mkdirSync(currentRelDir, { recursive: true });
    fs.writeFileSync(path.join(currentRelDir, 'index.js'), 'console.log("running daemon");\n');

    // 4. Run installer with --migrate-legacy auto --enable --start (WITHOUT --node-bin!)
    const cutoverRes = runInstaller(
      [
        '--root-dir', relRoot,
        '--migrate-legacy', 'auto',
        '--enable',
        '--start',
        '--health-timeout', '3',
        '--health-stable-sec', '1',
      ],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
        MOCK_HEALTH_MODE: 'healthy',
      }
    );
    assert.equal(cutoverRes.status, 0, `Cutover failed: ${cutoverRes.stderr}\n${cutoverRes.stdout}`);
    assert.match(cutoverRes.stdout, /Detected Node\.js runtime:.*runtime\/current\/bin\/node/);
    assert.match(cutoverRes.stdout, /Health-check gate PASSED/);

    // Verify 10-runtime.conf was generated with staged Node 24
    const dropinPath = path.join(caseRoot, 'etc', 'systemd', 'system', 'printellect.service.d', '10-runtime.conf');
    assert.equal(fs.existsSync(dropinPath), true, 'Runtime drop-in must exist');
    const dropinContent = fs.readFileSync(dropinPath, 'utf8');
    assert.match(dropinContent, /ExecStart=\/opt\/printellect\/runtime\/current\/bin\/node \/opt\/printellect\/current\/index\.js/);

    // Verify /usr/bin/node was NEVER overwritten (still returns v20.19.2)
    const eolReadback = fs.readFileSync(eolNodeBin, 'utf8');
    assert.match(eolReadback, /v20\.19\.2/);

    // 5. Execute rollback -> verifies legacy restored and dropin removed with zero Node.js downgrade
    const rollbackRes = runInstaller(
      ['--root-dir', relRoot, '--rollback'],
      ROOT_DIR,
      {
        PRINTELLECT_TEST_SYSTEMD: '1',
        PREPEND_PATH: mock.mockBinDir,
      }
    );
    assert.equal(rollbackRes.status, 0, `Rollback failed: ${rollbackRes.stderr}\n${rollbackRes.stdout}`);
    assert.equal(fs.existsSync(dropinPath), false, 'Runtime drop-in must be cleaned up on rollback');

    // Check systemctl calls
    const commandsLog = fs.readFileSync(path.join(mock.mockStateDir, 'commands.log'), 'utf8');
    assert.match(commandsLog, /enable printellect-kiosk\.service/);
    assert.match(commandsLog, /start printellect-kiosk\.service/);

    // Verify /usr/bin/node is still untouched v20.19.2
    assert.equal(fs.readFileSync(eolNodeBin, 'utf8'), '#!/usr/bin/env bash\necho "v20.19.2"\n');
  });
});
