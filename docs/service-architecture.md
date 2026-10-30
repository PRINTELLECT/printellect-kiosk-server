# PRINTELLECT Kiosk Server — Service Architecture & Daemon Supervision

## 1. System Overview

The PRINTELLECT Kiosk Server is supervised in production by `systemd` on Raspberry Pi OS (Debian ARM64). The service architecture separates release staging (`bootstrap.sh`), side-by-side runtime validation (`stage-node-runtime.sh` + `validate-legacy-node24.sh`), service cutover (`install-service.sh`), automated boot power-loss reconciliation (`printellect-migration-recover.service`), and end-to-end CUPS print acceptance (`verify-print-acceptance.js`).

```
┌───────────────────────────────────────────────────────────────────┐
│                           systemd init                            │
│                                                                   │
│  [Boot Reconciliation — Armed Only During Active Cutover]         │
│  printellect-migration-recover.service (Type=oneshot)             │
│  Before: printellect.service + <legacy-unit>.service              │
│  ConditionPathExists: /etc/printellect/migration.json             │
│  ExecStart: /etc/printellect/recover-migration.sh                 │
│             --reconcile-boot --non-blocking-start                 │
│                               │                                   │
│                               ▼                                   │
│  [Production Kiosk Daemon]                                        │
│  printellect.service                                              │
│  Wants/After: network-online.target cups.service                  │
│  Restart=on-failure (5s backoff, max 5 bursts / 60s)              │
└───────────────────────────────┬───────────────────────────────────┘
                                │ starts under 'printellect' user
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                 printellect-kiosk-daemon (Node.js 24 LTS)         │
│  User: printellect (Group: printellect, Supplementary: lp)        │
│  Working Directory: /opt/printellect/current (Read-Only)          │
│  Env File: /etc/printellect/kiosk.env (Mode 0640, masked in logs) │
├───────────────────────────────┬───────────────────────────────────┤
│  Read-Only / Isolated         │  Read / Write                     │
│  - /usr, /boot, /etc          │  - /var/lib/printellect           │
│  - /home (ProtectHome=true)   │  - /tmp (PrivateTmp=true)         │
│  - Kernel / Tunables          │  - /run/cups/cups.sock (group lp) │
└───────────────────────────────┴───────────────────────────────────┘
```

---

## 2. Security, Privilege Separation & Secret Hygiene

| Principal | Role | Directives |
|---|---|---|
| **User: `printellect`** | Unprivileged system service user with no interactive login shell (`/usr/sbin/nologin`). | `User=printellect` |
| **Primary Group: `printellect`** | System group isolating configuration and environment files from standard users. | `Group=printellect` |
| **Supplementary Group: `lp`** | Grants access to CUPS local UNIX domain socket (`/run/cups/cups.sock`) without root privileges. | `SupplementaryGroups=lp` |

### Credential & Log Hygiene
- `KIOSK_SESSION_ID` is stored exclusively in `/etc/printellect/kiosk.env` (`root:printellect`, mode `0640`, written atomically under `umask 077` without following symlinks).
- `index.js`, `scripts/bootstrap.sh`, `scripts/install-service.sh`, and `scripts/validate-legacy-node24.sh` mask session tokens (`abc****yz (length: N)`) so session credentials are never exposed in `journald` or installer stdout/stderr.

### Hardening Directives (`printellect.service`)

| Directive | Purpose |
|---|---|
| `NoNewPrivileges=true` | Prevents child processes (e.g. `lp`) from escalating privileges via setuid/setgid binaries. |
| `PrivateTmp=true` | Mounts a private `/tmp` unshared with other users. Temporary job files are automatically cleaned up on service exit. |
| `ProtectSystem=strict` | Mounts the entire operating system (`/usr`, `/boot`, `/etc`) read-only for the daemon. |
| `ProtectHome=true` | Completely conceals `/home` and `/root` from the daemon. |
| `ProtectKernelTunables=true` | Prevents modification of `/proc/sys` and `/sys`. |
| `ProtectKernelModules=true` | Prohibits loading or unloading kernel drivers. |
| `ProtectControlGroups=true` | Mounts Linux control group hierarchies read-only. |
| `RestrictRealtime=true` | Disallows real-time scheduling to prevent CPU exhaustion. |
| `RestrictSUIDSGID=true` | Disallows creating SUID/SGID files in writable directories. |
| `ReadWritePaths=/var/lib/printellect /tmp` | Whitelists only the persistent configuration/state path and temporary print job staging directory. |
| `KillMode=control-group` (default) | Standard systemd termination mode. On `SIGTERM`, `index.js` unsubscribes its Firestore `onSnapshot` listener and exits `0`; CUPS (`cupsd`) runs in `cups.service` and is unaffected. |
| `StartLimitIntervalSec=60s`, `StartLimitBurst=5` | Placed in `[Unit]` to rate-limit crash loops (maximum 5 restarts in a 60-second window before entering `failed` state). |

