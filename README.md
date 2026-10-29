# PRINTELLECT Kiosk Daemon (`printellect-kiosk-server`)

Production printing daemon, cryptographic release packager, side-by-side Node.js 24 runtime validator, `systemd` migration/crash-recovery controller, and CUPS physical print-acceptance tooling for **PRINTELLECT** self-service printing kiosks.

- **Target Hardware & OS**: Raspberry Pi 4 Model B, Debian GNU/Linux 13 (Trixie), `ARM64` (`aarch64`)
- **Target Printer Stack**: CUPS (`cups.service`, `cups-client`, `ipp-usb`), Canon GX6100-series printer
- **Runtime Requirement**: Node.js 24 LTS (`>= 24.0.0`, e.g. `v24.14.0` `linux-arm64`)
- **Cloud Backend**: Firebase v12 (`firebase@12.16.0` Firestore `print-jobs` real-time listener + Firebase Storage PDF downloads)

---

## 1. Repository, Package & Service Naming Reconciliation

| Artifact / Layer | Identifier | Purpose |
|---|---|---|
| **GitHub Repository** | `PRINTELLECT/printellect-kiosk-server` | Canonical upstream Git repository and GitHub Releases host |
| **NPM Package & Archive Stem** | `printellect-kiosk-daemon` (`printellect-kiosk-daemon-<ver>.tar.gz`) | Node.js ESM package (`package.json`) and signed release tarball |
| **Production Install Root** | `/opt/printellect/releases/<ver>` (`/opt/printellect/current` symlink) | Immutable root-owned release tree |
| **Staged Runtime Root** | `/opt/printellect/runtime/node-v24.x.y-linux-arm64` (`/opt/printellect/runtime/current`) | Side-by-side official Node.js 24 LTS runtime staged before altering `/usr/bin/node` |
| **Persistent State & Backups** | `/var/lib/printellect/config.json` & `/var/lib/printellect/backups/` | Printer role mapping (`0644`) and permanent pre-migration unit backups (`0700`) |
| **Environment & Checkpoints** | `/etc/printellect/kiosk.env` & `/etc/printellect/migration.json` | Masked `KIOSK_SESSION_ID` (`0640`) and write-ahead cutover state (`0600`) |
| **Production `systemd` Unit** | `printellect.service` | Hardened daemon unit running as unprivileged `printellect` user (`SupplementaryGroups=lp`) |
| **Boot Crash-Recovery Unit** | `printellect-migration-recover.service` (`/etc/printellect/recover-migration.sh`) | Armed only during active migration (`status: "in_progress"`); reconciles interrupted cutovers on power loss before either daemon starts |

---

## 2. Privilege Separation Matrix (`root` vs. `printellect`)

