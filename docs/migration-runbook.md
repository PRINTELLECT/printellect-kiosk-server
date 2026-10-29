# PRINTELLECT Kiosk Server — Service Migration, Power-Loss Recovery & Cutover Runbook

> **PRODUCTION SAFETY NOTICE**: Systemd service cutover is a **non-atomic, multi-step state transition**. Safety is enforced through side-by-side staged Node.js 24 validation of the legacy daemon before modifying `/usr/bin/node`, write-ahead persistent checkpoints flushed to disk (`sync`), an automated boot-time reconciliation unit (`printellect-migration-recover.service`) that eliminates unrecovered power-loss states without manual intervention, vendor-safe/symlink-safe file operations, an explicit post-start Firebase health gate, and a zero-fallback CUPS printing acceptance gate.

---

## 1. Non-Atomic Transaction & Automated Power-Loss Recovery Design

Migrating from a legacy systemd service (e.g., running as `aaryan` or `pi`) to `printellect.service` (running as unprivileged `printellect` from `/opt/printellect/current`) executes sequential `systemctl` operations (`stop`, `disable`, unit install, `daemon-reload`, `enable`, `start`). **This sequence is NOT atomic.**

To guarantee that sudden power loss, kernel panic, SSH drop, or `SIGKILL` at **any** checkpoint results in a functioning service on reboot without human intervention, `scripts/install-service.sh` and `systemd/printellect-migration-recover.service` enforce the following recovery architecture:

### 1.1 Write-Ahead Persistent Checkpoint & Boot Recovery Arming
Before `systemctl stop <legacy>` or `systemctl disable <legacy>` is ever called:
1. Dereferenced backups of the legacy unit and drop-in files are written to `/var/lib/printellect/backups/` (`0700`, `root:root`) and verified byte-for-byte (`cmp -s` + SHA-256).
2. Pre-migration state (`schemaVersion: 2`, `legacyUnitName`, `legacyUnitPath`, `legacyUnitIsVendor`, `legacyUnitIsSymlink`, `legacySymlinkTarget`, `unitBackup`, `unitBackupSha256`, `wasEnabled`, `wasActive`, `checkpointPhase: "checkpoint_saved"`, `status: "in_progress"`) is atomically written (`mv -f`) to `/etc/printellect/migration.json` (`0600`) and flushed (`sync`).
3. Exclusive lock `/run/printellect-migration.lock` is acquired via `flock`.
4. `arm_boot_recovery_unit` atomically installs a standalone copy of the migrator to `/etc/printellect/recover-migration.sh` (`0700`, `root:root`), installs `/etc/systemd/system/printellect-migration-recover.service` (`0644`), writes `/etc/systemd/system/printellect-migration-recover.service.d/10-legacy-order.conf` (`Before=<legacy-unit>.service`), enables `printellect-migration-recover.service` in `multi-user.target.wants`, and runs `sync`.

### 1.2 Boot Reconciliation Ordering & Mutual Exclusion (Zero Dual-Daemon Concurrency)
- `printellect-migration-recover.service` is `Type=oneshot` (`RemainAfterExit=yes`) with `ConditionPathExists=/etc/printellect/migration.json`, `Before=printellect.service`, and `Before=<legacy-unit>.service`.
- On boot, systemd executes `/bin/bash /etc/printellect/recover-migration.sh --reconcile-boot --non-blocking-start` **before either daemon unit is allowed to start**:
  1. Acquires `/run/printellect-migration.lock` (`flock`).
  2. Parses `/etc/printellect/migration.json` (pure-POSIX fallback works even if `/opt/printellect` or Node.js is unavailable). If `status != "in_progress"`, disables itself and exits `0` cleanly.
  3. Transitions `checkpointPhase` to `"rolling_back"` (`status: "in_progress"`) and flushes to disk before mutating units.
  4. Stops, kills (`--kill-who=all`), disables, and removes `/etc/systemd/system/printellect.service` (and `10-runtime.conf`) **first**, ensuring `printellect.service` cannot run concurrently with `<legacy-unit>.service`.
  5. Restores the legacy unit, symlink, and `/etc` drop-ins atomically (using temp-file + `mv -f` so destination symlinks are never followed and vendor directories `/lib/systemd/system`, `/usr/lib/systemd/system`, `/usr/local/lib/systemd/system` are never touched), strips any stray `99-printellect-node24-canary.conf`, runs `systemctl daemon-reload`, re-enables `<legacy-unit>.service` (if `wasEnabled=true`), and enqueues `systemctl start --no-block <legacy-unit>.service` (if `wasActive=true`) so systemd starts the legacy daemon immediately upon oneshot completion without boot-transaction deadlock.
  6. Commits `status: "rolled_back"`, `checkpointPhase: "boot_recovered"`, flushes to disk (`sync`), and disarms `printellect-migration-recover.service`.