### Boot Reconciliation Unit (`printellect-migration-recover.service`)

- **Purpose**: Reconciles an interrupted `status: "in_progress"` cutover automatically at boot if sudden power loss occurred between `checkpoint_saved` (including `legacy_disabled`) and `health_check_passed`.
- **Ordering & Mutual Exclusion**:
  - `Type=oneshot`, `RemainAfterExit=yes`, `After=local-fs.target`, `Before=printellect.service`, plus dynamic `/etc/systemd/system/printellect-migration-recover.service.d/10-legacy-order.conf` (`Before=<legacy-unit>.service`).
  - Acquires `/run/printellect-migration.lock` via `flock`, stops/kills/disables/removes `printellect.service` before re-enabling and enqueueing `systemctl start --no-block <legacy-unit>.service`, guaranteeing **zero concurrent Firebase listeners** and avoiding systemd boot transaction deadlocks.
  - Self-contained at `/etc/printellect/recover-migration.sh` (`0700`, `root:root`) with pure-POSIX fallback parsing so recovery succeeds even if `/opt/printellect` or Node.js is unavailable.
  - Automatically disarmed (`systemctl disable printellect-migration-recover.service`) once `migration.json` reaches terminal `"completed"` or `"rolled_back"`.

---

## 3. Directory Layout & Persistence Boundaries

```
/opt/printellect/
├── releases/
│   └── 1.0.0/                          # Signed release archive (root:root, 0755)
│       ├── index.js, printer.js, firebase.js, config.js, setup.js
│       ├── package.json, package-lock.json, release.json
│       ├── bin/printellect-setup       # Mode 0755
│       ├── systemd/
│       │   ├── printellect.service
│       │   └── printellect-migration-recover.service
│       └── scripts/                    # Mode 0755
│           ├── install-service.sh
│           ├── recover-migration.sh
│           ├── stage-node-runtime.sh
│           ├── validate-legacy-node24.sh
│           └── verify-print-acceptance.js
├── current -> releases/1.0.0/          # Atomic symlink to active release
└── runtime/                            # Side-by-side staged Node.js 24 LTS binaries (root:root, 0755)
    ├── node-v24.x.y-linux-arm64/
    └── current -> node-v24.x.y-linux-arm64/

/var/lib/printellect/                   # Persistent state (printellect:printellect, 0750)
├── config.json                         # Printer queue mapping (mode 0644)
└── backups/                            # Permanent pre-migration unit & drop-in backups (root:root, 0700)

/etc/printellect/                       # Environment secrets & checkpoints (root:printellect, 0750)
├── kiosk.env                           # KIOSK_SESSION_ID (mode 0640)
├── migration.json                      # Write-ahead migration checkpoint & rollback metadata (mode 0600)
├── recover-migration.sh                # Standalone boot reconciliation script (root:root, mode 0700)
└── legacy-node24-validation.json       # Audit state for gated legacy Node 24 canary test (mode 0600)

/etc/systemd/system/
├── printellect.service                 # Active production unit file (root:root, 0644)
├── printellect.service.d/              # Optional runtime drop-in (10-runtime.conf when --node-bin used)
├── printellect-migration-recover.service
└── printellect-migration-recover.service.d/
    └── 10-legacy-order.conf            # Dynamic Before=<legacy-unit>.service ordering
```

---

## 4. Diagnostics & CUPS Printing Verification

### Inspecting Logs via `journalctl`

```bash
# Follow daemon logs in real time (session ID is automatically masked)
journalctl -u printellect.service -f

# Inspect boot reconciliation unit logs (if a power outage occurred mid-migration)
journalctl -u printellect-migration-recover.service -b --no-pager
```

### Verifying CUPS Queues & End-to-End Printing as `printellect`

```bash
# 1. Non-printing queue readiness check (verifies config.json, lpstat -p, and lpstat -a as 'printellect')
sudo -u printellect /usr/bin/node /opt/printellect/current/scripts/verify-print-acceptance.js --check-queues

# 2. Controlled single-page physical acceptance print (zero fallback; requires visual tray inspection)
sudo -u printellect /usr/bin/node /opt/printellect/current/scripts/verify-print-acceptance.js \
  --submit-test-job --role bw --color false --duplex false --copies 1 --generate-test-pdf
```