| Operation / Resource | Execution Principal | Access & Hardening Boundary |
|---|---|---|
| Release staging (`scripts/bootstrap.sh`) | `root` (`sudo`) | Verifies Ed25519 signature + SHA-256 + per-file digests; writes `/opt/printellect/releases/<ver>` (`root:root`, `0755`) and `/etc/printellect/kiosk.env` (`root:printellect`, `0640`). Does **not** stop or cut over services. |
| Side-by-side Node 24 staging (`scripts/stage-node-runtime.sh`) | `root` (`sudo`) | Verifies official `SHASUMS256.txt`; extracts `/opt/printellect/runtime/current` (`root:root`, `0755`); leaves `/usr/bin/node` and `apt` untouched. |
| Legacy Node 24 canary (`scripts/validate-legacy-node24.sh`) | `root` (`sudo`) | Requires `--run-validation --confirm-restart`; applies temporary `99-printellect-node24-canary.conf` drop-in on existing service (zero dual listeners) and deterministically restores baseline. |
| Service cutover & rollback (`scripts/install-service.sh`, `scripts/recover-migration.sh`) | `root` (`sudo`) | Holds exclusive `flock` (`/run/printellect-migration.lock`), writes `/var/lib/printellect/backups/` (`0700`), manages `/etc/systemd/system/printellect*.service`, and enforces PID-scoped `journald` health gate. |
| Interactive printer wizard (`sudo printellect-setup`) | `root` or `printellect` | Writes validated CUPS queue names atomically (`config.json.tmp.<pid>` -> `renameSync`) to `/var/lib/printellect/config.json`. |
| Production daemon (`index.js` under `printellect.service`) | `printellect:printellect` (`SupplementaryGroups=lp`, `/usr/sbin/nologin`) | `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `ProtectKernelTunables=true`, `ProtectKernelModules=true`, `ProtectControlGroups=true`, `RestrictSUIDSGID=true`, `ReadWritePaths=/var/lib/printellect /tmp`. Communicates outbound over HTTPS/TLS to Firebase and locally to `/run/cups/cups.sock`. Binds **zero** listening network ports. |
| End-to-end print acceptance (`scripts/verify-print-acceptance.js`) | `printellect` (`sudo -u printellect`) | Tests exact production service-account readability of `/var/lib/printellect/config.json` and CUPS `lp`/`lpstat`/`cancel` execution without root privileges. |

---

## 3. Cryptographic Trust Anchor & Release Verification

Every production release bundle consists of:
- `printellect-kiosk-daemon-<version>.tar.gz` — Deterministic POSIX `ustar` archive (`15` mandatory runtime/installer/systemd/recovery files + `release.json` = `16` archive entries; zero secrets, zero symlinks/hardlinks).
- `manifest.json` — `schemaVersion: 2` metadata containing `archive.sha256`, `archive.sizeBytes`, `commit`, `sourceDateEpoch`, and per-file `sourceFiles` SHA-256 digests.
- `manifest.json.sig` — Raw 64-byte Ed25519 signature over `manifest.json`.
- `SHA256SUMS` — SHA-256 checksum manifest covering the release archive and standalone deployment scripts.
- `keys/release-key.pub.pem` — Official Ed25519 public verification key:
  ```text
  -----BEGIN PUBLIC KEY-----
  MCowBQYDK2VwAyEAYgGBLvQx7mUYr8rB0v21gNBFZ/V1MDjuxyc74XWRzJw=
  -----END PUBLIC KEY-----
  ```

### Trust-Anchor Boundary
`scripts/bootstrap.sh` embeds `DEFAULT_PUBLIC_KEY` (matching `keys/release-key.pub.pem`) to authenticate `manifest.json` before reading any manifest field or extracting any archive byte. Because `bootstrap.sh` carries that trust anchor, **always verify `SHA256SUMS` (and confirm `DEFAULT_PUBLIC_KEY` inside `bootstrap.sh`) before executing `sudo bash bootstrap.sh`**. Never pipe unverified HTTP URLs into `sudo bash`.

### Offline / Pre-Transfer Verification Commands
```bash
# 1. Verify bundle SHA-256 checksums
sha256sum -c SHA256SUMS

# 2. Verify Ed25519 manifest signature directly with OpenSSL
openssl pkeyutl -verify -pubin -inkey release-key.pub.pem \
  -rawin -in manifest.json -sigfile manifest.json.sig

# 3. Run full Node.js release & per-file archive verifier (add --check-workspace inside git repo)
node scripts/verify-release.js dist/manifest.json dist/manifest.json.sig keys/release-key.pub.pem --check-workspace
```

---

## 4. Pre-Deployment Checklist (Raspberry Pi 4 — Debian 13 ARM64)

Before starting a maintenance window on the Raspberry Pi, confirm all items below:

- [ ] On-site operator is physically present at the kiosk to inspect Canon GX6100 printed output trays.
- [ ] `uname -m` reports `aarch64`.
- [ ] `df -m / /opt /var` shows at least `250 MB` free space (`>= 1 GB` recommended for Node.js 24 runtime staging).
- [ ] `systemctl is-active cups` reports `active`, and `lpstat -p && lpstat -a` shows the Canon GX6100 queue(s) enabled and `accepting requests`.
- [ ] `lpstat -W not-completed` is empty (no active customer print jobs in flight).
- [ ] Exactly one legacy kiosk service unit is active (`systemctl list-units --type=service | grep -iE '(printellect|kiosk)'`), or this is a clean first-time installation.
- [ ] Station `KIOSK_SESSION_ID` is confirmed (alphanumeric / `_.:@-`, 1–128 chars) and ready to pass via `--session-id` (never commit it to git).
- [ ] Release bundle files (`printellect-kiosk-daemon-1.0.0.tar.gz`, `manifest.json`, `manifest.json.sig`, `SHA256SUMS`, `release-key.pub.pem`, `bootstrap.sh`, `stage-node-runtime.sh`, `validate-legacy-node24.sh`, `recover-migration.sh`) have been copied to `/tmp/printellect-release` on the Pi and passed `sha256sum -c SHA256SUMS`.

---

## 5. Step-by-Step Raspberry Pi Deployment & Migration Procedure

### Step 1 — Read-Only Release & Host Preflight (Zero Mutation)
```bash
cd /tmp/printellect-release
sha256sum -c SHA256SUMS
openssl pkeyutl -verify -pubin -inkey release-key.pub.pem \
  -rawin -in manifest.json -sigfile manifest.json.sig