### 1.3 What Happens If Power Fails *While Recovery Itself Is Running*?
- Before mutating any unit or enablement state, `perform_rollback_from_metadata` writes `status: "in_progress"`, `checkpointPhase: "rolling_back"` to `/etc/printellect/migration.json` and leaves `printellect-migration-recover.service` enabled until Step 7 (`status: "rolled_back"`).
- Every operation inside `perform_rollback_from_metadata` is idempotent (`rm -f`, atomic temp-file + `mv -f`, `ln -sfn`, `systemctl disable`, `systemctl enable`, `systemctl start --no-block`), and permanent backups in `/var/lib/printellect/backups/` are never deleted or consumed.
- Therefore, if a second power loss strikes mid-recovery (`checkpointPhase: "rolling_back"`), the next boot re-triggers `printellect-migration-recover.service`, re-runs the idempotent restoration sequence from the intact backups, restores `<legacy-unit>.service`, commits `status: "rolled_back"`, and disarms the recovery unit.

### 1.4 Checkpoint-by-Checkpoint Reboot & Power-Loss Matrix

| Checkpoint (`checkpointPhase`) | On-Disk / Systemd State at Interruption | Inline Failure Recovery (`ERR`/`INT`/`TERM`) | Unattended Power-Loss / Reboot Behavior | Final Service State After Boot |
|---|---|---|---|---|
| **0. `preflight`** (before `checkpoint_saved`) | Legacy service `active` + `enabled`; `migration.json` not yet written. | Script exits `1`; zero service mutations occurred. | Normal boot; legacy service starts via existing `WantedBy=` symlink. | `<legacy>` `active` + `enabled`; `printellect` absent. |
| **1. `checkpoint_saved`** | Backup verified; `migration.json` (`in_progress`); `printellect-migration-recover.service` armed; legacy still `active` + `enabled`. | Trap runs rollback -> legacy remains `active` + `enabled`; recovery unit disarmed. | `printellect-migration-recover.service` runs before `<legacy>`, verifies unit/drop-ins, marks `rolled_back` (`boot_recovered`), disarms itself. | `<legacy>` `active` + `enabled`; `printellect` absent. |
| **2. `legacy_stopped`** | Legacy stopped (`inactive`), still `enabled`; recovery unit armed. | Trap runs rollback -> restarts `<legacy>`, marks `rolled_back`, disarms recovery unit. | Boot recovery reconciles `in_progress`, verifies legacy unit/drop-ins, ensures `enabled`, enqueues `--no-block` start, marks `rolled_back`. | `<legacy>` `active` + `enabled`; `printellect` absent. |
| **3. `legacy_disabled`** | Legacy `inactive` + **`disabled`**; `printellect.service` not yet installed/enabled; recovery unit armed. | Trap runs rollback -> re-enables & starts `<legacy>`, marks `rolled_back`. | **Previously stranded without recovery unit.** Now `printellect-migration-recover.service` runs at boot, re-enables `<legacy>`, enqueues `--no-block` start, marks `rolled_back`, disarms itself. | `<legacy>` `active` + `enabled`; `printellect` absent. |
| **4. `new_unit_installed`** | Legacy `inactive` + `disabled`; `/etc/systemd/system/printellect.service` written; not enabled. | Trap removes `printellect.service`, reloads, re-enables & starts `<legacy>`. | Boot recovery removes `printellect.service` (& `10-runtime.conf`), reloads systemd, re-enables & starts `<legacy>`, marks `rolled_back`. | `<legacy>` `active` + `enabled`; `printellect` removed. |
| **5. `daemon_reloaded`** | Same as above after `systemctl daemon-reload`. | Trap removes `printellect.service`, reloads, re-enables & starts `<legacy>`. | Boot recovery removes `printellect.service`, reloads systemd, re-enables & starts `<legacy>`, marks `rolled_back`. | `<legacy>` `active` + `enabled`; `printellect` removed. |
| **6. `new_service_enabled`** | Legacy `disabled`; `printellect.service` `enabled` (not yet health-verified). | Trap disables & removes `printellect.service`, reloads, re-enables & starts `<legacy>`. | Boot recovery runs `Before=printellect.service`, disables & removes `printellect.service` before it can launch, reloads, re-enables & starts `<legacy>`. | `<legacy>` `active` + `enabled`; `printellect` removed (never started concurrently). |
| **7. `new_service_started`** | `printellect.service` started, health gate incomplete or failed. | Health gate / trap stops, disables & removes `printellect.service`, restores, re-enables & starts `<legacy>`. | Boot recovery runs `Before=printellect.service`, stops/disables/removes unverified `printellect.service`, restores, re-enables & starts `<legacy>`. | `<legacy>` `active` + `enabled`; `printellect` removed. |
| **8. `rolling_back`** *(power loss mid-recovery)* | Partial rollback in flight; `migration.json` still `status: "in_progress"`; backups intact; recovery unit still enabled. | Re-running `--rollback` or `--reconcile-boot` completes idempotently. | Next boot re-triggers `printellect-migration-recover.service`, re-applies idempotent cleanup + restore, marks `rolled_back`, disarms itself. | `<legacy>` `active` + `enabled`; `printellect` removed. |
| **9. `health_check_passed` (`completed`)** | `printellect.service` passed Firebase + listener + PID stability hold; recovery unit disarmed. | Migration complete (operator `--rollback` remains available at any time). | Normal boot; `printellect.service` starts directly. | `printellect.service` `active` + `enabled`. |

