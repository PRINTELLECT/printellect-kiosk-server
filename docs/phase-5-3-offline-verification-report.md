# Phase 5.3 — Offline Linux Integration Verification and Release Attestation Report

**Repository**: [`printellect-kiosk-daemon`](file:///e:/printellect/printellect-kiosk-daemon)  
**Remote Target**: `https://github.com/PRINTELLECT/printellect-kiosk-server.git`  
**Verified Release**: `v1.0.2` (commit [`3e41dda1b8e5babac65f4b7757403622d252b95a`](file:///e:/printellect/printellect-kiosk-daemon))  
**Target Platform**: Raspberry Pi 4 Model B, Debian 13 (Trixie), ARM64/aarch64  
**Linux Test Environment**: WSL2 Linux (Ubuntu 24.04 LTS, Kernel 5.15.167.4-microsoft-standard-WSL2, systemd 255 active as PID 1)  
**Date**: October 30, 2026  

---

## 1. Release Identity & Trust Verification

The release artifacts and local git state were independently inspected against the repository source and cryptographic trust anchors.

### 1.1 Git Release State
- **Current Branch**: `release/v1.0.2`
- **Working Tree**: Clean (`nothing to commit, working tree clean`)
- **HEAD Commit**: `3e41dda1b8e5babac65f4b7757403622d252b95a`
- **Annotated Tag**: `v1.0.2`
- **Tag Target**: `object 3e41dda1b8e5babac65f4b7757403622d252b95a` (points directly to release commit)
- **Previous Tags**: `v1.0.0` and `v1.0.1` preserved intact without force-updating

### 1.2 Release Archive & Artifact Verification
- **Archive File**: `dist/printellect-kiosk-daemon-1.0.2.tar.gz`
- **Archive Size**: `70,001 bytes` (68.36 KB)
- **Archive SHA-256**: `e62b3d3eb6c421532ee51210dfbd32cb2af83d9795a276367237f4319cf17abe`
- **Manifest File**: `dist/manifest.json` (schemaVersion 2)
- **Signature File**: `dist/manifest.json.sig` (64 bytes Ed25519 signature)
- **Checksums File**: `dist/SHA256SUMS`
- **Remote Asset Check**: GitHub Release assets for tag `v1.0.2` verified via `gh release view v1.0.2 --json assets`; remote archive size (`70001` bytes) and sha256 (`e62b3d3eb6c421532ee51210dfbd32cb2af83d9795a276367237f4319cf17abe`) match local artifacts byte-for-byte.

### 1.3 Cryptographic Trust Anchor
- **Pinned Production Key**: [`keys/release-key.pub.pem`](file:///e:/printellect/printellect-kiosk-daemon/keys/release-key.pub.pem)
- **SPKI PEM Fingerprint (SHA-256)**: `4b3ff274af5c74b4e80d07fe1d5c8216f6ca8ebcf5a49e742310b796ffb55cc7`
- **Raw Ed25519 Public Key (Hex)**: `6201812ef431ee6518afcac1d2fdb580d04567f5753038eec7273be17591cc9c`
- **Raw Ed25519 Fingerprint (SHA-256)**: `629c624d3740a05343f7a9d08ec829a07f1fe1915dec844faa04dd78576b4f7c`
- **Signature Verification**: Validated with `verify-release.js`; Ed25519 signature over `manifest.json` is VALID.
- **Untrusted Key Rejection**: Verified that `scripts/bootstrap.sh` and `scripts/verify-release.js` reject unpinned public keys by default. Overriding the trust anchor requires explicit flag `--allow-untrusted-pubkey` which emits high-severity security warnings.
- **Archive Composition**: Exactly 16 entries (15 required modules + `release.json`). Zero path traversals, zero symlinks, zero hardlinks, zero absolute paths, zero unexpected or hidden files. Per-file hashes match `manifest.json` byte-for-byte upon fresh extraction.

---

## 2. Real Linux Environment (WSL2) Full Suite Execution

The entire test suite was executed in an isolated Linux environment running real Ubuntu 24.04 LTS on WSL2 with native ext4 filesystems.

### 2.1 Linux Environment Specs
- **Kernel**: `Linux LAPTOP-KH9I5DHB 5.15.167.4-microsoft-standard-WSL2 #1 SMP Tue Nov 5 00:21:55 UTC 2024 x86_64`
- **Init System**: `systemd 255 (255.4-1ubuntu8.18)` running actively as PID 1 (`systemctl is-system-running` -> `running`)
- **Runtime**: Node.js `v24.22.1` (Linux x86-64 ELF, isolated user directory)

### 2.2 Test Suite Execution Results

All 141 automated tests across 25 suites passed cleanly in 76.1 seconds:

```
▶ Bootstrap Installer — Script Integrity and Argument Validation (557ms)
  ✔ 5/5 tests pass
▶ Bootstrap Installer — Dry Run, Cryptographic Authentication, Adversarial Tar Checks, and Upgrade Safety (23.6s)
  ✔ 7/7 tests pass
▶ Config Module - Validation (8ms)
  ✔ 9/9 tests pass
▶ Config Module - Atomic Persistence & Loading (25ms)
  ✔ 6/6 tests pass
▶ Config Module - Safe Legacy Migration (10ms)
  ✔ 4/4 tests pass
▶ Phase 5.2 — Configuration Access Permissions & Least-Privilege Model (9ms)
  ✔ 2/2 tests pass
▶ Phase 5 — Filename, URL, Log Redaction & Printer Queue Safety (5ms)
  ✔ 4/4 tests pass
▶ Phase 5 — Firestore Job Lifecycle, Payment Gate, Shared Queue & Explicit Failure Outcomes (424ms)
  ✔ 6/6 tests pass
▶ Phase 5.2 — Durable Print-Job Idempotency, Concurrency & Crash Recovery Matrix (144ms)
  ✔ 8/8 tests pass
▶ Release Packaging Pipeline & Reproducibility (172ms)
  ✔ 6/6 tests pass
▶ Adversarial Release Verification Security Matrix (170ms)
  ✔ 6/6 tests pass
▶ Cryptographic Release Trust (2ms)
  ✔ 3/3 tests pass
▶ Phase 4.4 & Phase 5 — End-to-End CUPS Printing Acceptance Gate (1.7s)
  ✔ 9/9 tests pass
▶ Versioned Node.js 24 Runtime Staging & Pre-Upgrade Validation (218ms)
  ✔ 7/7 tests pass
▶ Phase 4.4 — Gated Legacy Daemon Validation on Staged Node.js 24 (3.3s)
  ✔ 5/5 tests pass
▶ Phase 4.4 — Actual Daemon Code-Path Execution Under Node.js 24 Runtime (674ms)
  ✔ 2/2 tests pass
▶ Systemd Service Unit — Directives & Security Hardening (81ms)
  ✔ 4/4 tests pass
▶ Service Installer — Syntax, Preflight, and Simulation (3.9s)
  ✔ 5/5 tests pass
▶ Historical Legacy Service Migration (7.2s)
  ✔ 4/4 tests pass
▶ Service Rollback Resilience & Failure Recovery (16.1s)
  ✔ 5/5 tests pass
▶ Phase 4.3 — Legacy Discovery Coverage, Drop-Ins, Symlinks & Vendor Protection (4.3s)
  ✔ 4/4 tests pass
▶ Phase 4.3 — Non-Atomic Failure Points, Health-Check Gate & Reboot Rollback (6.5s)
  ✔ 4/4 tests pass
▶ Phase 4.4 — Power-Loss Boot Reconciliation Matrix Across Every Checkpoint (15.7s)
  ✔ 15/15 tests pass
▶ Setup Wizard - Printer Role Logic (3ms)
  ✔ 6/6 tests pass
▶ Setup Wizard - Interactive Flow Simulation (44ms)
  ✔ 5/5 tests pass

Total Tests: 141 | Suites: 25 | Passed: 141 | Failed: 0 | Duration: 76.1s
```

### 2.3 Systemd Verification Evidence
- Shipped service units [`systemd/printellect.service`](file:///e:/printellect/printellect-kiosk-daemon/systemd/printellect.service) and [`systemd/printellect-migration-recover.service`](file:///e:/printellect/printellect-kiosk-daemon/systemd/printellect-migration-recover.service) were audited using native Linux `systemd-analyze verify`.
- Result: **Clean exit (code 0)**. Zero syntax errors, zero unknown key warnings, zero invalid security directive rejections.

---

## 3. Print-Job State Machine & Crash Recovery Audit

### 3.1 State Machine Lifecycle
The print daemon enforces the following state transitions for each print job:

$$\text{unclaimed} \longrightarrow \text{claimed} \longrightarrow \text{downloading} \longrightarrow \text{printing} \longrightarrow \text{printed} \longrightarrow \text{completed}$$

### 3.2 Crash Matrix & Recovery Classification

| State at Interruption | Tested Condition | System Recovery Behavior | Recovery Classification | Physical Print Guarantee |
| :--- | :--- | :--- | :--- | :--- |
| **`claimed`** | Daemon process killed before file downloads begin | Detected on restart; state marked `ambiguous_crash`; Firestore updated to `failed`; 0 pages sent to CUPS | **Fail-Closed (Operator Review)** | Exactly zero pages printed |
| **`downloading`** | Daemon process killed during PDF download from Firebase Storage | Detected on restart; state marked `ambiguous_crash`; Firestore updated to `failed`; 0 pages sent to CUPS | **Fail-Closed (Operator Review)** | Exactly zero pages printed |
| **`printing`** | Daemon process killed while `printer.print()` is active | Detected on restart; outcome is ambiguous (unknown if CUPS committed spool or printer fed paper); fails closed as `ambiguous_crash`; Firestore updated to `failed`; **no re-spooling** | **Fail-Closed (Operator Reconciliation)** | Zero duplicate print; operator physical tray inspection required |
| **`printed`** | Daemon process killed **after** CUPS returns success but **before** Firestore `status: 'completed'` commits | Detected on restart; ledger record has `status: 'printed'`; daemon completes Firestore update with `status: 'completed'` and collection tray unlock **without re-invoking CUPS** | **Automatic Recovery (Zero Operator Action)** | Exactly-once print guaranteed |
| **Firestore Transport Fail** | Final status update throws `UNAVAILABLE` after printing | Catch block preserves `status: 'printed'` in local ledger; subsequent retry or restart completes Firestore without re-printing | **Automatic Recovery (Zero Operator Action)** | Exactly-once print guaranteed |
| **Partial Multi-File Jam** | File 1 prints; File 2 fails due to CUPS offline/jam | Ledger records `printedFiles: ['f1']`; job marked `failed` in Firestore; replay on restart fails closed and **never reprints File 1** | **Fail-Closed (Operator Reconciliation)** | Zero duplicate reprint of File 1 |
| **Concurrent Daemon Processes** | Two instances attempt to claim the same job simultaneously | First instance acquires POSIX atomic lock (`O_CREAT \| O_EXCL`); second instance receives `EEXIST` and aborts with `concurrent_claim_rejected` | **Automatic Defense (Concurrency Guard)** | Exactly-once processing |
| **Corrupt / Truncated Ledger** | 0-byte or invalid JSON ledger file | `writeJobRecord` protocol writes via `.<safeName>.tmp.<pid>.<time>`, flushes via `fsyncSync()`, and performs atomic rename over destination. Target files are never partially written by the OS. | **Automatic Defense (Atomic I/O)** | Ledger file integrity preserved |

---

## 4. Configuration & Migration Safety Verification

Executed under actual service identities on Linux ext4:

### 4.1 Permission Audit Results
- `/var/lib/printellect`: Mode `0750` (`rwxr-x---`), Owner `printellect:printellect`
- `/var/lib/printellect/config.json`: Mode `0640` (`rw-r-----`), Owner `printellect:printellect`
- `/var/lib/printellect/jobs`: Mode `0750` (`rwxr-x---`), Owner `printellect:printellect`
- `/etc/printellect/kiosk.env`: Mode `0640` (`rw-r-----`), Owner `root:printellect`

### 4.2 Service Identity Access Verification
- Service user `printellect` can read `/var/lib/printellect/config.json`: **PASS**
- Unprivileged user `nobody` cannot read `/var/lib/printellect/config.json`: **PASS (Permission Denied)**
- Service user `printellect` can write job claim files into `/var/lib/printellect/jobs/`: **PASS**
- Service user `printellect` can read secret session ID in `/etc/printellect/kiosk.env`: **PASS**
- Service user `printellect` cannot modify `/etc/printellect/kiosk.env`: **PASS (Permission Denied)**
- Setup tool `--config-path` preserves non-world-readable `0640` permissions across technician runs: **PASS**

### 4.3 Migration & Rollback Invariants
- Existing session IDs and printer role mappings survive upgrade and rollback without loss.
- Installer aborts without stopping legacy daemon if candidate legacy unit is ambiguous or session ID cannot be safely discovered.
- Daemon starts strictly non-interactively under systemd; zero stdin prompts during service startup.

---

## 5. Node Runtime Staging & Service Startup

- **Runtime Isolation**: Node 24 runtime is staged in `/opt/printellect/runtime/current/bin/node` with mode `0755`.
- **System Node Invariant**: System path `/usr/bin/node` was not modified or upgraded.
- **Zero Native Addons**: Audited `node_modules` under Node 24; exactly 0 `.node` binary addons exist. Daemon dependencies (`firebase`, `pdf-to-printer`) are pure JavaScript/CLI wrappers.
- **Canary Drop-in Lifecycle**: `scripts/validate-legacy-node24.sh` safely attaches temporary `99-printellect-node24-canary.conf`, tests the daemon, and deterministically restores baseline configuration.

---

## 6. Physical Acceptance Procedure Verification

Tested using isolated mock CUPS binaries under the unprivileged service identity:

### 6.1 Security & User Identity Gate
- Running `verify-print-acceptance.js` as any user other than `printellect` (e.g. `root`) fails immediately with `[PRINT ACCEPTANCE FAILED] Acceptance gate must run as service account 'printellect'`.
- Running under `sudo -u printellect` succeeds.

### 6.2 Preflight Mode (Read-Only)
- Command:
  ```bash
  sudo -u printellect /opt/printellect/runtime/current/bin/node \
    /opt/printellect/current/scripts/verify-print-acceptance.js \
    --config /var/lib/printellect/config.json \
    --check-queues
  ```
- Result: Read-only. Queries `lpstat -p` and `lpstat -a` for configured queues, verifies accepting status, and outputs `Result: QUEUE_PREFLIGHT_ONLY`. Spools zero print jobs.

### 6.3 Test Job Submission Mode (Hardware Spool)
- Command:
  ```bash
  sudo -u printellect /opt/printellect/runtime/current/bin/node \
    /opt/printellect/current/scripts/verify-print-acceptance.js \
    --config /var/lib/printellect/config.json \
    --submit-test-job \
    --role bw \
    --queue Canon_GX6100 \
    --generate-test-pdf \
    --copies 1
  ```
- Result: Generates a spec-compliant single-page PDF-1.4 file, submits with explicit acceptance tracking title (`-t printellect-acceptance-bw-...`), parses the trackable CUPS request ID (`Canon_GX6100-4242`), and monitors spool completion.
- Fault Isolation: If a timeout occurs, it cancels strictly its own acceptance request ID (`cancel -u printellect Canon_GX6100-4242`) without touching unrelated customer print jobs.

### 6.4 Explicit Hardware Reality Notice
> [!IMPORTANT]
> **Hardware Status**: All tests above used mocked CUPS interfaces in an offline Linux environment. The physical Canon GX6100 printer hardware, physical USB/network connection, ink cartridge delivery, paper feed, duplex mechanical alignment, and physical collection-door solenoid hardware **remain unverified** until on-site testing on the physical Raspberry Pi kiosk.

---

## 7. Reconciled Deployment Runbook Commands

Every command is categorized by its operational state impact:

| Phase | Operational Command | State Impact Classification |
| :--- | :--- | :--- |
| **0. Preflight** | `lpstat -p -d -v`<br>`systemctl is-active printellect-kiosk printellect` | `[READ-ONLY]` |
| **1. Runtime** | `bash scripts/stage-node-runtime.sh --archive ...`<br>`bash scripts/validate-legacy-node24.sh --preflight` | `[FILESYSTEM MUTATION]` (extracts runtime to `/opt/printellect/runtime`)<br>`[READ-ONLY]` |
| **1. Canary** | `bash scripts/validate-legacy-node24.sh --run-validation --confirm-restart` | `[SERVICE MUTATION]` (temporary canary restart; auto-restores baseline) |
| **2. Verify** | `node scripts/verify-release.js dist/manifest.json dist/manifest.json.sig keys/release-key.pub.pem` | `[READ-ONLY]` |
| **3. Bootstrap** | `sudo bash scripts/bootstrap.sh --release-dir ... --dry-run`<br>`sudo bash scripts/bootstrap.sh --release-dir ...` | `[READ-ONLY]`<br>`[FILESYSTEM MUTATION]` (extracts release to `/opt/printellect/releases/v1.0.2`) |
| **4. Setup** | `sudo printellect-setup --bw Canon_GX6100 --color Canon_GX6100` | `[CONFIGURATION MUTATION]` (writes `config.json` with mode `0640`, `printellect` group) |
| **5. Cutover** | `sudo bash scripts/install-service.sh --preflight`<br>`sudo bash scripts/install-service.sh` | `[READ-ONLY]`<br>`[SERVICE MUTATION]` (stops legacy daemon, enables/starts `printellect.service`) |
| **6. Acceptance** | Acceptance `--check-queues`<br>Acceptance `--submit-test-job ...` | `[READ-ONLY]`<br>`[HARDWARE/PRINT MUTATION]` (spools test page to Canon GX6100 queue) |
| **Rollback** | `sudo bash /opt/printellect/current/scripts/install-service.sh --rollback` | `[SERVICE MUTATION]` (restores legacy service, resets drop-ins, preserves backups) |

---

## 8. Release Discipline & Final Determination

- Release **`v1.0.2`** remained strictly immutable. No tags or release assets were modified or force-updated.
- Local and Linux integration testing established 100% pass rates across all 141 tests.
- Offline Linux integration, permissions, systemd compliance, durable ledger idempotency, and cryptographic trust anchors are independently validated.

**OFFLINE VERIFICATION PASSED — READY FOR CONTROLLED PI PREFLIGHT**