# Dry-run bootstrap verification (session ID is masked in output; zero files/services modified)
sudo bash ./bootstrap.sh \
  --session-id "<KIOSK_SESSION_ID>" \
  --local-release-dir . \
  --pubkey ./release-key.pub.pem \
  --skip-printer-setup \
  --dry-run
```

### Step 2 — Stage Official Node.js 24 LTS Side-by-Side & Validate Legacy Service (`/usr/bin/node` Untouched)
```bash
# 2a. Stage official Linux ARM64 Node.js 24 LTS under /opt/printellect/runtime/current
#     (For offline air-gapped install, pass --tarball ./node-v24.14.0-linux-arm64.tar.xz --shasums ./SHASUMS256.txt)
sudo bash ./stage-node-runtime.sh \
  --version v24.14.0 \
  --validate-workdir <LEGACY_WORKDIR>

# 2b. Inspect legacy service discovery in dry-run mode (if migrating an existing daemon)
sudo bash ./validate-legacy-node24.sh --dry-run --legacy-unit auto

# 2c. Gated single-instance canary test of the existing daemon on staged Node.js 24
#     (Applies temporary 99-printellect-node24-canary.conf, verifies Firebase + listener + clean stop, and restores baseline)
sudo bash ./validate-legacy-node24.sh \
  --run-validation \
  --confirm-restart \
  --legacy-unit auto \
  --timeout 25 \
  --stable-sec 5
```

### Step 3 — Stage Signed Release into `/opt/printellect/releases/1.0.0` (Legacy Service Still Running)
```bash
sudo bash ./bootstrap.sh \
  --session-id "<KIOSK_SESSION_ID>" \
  --local-release-dir . \
  --pubkey ./release-key.pub.pem \
  --skip-printer-setup

# Validate newly staged release modules and dependencies under staged Node.js 24
sudo bash /opt/printellect/current/scripts/stage-node-runtime.sh \
  --validate-only \
  --validate-workdir /opt/printellect/current
```

### Step 4 — Upgrade `/usr/bin/node` to Node.js 24 LTS (or Pin Staged Runtime)
**Option A (Recommended — Upgrade system Node.js to supported 24 LTS so EOL Node.js 20 is retired):**
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
/usr/bin/node -v   # Must report v24.x.x

# If migrating an active legacy service, confirm clean restart on /usr/bin/node v24 before service cutover:
sudo systemctl restart <legacy-unit>.service
sudo systemctl is-active <legacy-unit>.service
```
**Option B (Offline / Pinned Runtime — Keep `/usr/bin/node` untouched and pass `--node-bin /opt/printellect/runtime/current/bin/node` to `install-service.sh` in Step 5).**

### Step 5 — Configure Printers (Clean Install Only) & Execute `systemd` Service Cutover
If no legacy `config.json` exists yet, map CUPS queues first:
```bash
sudo printellect-setup --bw Canon_GX6100 --color Canon_GX6100
```

Run service preflight, dry-run, and cutover:
```bash
# 5a. Read-only preflight and dry-run
sudo bash /opt/printellect/current/scripts/install-service.sh --preflight-only --migrate-legacy auto
sudo bash /opt/printellect/current/scripts/install-service.sh --dry-run --migrate-legacy auto --enable --start

# 5b. Execute gated cutover (writes verified backups + /etc/printellect/migration.json, arms
#     printellect-migration-recover.service, stops/disables legacy unit, installs/enables/starts
#     printellect.service, enforces PID-scoped Firebase health gate, and disarms recovery unit)
sudo bash /opt/printellect/current/scripts/install-service.sh --migrate-legacy auto --enable --start

# 5c. Confirm single active daemon running as 'printellect' and completed checkpoint
sudo cat /etc/printellect/migration.json
ps -eo user,pid,cmd | grep '[n]ode'
```
*(For a fresh kiosk with no legacy service, omit `--migrate-legacy auto` and run `sudo bash /opt/printellect/current/scripts/install-service.sh --enable --start`.)*

---

## 6. Post-Deployment Physical Acceptance Checklist