---

## 2. Validating the Legacy Daemon Under Staged Node.js 24 (Before Touching `/usr/bin/node`)

Static syntax checks (`node --check`) and native-addon ABI scans (`process.dlopen`) are necessary prechecks, but they do not prove live runtime behavior (ESM loader resolution, TLS/gRPC/WebSocket transport to Firebase, Firestore `onSnapshot` listener readiness, and clean `SIGTERM` shutdown) under Node.js 24.

### 2.1 Side-by-Side Staging & Gated Single-Instance Validation (`validate-legacy-node24.sh`)
1. `scripts/stage-node-runtime.sh` extracts official Linux ARM64 Node.js 24 LTS (`node-v24.x.y-linux-arm64.tar.xz`) verified against `SHASUMS256.txt` into `/opt/printellect/runtime/current/bin/node` **without** touching `/usr/bin/node`, `apt` sources, or the running Node.js 20 process.
2. `scripts/validate-legacy-node24.sh` tests the **actual legacy systemd service** under `/opt/printellect/runtime/current/bin/node`:
   - **Explicit Operator Gate**: `--run-validation` refuses to run unless `--confirm-restart` is supplied.
   - **Zero Concurrent Listeners**: Instead of spawning a second parallel `node index.js` process (which would attach a duplicate Firebase `onSnapshot` listener for the same `KIOSK_SESSION_ID` and risk double-printing jobs), it writes a temporary systemd drop-in `/etc/systemd/system/<legacy>.service.d/99-printellect-node24-canary.conf` overriding **only** the leading node binary in `ExecStart=` and runs `systemctl restart <legacy>.service`.
   - **Full Context Preservation**: Preserves original `User=`, `Group=`, `WorkingDirectory=`, `Environment=`, `EnvironmentFile=`, `KIOSK_SESSION_ID`, `config.json`, existing drop-ins (`override.conf`), and unit dependencies (`After=`, `Wants=`).
   - **Live Verification Criteria**: Verifies `ActiveState=active`, `NRestarts=0`, `/proc/<MainPID>/exe` pointing to `/opt/printellect/runtime/.../bin/node`, `Connected to Firebase.` + `Listening for print jobs` in `journald`, sustained PID stability across `--stable-sec`, and clean `SIGTERM` shutdown (`systemctl stop`).
   - **Deterministic Restoration**: Automatically removes `99-printellect-node24-canary.conf`, runs `systemctl daemon-reload`, restarts `<legacy>.service` on its pre-test baseline, and verifies `/usr/bin/node` was untouched—even if validation fails or is interrupted (`ERR`/`INT`/`TERM` trap + standalone `--restore` command).

### 2.2 Recovery & Rollback Runtime Invariant
- Under the default deployment procedure, `/usr/bin/node` and system `apt` packages are **never modified**. The new service runs directly on the staged Node.js 24 runtime (`/opt/printellect/runtime/current/bin/node`).
- If migration fails or rollback is invoked, the legacy service is restored immediately on its untouched, pre-existing runtime (`/usr/bin/node`) with **zero Node.js package downgrade or apt manipulation required**.
- **EOL Runtime Policy**: **Node.js 20 reached End-of-Life on 2026-04-30** and should not be retained long-term. Under the staged deployment strategy, Node.js 24 LTS (supported through April 2028) powers `printellect.service` securely in isolation, avoiding both an unverified global runtime upgrade and any reliance on reinstalling an EOL runtime during rollback.

---

## 3. Release Verification & Bootstrap Boundary

1. **Four-Link Cryptographic Trust Chain**:
   - **Trust Anchor**: `keys/release-key.pub.pem`, permanently embedded inside `scripts/bootstrap.sh` (`DEFAULT_PUBLIC_KEY`). The trust anchor must be obtained from an independently trusted source (e.g., an authenticated git checkout). Never trust a public key or `SHA256SUMS` file downloaded from the same untrusted release URL.
   - **Signed Manifest**: `manifest.json.sig` (64-byte Ed25519) authenticates `manifest.json`.
   - **Archive Size & Hash**: `manifest.json` specifies `archive.filename`, `archive.sizeBytes`, and `archive.sha256`.
   - **File Allowlist & Provenance**: `manifest.json` specifies `sourceFiles` SHA-256 for all 15 source files. Extracted files are checked against these digests; any symbolic links, hardlinks, traversal paths, or unauthorized files trigger immediate abort before mutating production directories.
2. **Guarded Key Override & Safe Rotation**:
   - `bootstrap.sh` automatically uses the pinned production public key.
   - Supplying an unpinned `--pubkey` is rejected with `TRUST ANCHOR VIOLATION` unless `--allow-untrusted-pubkey` is explicitly set (for test harnesses or key-rotation drills).
   - Key rotation follows a 2-step process: (1) distribute an update containing the new public key signed by the existing key; (2) cut over to signing subsequent releases with the new private key.
3. **Bootstrap vs. Cutover Separation (`bootstrap.sh`)**:
   - `bootstrap.sh --dry-run` validates all cryptographic and structural checks without modifying any files or services.
   - `bootstrap.sh` (live staging) unpacks to `/opt/printellect/releases/<ver>`, runs `npm ci --omit=dev` using staged Node.js 24, links `/opt/printellect/current`, creates `/usr/local/bin/printellect-setup`, and writes `/etc/printellect/kiosk.env` (`0640`). It does **not** stop, restart, or alter any systemd service. Service cutover is strictly gated in `install-service.sh`.

---

## 4. End-to-End CUPS Printing Acceptance Gate (`verify-print-acceptance.js`)

Checking `lpstat -p` proves queue visibility, **not** end-to-end printing capability under the hardened `printellect` service account. During the maintenance window, `scripts/verify-print-acceptance.js` enforces two gates as `sudo -u printellect`:

1. **Queue Readiness Gate (`--check-queues`)**:
   - Loads `/var/lib/printellect/config.json` with `allowLegacyFallback: false`.
   - Verifies each configured role (`bwPrinter`, `colorPrinter`) exists in `lpstat -p`, is not `disabled`, and reports `accepting requests` in `lpstat -a`. Explicitly reports `QUEUE_PREFLIGHT_ONLY` (never claims physical print success).