Execute the CUPS acceptance gate **as the unprivileged `printellect` service user** (substitute `/opt/printellect/runtime/current/bin/node` if using Option B):

```bash
# 1. Non-printing queue readiness gate (verifies config.json permissions, lpstat -p, and lpstat -a)
sudo -u printellect /usr/bin/node /opt/printellect/current/scripts/verify-print-acceptance.js --check-queues

# 2. Controlled 1-page B&W grayscale simplex acceptance print (zero fallback; tagged via lp -t)
sudo -u printellect /usr/bin/node /opt/printellect/current/scripts/verify-print-acceptance.js \
  --submit-test-job --role bw --color false --duplex false --copies 1 --generate-test-pdf --wait-completion-sec 45

# 3. Controlled Color RGB duplex acceptance print (use --duplex false if physical queue is simplex-only)
sudo -u printellect /usr/bin/node /opt/printellect/current/scripts/verify-print-acceptance.js \
  --submit-test-job --role color --color true --duplex true --copies 1 --generate-test-pdf --wait-completion-sec 60
```

Verify every item below before closing the maintenance window:
- [ ] `--check-queues` exits `0` with `QUEUE_PREFLIGHT_ONLY` and all configured queues `ENABLED + ACCEPTING`.
- [ ] B&W acceptance job reports `Spool Status : cups_spool_completed` and physical sheet exits in **grayscale, 1-sided, 1 copy** with matching `Job Tag : printellect-acceptance-bw-...` printed on the page.
- [ ] Color acceptance job reports `Spool Status : cups_spool_completed` and physical sheet exits in **RGB color** with expected duplex/simplex behavior.
- [ ] `lpstat -W not-completed` is empty and `sudo journalctl -u printellect.service -n 50 --no-pager` shows `Connected to Firebase.` + `Listening for print jobs on session: ...` with masked session ID and zero errors.

---

## 7. Rollback, Power-Loss Crash Recovery & Backup Policy

### Operator-Initiated Rollback
```bash
sudo bash /opt/printellect/current/scripts/install-service.sh --rollback
```
- Acquires `/run/printellect-migration.lock`, stops/disables/removes `printellect.service`, atomically restores the legacy unit and `/etc` drop-ins without following destination symlinks or touching vendor directories (`/lib/systemd/system`, `/usr/lib/systemd/system`), reloads `systemd`, re-enables and starts `<legacy-unit>.service`, updates `/etc/printellect/migration.json` to `"status": "rolled_back"`, and disarms `printellect-migration-recover.service`.
- Backups in `/var/lib/printellect/backups/` (`0700`, `root:root`) are **permanently preserved** across rollbacks and repeated runs.

### Unattended Power-Loss Boot Reconciliation
If power fails mid-cutover (including after `legacy_disabled` and before `new_service_enabled`, or mid-rollback), `printellect-migration-recover.service` runs automatically on next boot (`Before=printellect.service` and `Before=<legacy-unit>.service`) via `/etc/printellect/recover-migration.sh --reconcile-boot --non-blocking-start`, removes any partial `printellect.service`, restores `<legacy-unit>.service`, guarantees zero dual-daemon Firebase listeners, and marks `"checkpointPhase": "boot_recovered"`.

Inspect post-outage recovery logs with:
```bash
sudo journalctl -u printellect-migration-recover.service -b --no-pager
sudo cat /etc/printellect/migration.json
```

---

## 8. Job Lifecycle, Security Hardening & Dependency Audit Notes

### Firestore Print Job Lifecycle & Door-Unlock Safeguard
1. Daemon listens on Firestore `print-jobs` where `kiosk-session-id == KIOSK_SESSION_ID` and `is-kiosk-job == true` (filtering `status === 'on-queue'` after payment).
2. Each file in `print-jobs/<jobId>/files` is downloaded over validated HTTPS (`60s` timeout, mode `0600`) into an isolated `os.tmpdir()` path sanitized against POSIX/Windows path traversal and concurrent filename collisions, submitted to CUPS `lp -d <queue>` with explicit `ColorModel=Gray|RGB`, `sides=...`, `-n <copies>`, and unlinked in `finally`.
3. **Documented Failure-State Safeguard**: In Printellect's kiosk hardware architecture, `status: 'completed'` triggers the physical kiosk door controller to unlock the collection tray (which later transitions `'completed'` -> `'delivered'`). If a job has zero printable files, an unconfigured target queue, a download failure, or a CUPS print failure, `index.js` now transitions the job to **`status: 'failed'`** (with `'failed-time'`, `'failure-reason'`, `'printed-files'`, `'total-files'`) rather than `'completed'`, preventing the kiosk from unlocking an empty tray while keeping paid `'on-queue'` intake and `'completed'` -> `'delivered'` semantics intact.