2. **Controlled Single-Queue Print Gate (`--submit-test-job`)**:
   - Generates a spec-compliant 1-page A4 `%PDF-1.4` test sheet (`--generate-test-pdf`) stamped with UTC timestamp, user `printellect`, target queue, and exact CUPS options.
   - Calls production `printer.print()` directly for `--role bw` (`ColorModel=Gray`) and/or `--role color` (`ColorModel=RGB`), verifying `sides=one-sided` vs `sides=two-sided-long-edge` (`--duplex`) and `-n <copies>` (`--copies`).
   - **Zero Silent Fallback**: Never falls back to another printer if the requested role is unconfigured or fails submission.
   - Polls `lpstat -W not-completed -o <queue>` until CUPS spool completion (canceling stuck jobs via `cancel <jobId>` on timeout or mid-job printer fault), and requires **human visual confirmation of the physical printed sheet(s)** in the output tray before final cutover sign-off.

---

## 5. Reviewed, Ordered Maintenance-Window Runbook

> **AUTHORIZATION GATE**: Do **not** execute any step on the production Raspberry Pi without explicit phase authorization. Schedule during a maintenance window with an on-site operator able to inspect physical printer output trays.

### Phase I — Read-Only Production Preflight
> **State Impact**: `[READ-ONLY]` — Zero modifications to filesystem, packages, or services.
Transfer signed `dist/`, `keys/release-key.pub.pem`, `scripts/bootstrap.sh`, `scripts/stage-node-runtime.sh`, `scripts/validate-legacy-node24.sh`, and `scripts/recover-migration.sh` to `/tmp/printellect-preflight` on the Pi (after verifying locally with `node scripts/verify-release.js dist/manifest.json dist/manifest.json.sig --check-workspace`).

```bash
# 1. [READ-ONLY] Verify host architecture, disk space (>= 250 MB free), CUPS, and active legacy unit
uname -m
df -h / /var /opt
systemctl is-active cups
lpstat -p && lpstat -a
systemctl list-units --type=service | grep -iE '(printellect|kiosk)'
/usr/bin/node -v

# 2. [READ-ONLY] Verify signed release bundle in read-only dry-run mode
#    (Automatically authenticates against pinned public key; session ID masked in output)
cd /tmp/printellect-preflight
sudo bash bootstrap.sh --session-id "<KIOSK_SESSION_ID>" --local-release-dir ./dist --skip-printer-setup --dry-run
```
- **Abort Criteria**: Architecture != `aarch64`, free disk < `250 MB`, `cups` inactive, CUPS queues disabled/rejecting jobs, multiple ambiguous legacy kiosk units running, active print jobs in queue, or `bootstrap.sh --dry-run` cryptographic signature/checksum failure.

---

### Phase II — Side-by-Side Node.js 24 Staging & Gated Legacy Daemon Validation (`/usr/bin/node` Untouched)
*(Execute only after cutover window authorization.)*
> **State Impact**: 
> 1: `[MUTATES SYSTEM STATE]` extracts `/opt/printellect/runtime/current` and versioned directory; leaves `/usr/bin/node` untouched.
> 2: `[READ-ONLY]` dry-run.
> 3: `[MUTATES SYSTEM STATE]` applies temporary drop-in `99-printellect-node24-canary.conf`, restarts legacy daemon, validates health, and restores baseline on exit.

```bash
# 1. [MUTATES SYSTEM STATE] Stage official Node.js 24 LTS into /opt/printellect/runtime/current (verifies SHA-256; /usr/bin/node untouched)
sudo bash /tmp/printellect-preflight/stage-node-runtime.sh \
  --version v24.14.0 \
  --validate-workdir <LEGACY_WORKDIR>

# 2. [READ-ONLY] Dry-run legacy canary inspection
sudo bash /tmp/printellect-preflight/validate-legacy-node24.sh --dry-run --legacy-unit auto

# 3. [MUTATES SYSTEM STATE] Execute gated single-instance validation of the live legacy daemon on staged Node.js 24
#    (Temporarily applies 99-printellect-node24-canary.conf, verifies Firebase + listener + clean stop, and restores baseline)
sudo bash /tmp/printellect-preflight/validate-legacy-node24.sh \
  --run-validation \
  --confirm-restart \
  --legacy-unit auto \
  --timeout 25 \
  --stable-sec 5
```
- **Abort Criteria**: `stage-node-runtime.sh` reports SHA-256 mismatch or native `.node` ABI error; or `validate-legacy-node24.sh` fails readiness/stability/shutdown checks (script automatically removes `99-printellect-node24-canary.conf` and restores `<legacy>.service`; verify with `systemctl is-active <legacy>.service` and `/usr/bin/node -v`).

---

### Phase III — Release Staging via `bootstrap.sh` (Live Legacy Service Still Running Untouched)
> **State Impact**: `[MUTATES SYSTEM STATE]` — Creates `/opt/printellect/releases/<ver>`, runs `npm ci --omit=dev` via staged Node 24, links `/opt/printellect/current`, creates `/usr/local/bin/printellect-setup`, writes `/etc/printellect/kiosk.env` (`0640`). Live legacy daemon remains untouched and active.

```bash
# 1. [MUTATES SYSTEM STATE] Extract verified release to /opt/printellect/releases/<ver> (authenticates with pinned key)
sudo bash /tmp/printellect-preflight/bootstrap.sh \
  --session-id "<KIOSK_SESSION_ID>" \
  --local-release-dir /tmp/printellect-preflight/dist \
  --skip-printer-setup

# 2. [READ-ONLY] Validate extracted release modules under staged Node.js 24
sudo bash /opt/printellect/current/scripts/stage-node-runtime.sh \
  --validate-only \
  --validate-workdir /opt/printellect/current
```
- **Abort Criteria**: `bootstrap.sh` or `npm ci --omit=dev` fails. Legacy daemon was never stopped or modified; delete `/opt/printellect/releases/<ver>` if needed and abort.

---

### Phase IV — Default Runtime Path: Staged Node.js 24 Execution
> **State Impact**: `[READ-ONLY]` — Zero modifications.
>
> The preferred deployment runs `printellect.service` directly with `/opt/printellect/runtime/current/bin/node`.
> - `/usr/bin/node` is left **completely untouched**.
> - Global apt packages are not modified.
> - Legacy service continues executing under its original runtime until cutover.
> - Rollback requires zero Node.js package downgrade.
> *(For administrators desiring an optional system-wide upgrade to retire EOL Node.js 20 globally, see Section 7.)*

---

### Phase V — Systemd Service Cutover (`install-service.sh`)
> **State Impact**: `[MUTATES SYSTEM STATE]` —
> 1: `[READ-ONLY]` preflight and dry-run.
> 2: (if clean install): writes `/var/lib/printellect/config.json`.
> 3: acquires `/run/printellect-migration.lock`, writes `/var/lib/printellect/backups/`, writes `/etc/printellect/migration.json`, arms `printellect-migration-recover.service`, stops and disables legacy unit, installs `/etc/systemd/system/printellect.service` and `/etc/systemd/system/printellect.service.d/10-runtime.conf` pointing to staged Node 24, enables and starts `printellect.service`, verifies health gate, and disarms recovery unit upon completion.

```bash
# 1. [READ-ONLY] Read-only service preflight and dry-run
sudo bash /opt/printellect/current/scripts/install-service.sh --preflight-only --migrate-legacy auto
sudo bash /opt/printellect/current/scripts/install-service.sh --dry-run --migrate-legacy auto --enable --start

# 2. [MUTATES SYSTEM STATE] (Clean Install Only) Configure CUPS printers non-interactively if no config.json exists
#    (Automatically invokes staged Node.js 24 via bin/printellect-setup wrapper)
sudo printellect-setup --bw Canon_GX6100 --color Canon_GX6100

# 3. [MUTATES SYSTEM STATE] Execute migration cutover
#    (Automatically detects /opt/printellect/runtime/current/bin/node and generates 10-runtime.conf)
sudo bash /opt/printellect/current/scripts/install-service.sh --migrate-legacy auto --enable --start

# 4. [READ-ONLY] Verify single daemon process and completed checkpoint
sudo cat /etc/printellect/migration.json    # Must show "status": "completed", "checkpointPhase": "health_check_passed"
ps -eo user,pid,cmd | grep '[n]ode'         # Must show ONLY user 'printellect' running staged node
```
- **Abort Criteria**: If `printellect.service` fails the post-start health gate, `install-service.sh` automatically rolls back to `<legacy-unit>.service`. Confirm `<legacy-unit>.service` is `active` and stop.

---