### Transitive Dependency Vulnerability Triage (`npm audit`)
- Production dependency tree is locked (`npm ci --omit=dev`) to `firebase@12.16.0` and `pdf-to-printer@5.8.0` (pure JavaScript; zero native `.node` addons; note `printer.js` invokes POSIX `lp` directly via `child_process.execFile` on Linux).
- `npm audit` reports 4 entries tracing to a single transitive package: `@grpc/grpc-js@1.9.16` (`~1.9.0` pinned upstream by `@firebase/firestore`).
  - `GHSA-m9gg-hp2v-232j` (`CWE-295`): gRPC TLS **server** `getAuthContext()` client-certificate bypass in mTLS servers.
  - `GHSA-f596-whhp-79r4` (`CWE-550`): gRPC **server** transmitting unhandled server method-handler exception strings to clients.
- **Impact Assessment**: **Not exploitable in this service.** `printellect-kiosk-daemon` runs **zero gRPC servers**, binds **zero listening network sockets**, never calls `getAuthContext()`, and uses `@firebase/firestore` strictly as an outbound TLS client to Google Cloud Firestore (`*.googleapis.com`). `npm audit`'s suggested remediation (`firebase@9.14.0`) is a breaking 3-major-version downgrade and is intentionally rejected. Monitor upstream `firebase` releases adopting `@grpc/grpc-js >= 1.13.6`.

---

## 9. Troubleshooting Guide

| Symptom | Cause | Resolution |
|---|---|---|
| `bootstrap.sh`: `Insecure HTTP release URL rejected` | `--release-url` used `http://` | Host release artifacts over `https://` or transfer offline and use `--local-release-dir`. |
| `bootstrap.sh`: `CRYPTOGRAPHIC VERIFICATION FAILED` | `manifest.json` or `manifest.json.sig` corrupted or wrong `--pubkey` | Re-transfer `dist/` artifacts, verify `sha256sum -c SHA256SUMS`, and verify against `keys/release-key.pub.pem`. |
| `install-service.sh`: `Temporary Node 24 validation drop-in is still present` | Previous `validate-legacy-node24.sh` canary interrupted without cleanup | Run `sudo bash /opt/printellect/current/scripts/validate-legacy-node24.sh --restore --legacy-unit auto`. |
| `install-service.sh`: `Could not acquire exclusive migration lock` | Another `install-service.sh` or `recover-migration.sh` instance is active | Wait for the active operation to complete (`ps aux \| grep -E 'install-service\|recover-migration'`); never run concurrent cutovers. |
| `install-service.sh`: Health check fails and auto-rolls back | Invalid `KIOSK_SESSION_ID`, missing `/var/lib/printellect/config.json`, or network/DNS outage | Inspect `sudo journalctl -u printellect.service -n 50 --no-pager`; fix `/etc/printellect/kiosk.env` or run `sudo printellect-setup`, then retry cutover. |
| `verify-print-acceptance.js`: `Permission denied` or queue disabled | `printellect` user missing `lp` group or Canon GX6100 USB/IPP queue paused | Check `id printellect` (must include `lp`), `lpstat -p`, and `sudo cupsenable <queue> && sudo cupsaccept <queue>`. |

---

## 10. Known Limitations & Pi-Only Physical Checks

Local CI/WSL2 verification validates Node.js 24 execution, Ed25519/SHA-256 cryptography, adversarial tar rejection, POSIX ext4 permissions, `systemd-analyze verify`, and simulated `systemctl`/CUPS fault matrices, **but cannot substitute for physical Raspberry Pi 4 + Canon GX6100 verification** of:
1. Native `aarch64` (`linux-arm64`) ELF execution of `node-v24.14.0-linux-arm64.tar.xz` on Debian 13 (Trixie) kernel/glibc (`SHASUMS256.txt` hash `e7adfca03d9173276114a6f2219df1a7d25e1bfd6bbd771d3f839118a2053094` verified locally).
2. Live kernel `systemd` cgroup namespace sandboxing (`ProtectSystem=strict`, `PrivateTmp=true`, `ProtectHome=true`) interacting with `/run/cups/cups.sock` on Debian 13.
3. Physical Canon GX6100 PPD/driver rendering of `ColorModel=Gray`, `ColorModel=RGB`, `sides=two-sided-long-edge`, paper tray routing, and physical power-plug pull reboot timing.

---

## 11. Implementation & Verification Traceability Matrix

| Area | Implementation location | Tests executed | Result | Remaining risk |
|---|---|---|---|---|
| **Configuration** | `config.js` | `test/config.test.js` (Node 24 native + ext4 permissions) | PASS | Operators must supply valid queue names via `printellect-setup` if no legacy `config.json` exists. |
| **Printer discovery** | `setup.js`, `bin/printellect-setup` | `test/setup.test.js` (mocked `lpstat` + atomic write/CLI tests) | PASS | Live `ipp-usb` / Canon GX6100 URI discovery must be confirmed on Pi via `lpstat -p`. |
| **Printing** | `printer.js` | `test/daemon-jobs.test.js`, `test/print-acceptance.test.js` | PASS | Physical Canon GX6100 driver adherence to `ColorModel=Gray\|RGB` and `sides` requires on-site sheet inspection. |
| **Firebase & job lifecycle** | `firebase.js`, `index.js` | `test/daemon-jobs.test.js` (stubbed Firestore/HTTPS + real Node 24 `index.js` subprocess lifecycle) | PASS | Live production Firestore connectivity and Storage download latency require Pi network check. |
| **Service installation** | `systemd/printellect.service`, `scripts/install-service.sh` | `systemd-analyze verify` (WSL2) + `test/service.test.js` | PASS | Real Debian 13 `systemd` namespace mount behavior requires Pi cutover check. |
| **Runtime staging** | `scripts/stage-node-runtime.sh` | `test/runtime-staging.test.js` + official `v24.14.0` `SHASUMS256.txt` verification | PASS | Native `aarch64` binary execution (`node -v`) requires ARM64 Pi hardware (`qemu-aarch64` unavailable locally). |
| **Release signing** | `scripts/crypto-utils.js`, `scripts/package-release.js`, `scripts/verify-release.js`, `keys/release-key.pub.pem` | `test/packaging.test.js` (deterministic consecutive build + 18-case adversarial matrix) | PASS | Keep private `.keys/release-key.pem` offline and out of git; verify `SHA256SUMS` before running `bootstrap.sh`. |
| **Bootstrap** | `scripts/bootstrap.sh` | `bash -n` (WSL2) + `test/bootstrap.test.js` (ext4 modes, symlink trap, upgrade/interrupted-install, adversarial tar matrix) | PASS | `apt-get` prerequisite install path only executes on live Debian root when packages are missing. |
| **Migration** | `scripts/install-service.sh` | `test/service.test.js` (legacy `/etc` & `/usr/lib` discovery, drop-ins, symlinks, PID-scoped health gate) | PASS | Unforeseen custom non-systemd supervisor (e.g. raw `crontab`/`pm2`) would require manual stop during preflight. |
| **Rollback** | `scripts/install-service.sh`, `scripts/recover-migration.sh` | `test/service.test.js` (all 5 inline failure points + symlink-trap + vendor-file protection) | PASS | Rollback restores systemd state and unit files; physical jammed print jobs in CUPS require `cancel`. |
| **Boot recovery** | `systemd/printellect-migration-recover.service`, `scripts/recover-migration.sh` | `systemd-analyze verify` + `test/service.test.js` (all 8 power-loss checkpoints + mid-recovery crash + `flock` contention) | PASS | Physical Pi power-pull reboot timing under Debian 13 `multi-user.target` not hardware-tested locally. |
| **Canary validation** | `scripts/validate-legacy-node24.sh` | `bash -n` + `test/runtime-staging.test.js` (gated drop-in, crash auto-restore, leftover-drop-in migration block) | PASS | Brief single-service restart (~3–5s) occurs during gated `--confirm-restart` canary window. |
| **Print acceptance** | `scripts/verify-print-acceptance.js` | `test/print-acceptance.test.js` (`-t` job tag, zero fallback, timeout cancel isolation from unrelated jobs) | PASS | `cups_spool_completed` confirms CUPS filter/backend completion; human visual check of paper output remains mandatory. |
| **Documentation** | `README.md`, `docs/migration-runbook.md`, `docs/service-architecture.md` | Cross-checked every CLI flag, path, file count (`15` source + `release.json`), and public key against codebase | PASS | Keep runbooks updated whenever future release versions (`>1.0.0`) add new CLI flags or mandatory files. |