### Phase VI — End-to-End Physical CUPS Printing Acceptance Gate (Mandatory Before Final Sign-Off)
> **State Impact**: `[MUTATES PRINTER]` (2 & 3: prints test sheets on physical hardware).

```bash
# 1. [READ-ONLY] Verify config.json readability and CUPS queue enabled/accepting state as unprivileged 'printellect' user
sudo -u printellect /opt/printellect/runtime/current/bin/node /opt/printellect/current/scripts/verify-print-acceptance.js --check-queues

# 2. [MUTATES PRINTER] Submit controlled 1-page B&W grayscale single-sided acceptance print (if bwPrinter configured)
sudo -u printellect /opt/printellect/runtime/current/bin/node /opt/printellect/current/scripts/verify-print-acceptance.js \
  --submit-test-job --role bw --color false --duplex false --copies 1 --generate-test-pdf --wait-completion-sec 45

# 3. [MUTATES PRINTER] Submit controlled Color RGB duplex acceptance print (if colorPrinter configured and supports duplex; else --duplex false)
sudo -u printellect /opt/printellect/runtime/current/bin/node /opt/printellect/current/scripts/verify-print-acceptance.js \
  --submit-test-job --role color --color true --duplex true --copies 1 --generate-test-pdf --wait-completion-sec 60
```
- **On-Site Physical Acceptance Checklist**:
  1. Both commands report `Spool Status : cups_spool_completed` with zero fallback.
  2. Physical B&W sheet exits into **Tray 1** rendered in grayscale, 1-sided, 1 copy.
  3. Physical Color sheet exits into **Tray 2** (or shared queue tray) rendered in RGB color with requested duplex/simplex setting.
  4. **Physical Collection-Door Gate**: Because the physical door controller firmware and Firebase Cloud Functions (`kioskDoorCommand` / `kioskDoorAck`) reside outside this repository, perform live hardware validation:
     - Submit a paid test print job through the kiosk application. Confirm that upon successful completion, the physical collection door unlocks (`door.command: open`), the user collects the output, and upon door closing, the job transitions to `status: delivered`.
     - Verify that an unsuccessful or canceled job transitions to `status: failed` in Firestore and that the physical collection door remains **locked**.
  4. `lpstat -W not-completed` shows zero stuck jobs and `journalctl -u printellect.service -n 50 --no-pager` shows zero errors.
- **Abort Criteria**: If any queue fails submission, times out, faults, routes to the wrong physical printer, or produces corrupted output, execute **Immediate Rollback** below.

---

## 6. Deterministic Rollback Instructions

### Automated Operator Rollback
```bash
sudo bash /opt/printellect/current/scripts/install-service.sh --rollback
```
Post-rollback verification:
```bash
sudo systemctl is-active printellect.service || true          # Must be: inactive
sudo systemctl is-enabled printellect-migration-recover.service || true # Must be: disabled
sudo systemctl status <legacy-unit>.service --no-pager        # Must be: active (running) on Node.js 24 LTS
ps -eo user,pid,cmd | grep '[n]ode'                           # Must show ONLY single legacy daemon process
sudo cat /etc/printellect/migration.json                      # Must show: "status": "rolled_back"
ls -la /var/lib/printellect/backups/                          # Backups remain permanently preserved
```

### Unattended Power-Loss Recovery Verification (Post-Outage Check)
If power was lost mid-cutover and the Raspberry Pi rebooted before cutover finished:
```bash
sudo journalctl -u printellect-migration-recover.service -b --no-pager
sudo cat /etc/printellect/migration.json                      # Shows "status": "rolled_back", "checkpointPhase": "boot_recovered"
sudo systemctl status <legacy-unit>.service --no-pager        # Confirmed active (running)
```

---

## 7. Local Development Verification Suite (Zero Hardware / Zero Production Access)

```bash
bash -n scripts/install-service.sh scripts/recover-migration.sh scripts/validate-legacy-node24.sh scripts/stage-node-runtime.sh scripts/bootstrap.sh
systemd-analyze verify systemd/printellect.service systemd/printellect-migration-recover.service
node scripts/package-release.js --key .keys/release-key.pem
node scripts/verify-release.js dist/manifest.json dist/manifest.json.sig keys/release-key.pub.pem --check-workspace
node --test
```
