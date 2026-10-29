#!/usr/bin/env bash

# ==============================================================================
# PRINTELLECT Kiosk Server — Production Systemd Service Installer & Migrator
#
# Manages systemd service unit installation, unprivileged service account setup,
# directory permissions, journald logging, multi-criteria post-start health
# gating, and non-atomic legacy service migration with write-ahead persistent
# checkpoints and vendor-safe rollback.
#
# Supported OS: Debian GNU/Linux 11, 12, 13, Raspbian / Raspberry Pi OS (ARM64)
# ==============================================================================

set -euo pipefail

SCRIPT_VERSION="1.4.0"

# Target service account
SERVICE_USER="printellect"
SERVICE_GROUP="printellect"
CUPS_GROUP="lp"

# Runtime flags
ROOT_DIR=""
SESSION_ID=""
LEGACY_SERVICE_SPEC=""
CUSTOM_NODE_BIN=""
ENABLE_SERVICE=false
START_SERVICE=false
PREFLIGHT_ONLY=false
DRY_RUN=false
DO_ROLLBACK=false
DO_RECONCILE_BOOT=false
NON_BLOCKING_START=false
HEALTH_TIMEOUT=20
HEALTH_STABLE_SEC=3
LOCK_TIMEOUT=60

print_usage() {
  cat <<EOF
PRINTELLECT Kiosk Server — Service Installer & Migrator v${SCRIPT_VERSION}

Usage:
  sudo bash install-service.sh [OPTIONS]

Options:
  -s, --session-id <ID>          Set or update Kiosk Session ID in /etc/printellect/kiosk.env
  --enable                       Enable printellect.service to start on boot
  --start                        Start printellect.service and run post-start health-check gate
  --migrate-legacy [NAME]        Migrate from legacy service (auto-detects or accepts unit name/path)
  --node-bin <PATH>              Override Node.js >= 24 executable path (e.g. staged runtime in /opt)
  --health-timeout <SEC>         Max seconds to wait for daemon readiness (default: ${HEALTH_TIMEOUT})
  --health-stable-sec <SEC>      Post-readiness PID stability hold in seconds (default: ${HEALTH_STABLE_SEC})
  --lock-timeout <SEC>           Max seconds to wait for exclusive migration lock, 0=immediate (default: ${LOCK_TIMEOUT})
  --rollback                     Roll back to previous legacy service configuration from checkpoint
  --reconcile-boot               Idempotently reconcile an interrupted in_progress migration on boot
  --non-blocking-start           Use systemctl start --no-block during boot reconciliation
  --preflight-only               Validate prerequisites, paths, and legacy discovery without changes
  --dry-run                      Simulate installation and migration steps with verbose logging
  --root-dir <PATH>              Prefix all filesystem operations (for isolated testing without root)
  -h, --help                     Show this help message

Examples:
  sudo bash install-service.sh --preflight-only --migrate-legacy auto
  sudo bash install-service.sh --dry-run --migrate-legacy auto --enable --start
  sudo bash install-service.sh --migrate-legacy auto --enable --start
  sudo bash install-service.sh --migrate-legacy printellect-kiosk.service --enable --start
  sudo bash install-service.sh --rollback
  sudo bash install-service.sh --reconcile-boot
EOF
}

# Parse command line options
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--session-id)
      SESSION_ID="$2"
      shift 2
      ;;
    --enable)
      ENABLE_SERVICE=true
      shift
      ;;
    --start)
      START_SERVICE=true
      shift
      ;;
    --migrate-legacy)
      if [[ $# -gt 1 && ! "$2" =~ ^-- ]]; then
        LEGACY_SERVICE_SPEC="$2"
        shift 2
      else
        LEGACY_SERVICE_SPEC="auto"
        shift
      fi
      ;;
    --node-bin)
      CUSTOM_NODE_BIN="$2"
      shift 2
      ;;
    --health-timeout)
      HEALTH_TIMEOUT="$2"
      shift 2
      ;;
    --health-stable-sec)
      HEALTH_STABLE_SEC="$2"
      shift 2
      ;;
    --lock-timeout)
      LOCK_TIMEOUT="$2"
      shift 2
      ;;
    --rollback)
      DO_ROLLBACK=true
      shift
      ;;
    --reconcile-boot)
      DO_RECONCILE_BOOT=true
      shift
      ;;
    --non-blocking-start)
      NON_BLOCKING_START=true
      shift
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --root-dir)
      ROOT_DIR="${2%/}"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown option: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

log() {
  echo "[INFO] $*"
}

warn() {
  echo "[WARN] $*" >&2
}

fatal() {
  echo "[FATAL ERROR] $*" >&2
  exit 1
}

if [[ ! "${HEALTH_TIMEOUT}" =~ ^[0-9]+$ ]] || [[ "${HEALTH_TIMEOUT}" -lt 1 ]]; then
  fatal "--health-timeout must be a positive integer."
fi
if [[ ! "${HEALTH_STABLE_SEC}" =~ ^[0-9]+$ ]]; then
  fatal "--health-stable-sec must be a non-negative integer."
fi
if [[ ! "${LOCK_TIMEOUT}" =~ ^[0-9]+$ ]]; then
  fatal "--lock-timeout must be a non-negative integer."
fi

# Redact sensitive session IDs, CLI arguments, and query tokens from diagnostic log dumps
redact_sensitive_stream() {
  sed -E \
    -e 's/(KIOSK_SESSION_ID=["'\'']?)[^"'\''[:space:]]+/\1[REDACTED]/g' \
    -e 's/(--session-id[=[:space:]]+["'\'']?)[^"'\''[:space:]]+/\1[REDACTED]/g' \
    -e 's/([?&](token|key|apiKey|signature|sig|access_token)=)[^&[:space:]"'\'')]+/\1[REDACTED]/gi' \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/g' \
    -e 's#(index\.js[[:space:]]+)[^-[:space:]][^[:space:]]*#\1[REDACTED_ARG]#g'
}

# Mask sensitive tokens for safe logging (never log secrets)
mask_token() {
  local token="$1"
  local len="${#token}"
  if [[ "${len}" -le 4 ]]; then
    echo "****"
  elif [[ "${len}" -le 8 ]]; then
    echo "${token:0:1}****${token: -1}"
  else
    echo "${token:0:3}****${token: -2} (length: ${len})"
  fi
}

# Returns 0 when systemctl operations should execute (live host, or isolated test with mock systemd)
if [[ "${PRINTELLECT_TEST_SYSTEMD:-0}" == "1" && -n "${ROOT_DIR}" && -n "${PRINTELLECT_TEST_PATH_PREFIX:-}" ]]; then
  export PATH="${PRINTELLECT_TEST_PATH_PREFIX}:${PATH}"
fi

systemd_active() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 1
  fi
  if [[ -z "${ROOT_DIR}" ]]; then
    return 0
  fi
  if [[ "${PRINTELLECT_TEST_SYSTEMD:-0}" == "1" ]]; then
    return 0
  fi
  return 1
}

# Strip ROOT_DIR prefix to inspect logical OS path
strip_root_prefix() {
  local p="$1"
  if [[ -n "${ROOT_DIR}" && "${p}" == "${ROOT_DIR}"/* ]]; then
    echo "${p#${ROOT_DIR}}"
  else
    echo "${p}"
  fi
}

# Vendor/package-managed systemd paths must NEVER be modified or overwritten
is_vendor_systemd_path() {
  local logical
  logical="$(strip_root_prefix "$1")"
  if [[ "${logical}" =~ ^/(lib|usr/lib|usr/local/lib)/systemd/system(/|$) ]]; then
    return 0
  fi
  return 1
}

# Atomically install a regular file without following any destination symlink
atomic_install_file() {
  local src="$1"
  local dest="$2"
  local mode="$3"
  local dest_dir
  dest_dir="$(dirname "${dest}")"
  mkdir -p "${dest_dir}"
  local tmp_dest="${dest_dir}/.$(basename "${dest}").tmp.$$"
  cp -L "${src}" "${tmp_dest}"
  chmod "${mode}" "${tmp_dest}"
  mv -f "${tmp_dest}" "${dest}"
}

# Flush filesystem buffers when sync is available
flush_disk() {
  if command -v sync >/dev/null 2>&1; then
    sync || true
  fi
}

# Resolve a symlink target safely within ROOT_DIR (returns "/dev/null" if masked)
resolve_symlink_target_in_root() {
  local link_file="$1"
  local raw_target
  raw_target="$(readlink "${link_file}" 2>/dev/null || true)"
  if [[ -z "${raw_target}" ]]; then
    echo ""
    return
  fi
  if [[ "${raw_target}" == "/dev/null" ]]; then
    echo "/dev/null"
    return
  fi
  if [[ "${raw_target}" == /* ]]; then
    if [[ -n "${ROOT_DIR}" && "${raw_target}" != "${ROOT_DIR}"/* && -e "${ROOT_DIR}${raw_target}" ]]; then
      echo "${ROOT_DIR}${raw_target}"
    else
      echo "${raw_target}"
    fi
  else
    local link_dir
    link_dir="$(dirname "${link_file}")"
    echo "${link_dir}/${raw_target}"
  fi
}

# Resolve directory paths (honoring ROOT_DIR if provided)
BASE_DIR="${ROOT_DIR}/opt/printellect"
CURRENT_LINK="${BASE_DIR}/current"
CONFIG_DIR="${ROOT_DIR}/var/lib/printellect"
CONFIG_FILE="${CONFIG_DIR}/config.json"
BACKUP_DIR="${CONFIG_DIR}/backups"
ENV_DIR="${ROOT_DIR}/etc/printellect"
ENV_FILE="${ENV_DIR}/kiosk.env"
MIGRATION_META="${ENV_DIR}/migration.json"
RECOVER_SCRIPT_DEST="${ENV_DIR}/recover-migration.sh"
SYSTEMD_DIR="${ROOT_DIR}/etc/systemd/system"
TARGET_UNIT_FILE="${SYSTEMD_DIR}/printellect.service"
TARGET_RUNTIME_DROPIN_DIR="${SYSTEMD_DIR}/printellect.service.d"
TARGET_RUNTIME_DROPIN_FILE="${TARGET_RUNTIME_DROPIN_DIR}/10-runtime.conf"
RECOVER_UNIT_NAME="printellect-migration-recover.service"
RECOVER_UNIT_FILE="${SYSTEMD_DIR}/${RECOVER_UNIT_NAME}"
RECOVER_DROPIN_DIR="${SYSTEMD_DIR}/${RECOVER_UNIT_NAME}.d"
RECOVER_ORDER_DROPIN="${RECOVER_DROPIN_DIR}/10-legacy-order.conf"
SELF_SCRIPT_PATH="${BASH_SOURCE[0]}"

echo "=========================================================="
echo "   PRINTELLECT KIOSK SERVER — SYSTEMD SERVICE MANAGER     "
echo "=========================================================="

# 1. Privilege Check
if [[ "${DRY_RUN}" != "true" && "${PREFLIGHT_ONLY}" != "true" && -z "${ROOT_DIR}" ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    fatal "This script must be run as root (e.g. sudo bash install-service.sh)."
  fi
fi

# Exclusive lock to serialize concurrent migration, rollback, or boot reconciliation
MIGRATION_LOCK_ACQUIRED=false
acquire_migration_lock() {
  [[ "${DRY_RUN}" == "true" || "${PREFLIGHT_ONLY}" == "true" ]] && return 0
  [[ "${MIGRATION_LOCK_ACQUIRED}" == "true" ]] && return 0
  if command -v flock >/dev/null 2>&1; then
    local lock_file=""
    if [[ -z "${ROOT_DIR}" && -d "/run" && -w "/run" ]]; then
      lock_file="/run/printellect-migration.lock"
    elif [[ -n "${ROOT_DIR}" && -d "${ROOT_DIR}/run" && -w "${ROOT_DIR}/run" ]]; then
      lock_file="${ROOT_DIR}/run/printellect-migration.lock"
    else
      mkdir -p "${ENV_DIR}" 2>/dev/null || true
      lock_file="${ENV_DIR}/.migration.lock"
    fi
    if ! (: >> "${lock_file}") 2>/dev/null; then
      return 0
    fi
    exec 9>"${lock_file}"
    if [[ "${LOCK_TIMEOUT}" -eq 0 ]]; then
      if ! flock -x -n 9; then
        fatal "Could not acquire exclusive migration lock (${lock_file}): lock is already held by another active migration or recovery process."
      fi
    else
      if ! flock -x -w "${LOCK_TIMEOUT}" 9; then
        fatal "Could not acquire exclusive migration lock (${lock_file}) within ${LOCK_TIMEOUT}s. Another migration or recovery process is active."
      fi
    fi
    MIGRATION_LOCK_ACQUIRED=true
  fi
}

# Arm self-contained boot recovery unit BEFORE stopping or disabling legacy service
arm_boot_recovery_unit() {
  local legacy_unit_name="${1:-}"
  local template_recover="$2"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[DRY RUN] Would install self-contained boot recovery script to ${RECOVER_SCRIPT_DEST} (0700)"
    log "[DRY RUN] Would install and enable ${RECOVER_UNIT_NAME} ordered before printellect.service${legacy_unit_name:+ and ${legacy_unit_name}}"
    return 0
  fi

  atomic_install_file "${SELF_SCRIPT_PATH}" "${RECOVER_SCRIPT_DEST}" 0700
  chown root:root "${RECOVER_SCRIPT_DEST}" >/dev/null 2>&1 || true

  atomic_install_file "${template_recover}" "${RECOVER_UNIT_FILE}" 0644
  chown root:root "${RECOVER_UNIT_FILE}" >/dev/null 2>&1 || true

  if [[ -n "${legacy_unit_name}" && "${legacy_unit_name}" != "printellect.service" ]]; then
    mkdir -p "${RECOVER_DROPIN_DIR}"
    local order_tmp="${RECOVER_ORDER_DROPIN}.tmp.$$"
    cat > "${order_tmp}" <<EOF
# Managed by install-service.sh — guarantees boot recovery finishes before legacy daemon starts
[Unit]
Before=${legacy_unit_name}
EOF
    chmod 0644 "${order_tmp}"
    mv -f "${order_tmp}" "${RECOVER_ORDER_DROPIN}"
  elif [[ -f "${RECOVER_ORDER_DROPIN}" ]]; then
    rm -f "${RECOVER_ORDER_DROPIN}"
    rmdir "${RECOVER_DROPIN_DIR}" 2>/dev/null || true
  fi

  if systemd_active; then
    systemctl daemon-reload
    systemctl enable "${RECOVER_UNIT_NAME}"
  else
    mkdir -p "${SYSTEMD_DIR}/multi-user.target.wants"
    ln -sfn "/etc/systemd/system/${RECOVER_UNIT_NAME}" "${SYSTEMD_DIR}/multi-user.target.wants/${RECOVER_UNIT_NAME}" 2>/dev/null || true
  fi
  flush_disk
  log "Armed boot power-loss recovery unit: ${RECOVER_UNIT_NAME} (script: ${RECOVER_SCRIPT_DEST})."
}

# Disarm boot recovery unit AFTER migration reaches terminal 'completed' or 'rolled_back' state
disarm_boot_recovery_unit() {
  [[ "${DRY_RUN}" == "true" ]] && return 0
  if systemd_active; then
    systemctl disable "${RECOVER_UNIT_NAME}" >/dev/null 2>&1 || true
  fi
  rm -f "${SYSTEMD_DIR}/multi-user.target.wants/${RECOVER_UNIT_NAME}" 2>/dev/null || true
  flush_disk
}

# Helper: Update checkpoint fields in MIGRATION_META atomically
update_migration_checkpoint() {
  local new_status="$1"
  local new_phase="$2"
  local reason="${3:-}"
  [[ ! -f "${MIGRATION_META}" ]] && return 0

  local now_iso
  now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local tmp_meta="${MIGRATION_META}.tmp.$$"

  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const [src, dst, st, ph, rsn, ts] = process.argv.slice(1);
      const data = JSON.parse(fs.readFileSync(src, "utf8"));
      data.status = st;
      data.checkpointPhase = ph;
      data.updatedAt = ts;
      if (st === "completed") data.completedAt = ts;
      if (rsn && (st === "rolled_back" || ph === "rolling_back")) {
        data.rollbackReason = rsn;
      }
      if (st === "rolled_back") {
        data.rolledBackAt = ts;
      }
      fs.writeFileSync(dst, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    ' "${MIGRATION_META}" "${tmp_meta}" "${new_status}" "${new_phase}" "${reason}" "${now_iso}"
    chmod 0600 "${tmp_meta}"
    mv -f "${tmp_meta}" "${MIGRATION_META}"
  else
    cp "${MIGRATION_META}" "${tmp_meta}"
    sed -i -E 's/"status"[[:space:]]*:[[:space:]]*"[^"]*"/"status": "'"${new_status}"'"/' "${tmp_meta}" || true
    sed -i -E 's/"checkpointPhase"[[:space:]]*:[[:space:]]*"[^"]*"/"checkpointPhase": "'"${new_phase}"'"/' "${tmp_meta}" || true
    if [[ "${new_status}" == "rolled_back" ]] && ! grep -q '"rolledBackAt"' "${tmp_meta}"; then
      sed -i -E 's/"status": "rolled_back"/"status": "rolled_back",\n  "rolledBackAt": "'"${now_iso}"'"/' "${tmp_meta}" || true
    fi
    chmod 0600 "${tmp_meta}"
    mv -f "${tmp_meta}" "${MIGRATION_META}"
  fi
  flush_disk

  # Isolated test hook: simulate sudden power loss / SIGKILL immediately after committing a checkpoint phase
  if [[ "${PRINTELLECT_TEST_SYSTEMD:-0}" == "1" && -n "${ROOT_DIR}" && -n "${PRINTELLECT_TEST_CRASH_AT_PHASE:-}" ]]; then
    if [[ "${new_phase}" == "${PRINTELLECT_TEST_CRASH_AT_PHASE}" ]]; then
      echo "[TEST CRASH] Simulating sudden power loss at checkpointPhase=${new_phase}" >&2
      trap - ERR INT TERM
      exit 137
    fi
  fi
}

# ==============================================================================
# UNIFIED ROLLBACK ENGINE (CLI --rollback AND Automatic Cutover Recovery)
# ==============================================================================
perform_rollback_from_metadata() {
  local rollback_reason="${1:-manual_rollback}"
  log "Executing emergency rollback procedure (reason: ${rollback_reason})..."

  # 1. Check metadata presence
  if [[ ! -f "${MIGRATION_META}" ]]; then
    cat >&2 <<EOF
[FATAL ERROR] Migration metadata file not found at ${MIGRATION_META}.
Cannot automatically determine which legacy service was migrated.

Manual recovery instructions:
1. Inspect ${BACKUP_DIR}/ for timestamped legacy unit backups.
2. Copy the desired backup: sudo cp -L ${BACKUP_DIR}/<backup-file> /etc/systemd/system/<legacy-unit>.service
3. Reload systemd: sudo systemctl daemon-reload
4. Re-enable legacy unit: sudo systemctl enable --now <legacy-unit>.service
5. Disable printellect unit: sudo systemctl disable --now printellect.service
EOF
    return 1
  fi

  # 2. Parse metadata safely ( works with or without node )
  local RESTORE_UNIT=""
  local RESTORE_PATH=""
  local BACKUP_FILE=""
  local DROPIN_DIR=""
  local DROPIN_BACKUP=""
  local IS_VENDOR="false"
  local IS_SYMLINK="false"
  local SYMLINK_TARGET=""
  local RB_WAS_ENABLED="false"
  local RB_WAS_ACTIVE="false"

  if command -v node >/dev/null 2>&1; then
    local parsed_lines
    parsed_lines="$(node -e '
      try {
        const fs = require("fs");
        const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        console.log(m.legacyUnitName || "");
        console.log(m.legacyUnitPath || "");
        console.log(m.unitBackup || "");
        console.log(m.etcDropinDir || m.dropinDir || "");
        console.log(m.etcDropinBackup || m.dropinBackup || "");
        console.log(m.legacyUnitIsVendor ? "true" : "false");
        console.log(m.legacyUnitIsSymlink ? "true" : "false");
        console.log(m.legacySymlinkTarget || "");
        console.log(m.wasEnabled ? "true" : "false");
        console.log(m.wasActive ? "true" : "false");
      } catch (_) {}
    ' "${MIGRATION_META}" 2>/dev/null || true)"

    if [[ -n "${parsed_lines}" ]]; then
      {
        IFS= read -r RESTORE_UNIT || true
        IFS= read -r RESTORE_PATH || true
        IFS= read -r BACKUP_FILE || true
        IFS= read -r DROPIN_DIR || true
        IFS= read -r DROPIN_BACKUP || true
        IFS= read -r IS_VENDOR || true
        IFS= read -r IS_SYMLINK || true
        IFS= read -r SYMLINK_TARGET || true
        IFS= read -r RB_WAS_ENABLED || true
        IFS= read -r RB_WAS_ACTIVE || true
      } <<< "${parsed_lines}"
    fi
  fi

  # Fallback to grep/sed if node is unavailable
  if [[ -z "${RESTORE_UNIT}" ]]; then
    RESTORE_UNIT="$(grep -E '"legacyUnitName"' "${MIGRATION_META}" | head -n1 | sed -E 's/.*"legacyUnitName"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true)"
  fi
  if [[ -z "${RESTORE_PATH}" ]]; then
    RESTORE_PATH="$(grep -E '"legacyUnitPath"' "${MIGRATION_META}" | head -n1 | sed -E 's/.*"legacyUnitPath"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true)"
  fi
  if [[ -z "${BACKUP_FILE}" ]]; then
    BACKUP_FILE="$(grep -E '"unitBackup"' "${MIGRATION_META}" | head -n1 | sed -E 's/.*"unitBackup"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true)"
  fi
  if [[ -z "${DROPIN_DIR}" ]]; then
    DROPIN_DIR="$(grep -E '"(etcDropinDir|dropinDir)"' "${MIGRATION_META}" | head -n1 | sed -E 's/.*"(etcDropinDir|dropinDir)"[[:space:]]*:[[:space:]]*"([^"]*)".*/\2/' || true)"
  fi
  if [[ -z "${DROPIN_BACKUP}" ]]; then
    DROPIN_BACKUP="$(grep -E '"(etcDropinBackup|dropinBackup)"' "${MIGRATION_META}" | head -n1 | sed -E 's/.*"(etcDropinBackup|dropinBackup)"[[:space:]]*:[[:space:]]*"([^"]*)".*/\2/' || true)"
  fi
  if [[ -z "${SYMLINK_TARGET}" ]]; then
    SYMLINK_TARGET="$(grep -E '"legacySymlinkTarget"' "${MIGRATION_META}" | head -n1 | sed -E 's/.*"legacySymlinkTarget"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true)"
  fi
  if grep -q '"legacyUnitIsVendor"[[:space:]]*:[[:space:]]*true' "${MIGRATION_META}"; then IS_VENDOR="true"; fi
  if grep -q '"legacyUnitIsSymlink"[[:space:]]*:[[:space:]]*true' "${MIGRATION_META}"; then IS_SYMLINK="true"; fi
  if grep -q '"wasEnabled"[[:space:]]*:[[:space:]]*true' "${MIGRATION_META}"; then RB_WAS_ENABLED="true"; fi
  if grep -q '"wasActive"[[:space:]]*:[[:space:]]*true' "${MIGRATION_META}"; then RB_WAS_ACTIVE="true"; fi

  if [[ -z "${RESTORE_UNIT}" || -z "${BACKUP_FILE}" || ! -f "${BACKUP_FILE}" ]]; then
    cat >&2 <<EOF
[FATAL ERROR] Migration metadata at ${MIGRATION_META} is incomplete or backup file is missing.
Recorded backup file: '${BACKUP_FILE}'

Manual recovery instructions:
1. Inspect ${BACKUP_DIR}/ for timestamped legacy unit backups.
2. Manually restore the unit: sudo cp -L ${BACKUP_DIR}/<backup-file> ${SYSTEMD_DIR}/
3. Reload systemd: sudo systemctl daemon-reload
4. Re-enable legacy unit: sudo systemctl enable --now <legacy-unit>.service
5. Disable printellect unit: sudo systemctl disable --now printellect.service
EOF
    return 1
  fi

  [[ -z "${RESTORE_PATH}" ]] && RESTORE_PATH="${SYSTEMD_DIR}/${RESTORE_UNIT}"
  if is_vendor_systemd_path "${RESTORE_PATH}"; then
    IS_VENDOR="true"
  fi

  log "Rollback target identified: ${RESTORE_UNIT}"
  log "Backup source: ${BACKUP_FILE}"
  log "Target destination: ${RESTORE_PATH} (vendor=${IS_VENDOR}, symlink=${IS_SYMLINK})"
  log "Previous state: wasEnabled=${RB_WAS_ENABLED}, wasActive=${RB_WAS_ACTIVE}"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[DRY RUN] Would stop and disable printellect.service"
    if [[ "${IS_VENDOR}" == "true" ]]; then
      log "[DRY RUN] Would preserve vendor unit ${RESTORE_PATH} without writing to vendor directory"
    elif [[ "${IS_SYMLINK}" == "true" && -n "${SYMLINK_TARGET}" ]]; then
      log "[DRY RUN] Would restore symlink ${RESTORE_PATH} -> ${SYMLINK_TARGET}"
    else
      log "[DRY RUN] Would atomically restore ${BACKUP_FILE} -> ${RESTORE_PATH}"
    fi
    if [[ -n "${DROPIN_BACKUP}" && -d "${DROPIN_BACKUP}" && -n "${DROPIN_DIR}" ]] && ! is_vendor_systemd_path "${DROPIN_DIR}"; then
      log "[DRY RUN] Would restore /etc drop-in directory ${DROPIN_BACKUP} -> ${DROPIN_DIR}"
    fi
    log "[DRY RUN] Would remove ${TARGET_UNIT_FILE}"
    if [[ "${RB_WAS_ENABLED}" == "true" ]]; then log "[DRY RUN] Would enable ${RESTORE_UNIT}"; fi
    if [[ "${RB_WAS_ACTIVE}" == "true" ]]; then log "[DRY RUN] Would start ${RESTORE_UNIT}"; fi
    log "[DRY RUN] Rollback simulation complete."
    return 0
  fi

  # Step 0: Acquire exclusive lock and persist 'rolling_back' phase (keeping status='in_progress'
  # until restoration finishes so a power failure mid-recovery re-triggers boot recovery cleanly!)
  acquire_migration_lock
  update_migration_checkpoint "in_progress" "rolling_back" "${rollback_reason}"

  # Step 1: Stop and disable printellect.service first to prevent dual-daemon split-brain
  if systemd_active; then
    systemctl stop printellect.service >/dev/null 2>&1 || true
    local pre_state
    pre_state="$(systemctl is-active printellect.service 2>/dev/null || echo "inactive")"
    if [[ "${pre_state}" == "active" || "${pre_state}" == "activating" ]]; then
      systemctl kill --kill-who=all printellect.service >/dev/null 2>&1 || true
      systemctl stop printellect.service >/dev/null 2>&1 || true
    fi
    systemctl disable printellect.service >/dev/null 2>&1 || true
  fi

  # Step 2: Clean up custom runtime drop-in created for printellect.service (if any)
  if [[ -f "${TARGET_RUNTIME_DROPIN_FILE}" ]]; then
    rm -f "${TARGET_RUNTIME_DROPIN_FILE}"
    rmdir "${TARGET_RUNTIME_DROPIN_DIR}" 2>/dev/null || true
  fi

  # Step 3: Remove new printellect.service unit file prior to restoring legacy unit
  if [[ -e "${TARGET_UNIT_FILE}" || -L "${TARGET_UNIT_FILE}" ]]; then
    rm -f "${TARGET_UNIT_FILE}"
  fi

  # Step 4: Restore legacy unit WITHOUT modifying vendor-managed files in /lib or /usr/lib
  if [[ "${IS_VENDOR}" == "true" ]]; then
    log "Vendor-managed unit ${RESTORE_UNIT}: leaving vendor directory unmodified."
    # If an override/mask was placed at /etc/systemd/system/<RESTORE_UNIT> (e.g. if named printellect.service), ensure removed
    if [[ "${RESTORE_UNIT}" == "printellect.service" ]]; then
      rm -f "${SYSTEMD_DIR}/${RESTORE_UNIT}"
    fi
    # Fallback only if vendor file itself disappeared externally: restore into /etc/systemd/system, NEVER /lib or /usr/lib
    if [[ ! -e "${RESTORE_PATH}" ]]; then
      warn "Vendor unit file ${RESTORE_PATH} no longer exists; restoring backup safely to ${SYSTEMD_DIR}/${RESTORE_UNIT}."
      atomic_install_file "${BACKUP_FILE}" "${SYSTEMD_DIR}/${RESTORE_UNIT}" 0644
    fi
  elif [[ "${IS_SYMLINK}" == "true" && -n "${SYMLINK_TARGET}" ]]; then
    local check_sym_target="${SYMLINK_TARGET}"
    if [[ "${SYMLINK_TARGET}" == /* && -n "${ROOT_DIR}" && "${SYMLINK_TARGET}" != "${ROOT_DIR}"/* && -e "${ROOT_DIR}${SYMLINK_TARGET}" ]]; then
      check_sym_target="${ROOT_DIR}${SYMLINK_TARGET}"
    elif [[ "${SYMLINK_TARGET}" != /* ]]; then
      check_sym_target="$(dirname "${RESTORE_PATH}")/${SYMLINK_TARGET}"
    fi

    if [[ -e "${check_sym_target}" ]]; then
      log "Restoring legacy unit symlink ${RESTORE_PATH} -> ${SYMLINK_TARGET}..."
      mkdir -p "$(dirname "${RESTORE_PATH}")"
      ln -sfn "${SYMLINK_TARGET}" "${RESTORE_PATH}"
    else
      warn "Original symlink target '${SYMLINK_TARGET}' is missing; restoring dereferenced backup to ${RESTORE_PATH}."
      atomic_install_file "${BACKUP_FILE}" "${RESTORE_PATH}" 0644
    fi
  else
    atomic_install_file "${BACKUP_FILE}" "${RESTORE_PATH}" 0644
  fi

  # Step 5: Restore /etc drop-in directory if previously backed up (never write to vendor drop-in paths)
  if [[ -n "${DROPIN_BACKUP}" && -d "${DROPIN_BACKUP}" && -n "${DROPIN_DIR}" ]]; then
    if is_vendor_systemd_path "${DROPIN_DIR}"; then
      log "Skipping write to vendor drop-in directory ${DROPIN_DIR} (preserved read-only)."
    else
      log "Restoring legacy drop-in directory to ${DROPIN_DIR}..."
      mkdir -p "${DROPIN_DIR}"
      for df in "${DROPIN_BACKUP}"/*; do
        [[ ! -e "${df}" ]] && continue
        atomic_install_file "${df}" "${DROPIN_DIR}/$(basename "${df}")" 0644
      done
    fi
  fi
  # Ensure no stray temporary Node 24 canary drop-in remains attached to the restored legacy unit
  if [[ -f "${SYSTEMD_DIR}/${RESTORE_UNIT}.d/99-printellect-node24-canary.conf" ]]; then
    rm -f "${SYSTEMD_DIR}/${RESTORE_UNIT}.d/99-printellect-node24-canary.conf"
    rmdir "${SYSTEMD_DIR}/${RESTORE_UNIT}.d" 2>/dev/null || true
  fi

  # Step 6: Reload systemd and restore previous lifecycle state
  if systemd_active; then
    systemctl daemon-reload
    systemctl reset-failed printellect.service >/dev/null 2>&1 || true
    systemctl reset-failed "${RESTORE_UNIT}" >/dev/null 2>&1 || true

    # Confirm printellect.service is not active when rolling back to a differently-named unit
    if [[ "${RESTORE_UNIT}" != "printellect.service" ]]; then
      local new_state
      new_state="$(systemctl is-active printellect.service 2>/dev/null || echo "inactive")"
      if [[ "${new_state}" == "active" || "${new_state}" == "activating" ]]; then
        systemctl kill --kill-who=all printellect.service >/dev/null 2>&1 || true
        systemctl stop printellect.service >/dev/null 2>&1 || true
      fi
    fi

    if [[ "${RB_WAS_ENABLED}" == "true" ]]; then
      systemctl enable "${RESTORE_UNIT}"
      log "Re-enabled legacy service: ${RESTORE_UNIT}"
    else
      systemctl disable "${RESTORE_UNIT}" >/dev/null 2>&1 || true
      log "Restored legacy service to disabled state: ${RESTORE_UNIT}"
    fi

    if [[ "${RB_WAS_ACTIVE}" == "true" ]]; then
      if [[ "${NON_BLOCKING_START}" == "true" ]]; then
        systemctl start --no-block "${RESTORE_UNIT}"
        log "Enqueued non-blocking boot start for restored legacy service: ${RESTORE_UNIT}"
      else
        systemctl start "${RESTORE_UNIT}"
        local restored_state
        restored_state="$(systemctl is-active "${RESTORE_UNIT}" 2>/dev/null || echo "unknown")"
        if [[ "${restored_state}" != "active" ]]; then
          warn "Legacy service '${RESTORE_UNIT}' reported state '${restored_state}' after rollback start."
        else
          log "Verified restored legacy service is active: ${RESTORE_UNIT}"
        fi
      fi
    else
      log "Legacy service was previously inactive; leaving stopped."
    fi
  fi

  # Step 7: Commit terminal 'rolled_back' status first, flush to disk, then disarm boot recovery unit
  local final_rb_phase="rolled_back"
  if [[ "${DO_RECONCILE_BOOT}" == "true" ]]; then
    final_rb_phase="boot_recovered"
  fi
  update_migration_checkpoint "rolled_back" "${final_rb_phase}" "${rollback_reason}"
  disarm_boot_recovery_unit

  echo ""
  echo "=========================================================="
  echo "   ROLLBACK COMPLETED SUCCESSFULLY                        "
  echo "=========================================================="
  log "Restored legacy service: ${RESTORE_UNIT}"
  log "Backup file preserved at: ${BACKUP_FILE}"
  log "Persistent configuration preserved at: ${CONFIG_FILE}"
  return 0
}

# ==============================================================================
# BOOT-TIME POWER-LOSS RECONCILIATION (--reconcile-boot)
# ==============================================================================
reconcile_boot_migration() {
  acquire_migration_lock

  if [[ ! -f "${MIGRATION_META}" ]]; then
    log "Boot reconciliation: no migration metadata at ${MIGRATION_META}; nothing to reconcile."
    disarm_boot_recovery_unit
    return 0
  fi

  local meta_status=""
  local meta_phase=""

  if command -v node >/dev/null 2>&1; then
    local parsed_meta
    parsed_meta="$(node -e '
      try {
        const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        console.log(m.status || "");
        console.log(m.checkpointPhase || "");
      } catch (_) {}
    ' "${MIGRATION_META}" 2>/dev/null || true)"
    if [[ -n "${parsed_meta}" ]]; then
      {
        IFS= read -r meta_status || true
        IFS= read -r meta_phase || true
      } <<< "${parsed_meta}"
    fi
  fi

  if [[ -z "${meta_status}" ]]; then
    meta_status="$(grep -E '"status"' "${MIGRATION_META}" | head -n1 | sed -E 's/.*"status"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true)"
  fi
  if [[ -z "${meta_phase}" ]]; then
    meta_phase="$(grep -E '"checkpointPhase"' "${MIGRATION_META}" | head -n1 | sed -E 's/.*"checkpointPhase"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true)"
  fi

  if [[ "${meta_status}" != "in_progress" ]]; then
    log "Boot reconciliation: migration status is '${meta_status:-unknown}' (phase='${meta_phase:-unknown}'); no interrupted migration to reconcile."
    disarm_boot_recovery_unit
    return 0
  fi

  warn "Boot reconciliation: detected interrupted migration (status=in_progress, phase=${meta_phase:-unknown})!"
  warn "Reconciling automatically to restore deterministic service availability without dual-daemon concurrency..."
  perform_rollback_from_metadata "boot_power_loss_recovery_from_${meta_phase:-unknown}"
}

# ==============================================================================
# STANDALONE --reconcile-boot AND --rollback ENTRYPOINTS
# ==============================================================================
if [[ "${DO_RECONCILE_BOOT}" == "true" ]]; then
  if reconcile_boot_migration; then
    exit 0
  else
    exit 1
  fi
fi

if [[ "${DO_ROLLBACK}" == "true" ]]; then
  if perform_rollback_from_metadata "operator_requested_rollback"; then
    exit 0
  else
    exit 1
  fi
fi

# ==============================================================================
# INTERRUPTED INSTALLER GUARD
# ==============================================================================
if [[ -f "${MIGRATION_META}" ]]; then
  if grep -q '"status"[[:space:]]*:[[:space:]]*"in_progress"' "${MIGRATION_META}" 2>/dev/null; then
    prev_phase="$(grep -E '"checkpointPhase"' "${MIGRATION_META}" | head -n1 | sed -E 's/.*"checkpointPhase"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || echo "unknown")"
    fatal "Detected an interrupted migration in ${MIGRATION_META} (status=in_progress, phase=${prev_phase}). Refusing to overwrite pre-migration checkpoint metadata. Run 'sudo bash install-service.sh --rollback' (or '--reconcile-boot') first to restore a clean baseline."
  fi
fi

# ==============================================================================
# PREFLIGHT & RUNTIME VERIFICATION
# ==============================================================================
log "Running preflight validation..."

# 1. Node.js 24 Runtime Verification
# Preferred default: staged versioned runtime under /opt/printellect/runtime/current/bin/node
# so /usr/bin/node, apt repositories, and legacy services remain completely untouched.
NODE_BIN=""
RUNTIME_OVERRIDE_BIN=""

if [[ -n "${CUSTOM_NODE_BIN}" ]]; then
  NODE_BIN="${CUSTOM_NODE_BIN}"
  RUNTIME_OVERRIDE_BIN="${CUSTOM_NODE_BIN}"
elif [[ -x "${BASE_DIR}/runtime/current/bin/node" ]]; then
  NODE_BIN="${BASE_DIR}/runtime/current/bin/node"
  RUNTIME_OVERRIDE_BIN="${BASE_DIR}/runtime/current/bin/node"
elif [[ -z "${ROOT_DIR}" && -x "/opt/printellect/runtime/current/bin/node" ]]; then
  NODE_BIN="/opt/printellect/runtime/current/bin/node"
  RUNTIME_OVERRIDE_BIN="/opt/printellect/runtime/current/bin/node"
elif [[ -n "${ROOT_DIR}" && -x "${ROOT_DIR}/usr/bin/node" ]]; then
  NODE_BIN="${ROOT_DIR}/usr/bin/node"
elif [[ -z "${ROOT_DIR}" && -x "/usr/bin/node" ]]; then
  NODE_BIN="/usr/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [[ -n "${CUSTOM_NODE_BIN}" ]]; then
  logical_node="$(strip_root_prefix "${CUSTOM_NODE_BIN}")"
  if [[ "${logical_node}" =~ ^/(home|root)(/|$) ]]; then
    fatal "Custom --node-bin '${CUSTOM_NODE_BIN}' resides under /home or /root, which is hidden by ProtectHome=true in printellect.service. Stage runtimes under /opt/printellect/runtime/."
  fi
  if [[ ! -x "${CUSTOM_NODE_BIN}" ]]; then
    fatal "Specified --node-bin '${CUSTOM_NODE_BIN}' does not exist or is not executable."
  fi
fi

if [[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]]; then
  NODE_VER="$("${NODE_BIN}" -v || echo "unknown")"
  log "Detected Node.js runtime: ${NODE_BIN} (${NODE_VER})"

  NODE_MAJOR="$(echo "${NODE_VER}" | sed -E 's/^v([0-9]+).*/\1/' || echo "0")"
  if [[ "${NODE_MAJOR}" =~ ^[0-9]+$ ]] && [[ "${NODE_MAJOR}" -lt 24 ]]; then
    fatal "Incompatible Node.js runtime (${NODE_VER}) at ${NODE_BIN}. Printellect Kiosk Server requires Node.js >= 24 LTS."
  fi
else
  if [[ -z "${ROOT_DIR}" ]]; then
    fatal "Node.js executable not found in /opt/printellect/runtime/current/bin/node, in PATH, or at /usr/bin/node. Stage Node.js 24 side-by-side using stage-node-runtime.sh first."
  else
    warn "Node.js executable not found in isolated test environment (continuing for test harness)."
  fi
fi

# 2. Release Directory Check
if [[ ! -d "${CURRENT_LINK}" && "${DRY_RUN}" != "true" && -z "${ROOT_DIR}" ]]; then
  fatal "Application release directory not found at ${CURRENT_LINK}. Run bootstrap installer first."
fi

# 3. Locate template service units (daemon unit + boot power-loss recovery unit)
TEMPLATE_UNIT=""
if [[ -f "${CURRENT_LINK}/systemd/printellect.service" ]]; then
  TEMPLATE_UNIT="${CURRENT_LINK}/systemd/printellect.service"
elif [[ -f "systemd/printellect.service" ]]; then
  TEMPLATE_UNIT="systemd/printellect.service"
elif [[ -f "../systemd/printellect.service" ]]; then
  TEMPLATE_UNIT="../systemd/printellect.service"
fi

if [[ -z "${TEMPLATE_UNIT}" || ! -f "${TEMPLATE_UNIT}" ]]; then
  fatal "Systemd template unit 'printellect.service' not found."
fi
log "Found unit template: ${TEMPLATE_UNIT}"

TEMPLATE_RECOVER_UNIT=""
if [[ -f "${CURRENT_LINK}/systemd/printellect-migration-recover.service" ]]; then
  TEMPLATE_RECOVER_UNIT="${CURRENT_LINK}/systemd/printellect-migration-recover.service"
elif [[ -f "systemd/printellect-migration-recover.service" ]]; then
  TEMPLATE_RECOVER_UNIT="systemd/printellect-migration-recover.service"
elif [[ -f "../systemd/printellect-migration-recover.service" ]]; then
  TEMPLATE_RECOVER_UNIT="../systemd/printellect-migration-recover.service"
fi

if [[ -z "${TEMPLATE_RECOVER_UNIT}" || ! -f "${TEMPLATE_RECOVER_UNIT}" ]]; then
  fatal "Systemd boot recovery template unit 'printellect-migration-recover.service' not found."
fi
log "Found boot recovery unit template: ${TEMPLATE_RECOVER_UNIT}"

# ==============================================================================
# LEGACY SERVICE DISCOVERY & PRE-MIGRATION AUDIT
# ==============================================================================
# Collect all drop-in directories for a given unit basename in systemd precedence order
collect_dropin_dirs() {
  local unit_base="$1"
  local primary_unit_path="$2"
  local candidate_dirs=(
    "${ROOT_DIR}/usr/lib/systemd/system/${unit_base}.d"
    "${ROOT_DIR}/lib/systemd/system/${unit_base}.d"
    "${ROOT_DIR}/usr/local/lib/systemd/system/${unit_base}.d"
    "${SYSTEMD_DIR}/${unit_base}.d"
  )
  if [[ -n "${primary_unit_path}" ]]; then
    candidate_dirs+=("${primary_unit_path}.d")
  fi

  local seen_real=()
  for d in "${candidate_dirs[@]}"; do
    [[ ! -d "${d}" ]] && continue
    local rp
    rp="$(cd "${d}" 2>/dev/null && pwd -P || echo "${d}")"
    local dup=false
    for sr in "${seen_real[@]:-}"; do
      if [[ "${sr}" == "${rp}" ]]; then
        dup=true
        break
      fi
    done
    if [[ "${dup}" == "false" ]]; then
      seen_real+=("${rp}")
      echo "${d}"
    fi
  done
}

# Collect ordered list of readable config files (base unit + sorted *.conf drop-ins)
collect_effective_unit_files() {
  local unit_base="$1"
  local readable_unit_file="$2"
  local orig_unit_path="$3"

  echo "${readable_unit_file}"
  local ddir
  while IFS= read -r ddir; do
    [[ -z "${ddir}" ]] && continue
    for cf in "${ddir}"/*.conf; do
      [[ ! -e "${cf}" && ! -L "${cf}" ]] && continue
      echo "${cf}"
    done
  done < <(collect_dropin_dirs "${unit_base}" "${orig_unit_path}")
}

# Validate that a candidate unit and all of its drop-ins can be safely read & backed up
verify_unit_readable_and_valid() {
  local unit_base="$1"
  local orig_path="$2"
  local read_path="$3"

  if [[ "${read_path}" == "/dev/null" ]]; then
    fatal "Legacy unit '${unit_base}' (${orig_path}) is masked (-> /dev/null) and cannot be safely migrated. Aborting without stopping any service."
  fi
  if [[ ! -e "${read_path}" ]]; then
    fatal "Legacy unit '${unit_base}' (${orig_path}) resolves to missing target '${read_path}'. Cannot safely identify and back up unit. Aborting without stopping any service."
  fi
  if [[ ! -r "${read_path}" || ! -s "${read_path}" ]]; then
    fatal "Legacy unit '${unit_base}' (${read_path}) is unreadable or empty. Cannot create verified backup. Aborting without stopping any service."
  fi

  local f
  while IFS= read -r f; do
    [[ -z "${f}" ]] && continue
    if [[ -L "${f}" ]]; then
      local resolved_cf
      resolved_cf="$(resolve_symlink_target_in_root "${f}")"
      if [[ -z "${resolved_cf}" || "${resolved_cf}" == "/dev/null" || ! -r "${resolved_cf}" ]]; then
        fatal "Drop-in file '${f}' for '${unit_base}' is a broken/unreadable symlink. Aborting without stopping any service."
      fi
    elif [[ ! -r "${f}" ]]; then
      fatal "Drop-in file '${f}' for '${unit_base}' is unreadable. Aborting without stopping any service."
    fi
  done < <(collect_effective_unit_files "${unit_base}" "${read_path}" "${orig_path}")
}

ACTUAL_LEGACY_UNIT_PATH=""
ACTUAL_LEGACY_READ_PATH=""
ACTUAL_LEGACY_UNIT_NAME=""

if [[ -n "${LEGACY_SERVICE_SPEC}" ]]; then
  if [[ "${LEGACY_SERVICE_SPEC}" != "auto" ]]; then
    # Explicit unit name or path specified by operator
    CANDIDATE_SPEC_PATHS=()
    if [[ "${LEGACY_SERVICE_SPEC}" == /* ]]; then
      CANDIDATE_SPEC_PATHS+=("${LEGACY_SERVICE_SPEC}")
      [[ -n "${ROOT_DIR}" && "${LEGACY_SERVICE_SPEC}" != "${ROOT_DIR}"/* ]] && CANDIDATE_SPEC_PATHS+=("${ROOT_DIR}${LEGACY_SERVICE_SPEC}")
    else
      CANDIDATE_SPEC_PATHS+=(
        "${SYSTEMD_DIR}/${LEGACY_SERVICE_SPEC}"
        "${ROOT_DIR}/usr/local/lib/systemd/system/${LEGACY_SERVICE_SPEC}"
        "${ROOT_DIR}/lib/systemd/system/${LEGACY_SERVICE_SPEC}"
        "${ROOT_DIR}/usr/lib/systemd/system/${LEGACY_SERVICE_SPEC}"
      )
      for wlink in "${SYSTEMD_DIR}"/*.target.wants/"${LEGACY_SERVICE_SPEC}"; do
        [[ -e "${wlink}" || -L "${wlink}" ]] && CANDIDATE_SPEC_PATHS+=("${wlink}")
      done
    fi

    FOUND_SPEC=""
    for cp_path in "${CANDIDATE_SPEC_PATHS[@]}"; do
      if [[ -L "${cp_path}" || -e "${cp_path}" ]]; then
        FOUND_SPEC="${cp_path}"
        break
      fi
    done

    if [[ -z "${FOUND_SPEC}" ]]; then
      fatal "Specified legacy unit '${LEGACY_SERVICE_SPEC}' does not exist in systemd unit directories."
    fi

    # If found via .target.wants symlink, resolve to actual unit file path
    if [[ "${FOUND_SPEC}" == *".target.wants/"* && -L "${FOUND_SPEC}" ]]; then
      ACTUAL_LEGACY_READ_PATH="$(resolve_symlink_target_in_root "${FOUND_SPEC}")"
      ACTUAL_LEGACY_UNIT_PATH="${ACTUAL_LEGACY_READ_PATH}"
    elif [[ -L "${FOUND_SPEC}" ]]; then
      ACTUAL_LEGACY_UNIT_PATH="${FOUND_SPEC}"
      ACTUAL_LEGACY_READ_PATH="$(resolve_symlink_target_in_root "${FOUND_SPEC}")"
    else
      ACTUAL_LEGACY_UNIT_PATH="${FOUND_SPEC}"
      ACTUAL_LEGACY_READ_PATH="${FOUND_SPEC}"
    fi

    ACTUAL_LEGACY_UNIT_NAME="$(basename "${FOUND_SPEC}")"
    verify_unit_readable_and_valid "${ACTUAL_LEGACY_UNIT_NAME}" "${ACTUAL_LEGACY_UNIT_PATH}" "${ACTUAL_LEGACY_READ_PATH}"
  else
    # Auto-discovery mode across /etc/systemd/system, *.target.wants symlinks, /usr/local/lib, /lib, /usr/lib
    MATCHED_UNITS=()
    MATCHED_READ_PATHS=()
    SEEN_NAMES=()

    CANDIDATE_FILES=()
    for f in "${SYSTEMD_DIR}"/*.service; do
      [[ -e "${f}" || -L "${f}" ]] && CANDIDATE_FILES+=("${f}")
    done
    for f in "${SYSTEMD_DIR}"/*.target.wants/*.service; do
      [[ -e "${f}" || -L "${f}" ]] && CANDIDATE_FILES+=("${f}")
    done
    for vdir in "${ROOT_DIR}/usr/local/lib/systemd/system" "${ROOT_DIR}/lib/systemd/system" "${ROOT_DIR}/usr/lib/systemd/system"; do
      [[ ! -d "${vdir}" ]] && continue
      for f in "${vdir}"/*.service; do
        [[ -e "${f}" || -L "${f}" ]] && CANDIDATE_FILES+=("${f}")
      done
    done

    for u in "${CANDIDATE_FILES[@]:-}"; do
      [[ -z "${u}" ]] && continue
      base_u="$(basename "${u}")"
      # Ignore target production unit and boot recovery unit in auto-discovery
      [[ "${base_u}" == "printellect.service" || "${base_u}" == "${RECOVER_UNIT_NAME}" ]] && continue

      # Deduplicate by unit basename in systemd precedence order
      already_seen=false
      for seen in "${SEEN_NAMES[@]:-}"; do
        if [[ "${seen}" == "${base_u}" ]]; then
          already_seen=true
          break
        fi
      done
      [[ "${already_seen}" == "true" ]] && continue

      unit_record_path="${u}"
      unit_read_path="${u}"

      if [[ -L "${u}" ]]; then
        resolved_u="$(resolve_symlink_target_in_root "${u}")"
        if [[ "${resolved_u}" == "/dev/null" ]]; then
          log "Skipping masked systemd unit: ${base_u} (-> /dev/null)"
          SEEN_NAMES+=("${base_u}")
          continue
        fi
        if [[ -z "${resolved_u}" || ! -e "${resolved_u}" ]]; then
          # If a broken symlink looks like a Printellect/kiosk unit, abort safely instead of ignoring!
          if [[ "${base_u}" =~ (kiosk|printellect) ]]; then
            fatal "Broken symlink detected for candidate legacy unit '${u}'. Cannot safely identify and back up legacy unit. Aborting without stopping any service."
          fi
          continue
        fi
        unit_read_path="${resolved_u}"
        # If discovered only through a .target.wants enablement symlink, record the resolved unit definition path
        if [[ "${u}" == *".target.wants/"* ]]; then
          unit_record_path="${resolved_u}"
        fi
      elif [[ ! -e "${u}" ]]; then
        continue
      fi

      # Build list of base unit + all drop-in files to inspect content across overrides
      effective_files=()
      while IFS= read -r ef; do
        [[ -z "${ef}" ]] && continue
        if [[ -L "${ef}" ]]; then
          ef_res="$(resolve_symlink_target_in_root "${ef}")"
          [[ -n "${ef_res}" && "${ef_res}" != "/dev/null" && -e "${ef_res}" ]] && effective_files+=("${ef_res}")
        elif [[ -e "${ef}" ]]; then
          effective_files+=("${ef}")
        fi
      done < <(collect_effective_unit_files "${base_u}" "${unit_read_path}" "${unit_record_path}")

      # Check if unit name or any effective file (base or drop-in) references printellect/kiosk daemon
      is_candidate=false
      has_brand_ref=false
      has_daemon_ref=false

      if [[ "${base_u}" =~ (kiosk|printellect) ]]; then
        has_brand_ref=true
      elif [[ "${#effective_files[@]}" -gt 0 ]] && grep -qiE '(printellect|kiosk)' "${effective_files[@]}" 2>/dev/null; then
        has_brand_ref=true
      fi

      if [[ "${has_brand_ref}" == "true" ]]; then
        if [[ "${base_u}" =~ ^(kiosk-daemon|kiosk|printellect-kiosk|printellect-server|printellect-daemon)\.service$ ]]; then
          has_daemon_ref=true
        elif [[ "${#effective_files[@]}" -gt 0 ]] && grep -qE '(index\.js|printellect-kiosk|printellect-server|printellect-daemon)' "${effective_files[@]}" 2>/dev/null; then
          has_daemon_ref=true
        fi
      fi

      if [[ "${has_brand_ref}" == "true" && "${has_daemon_ref}" == "true" ]]; then
        is_candidate=true
      fi

      if [[ "${is_candidate}" == "true" ]]; then
        verify_unit_readable_and_valid "${base_u}" "${unit_record_path}" "${unit_read_path}"
        MATCHED_UNITS+=("${unit_record_path}")
        MATCHED_READ_PATHS+=("${unit_read_path}")
        SEEN_NAMES+=("${base_u}")
      fi
    done

    if [[ "${#MATCHED_UNITS[@]}" -eq 0 ]]; then
      # Safety cross-check on live systemd hosts: ensure no unrecognized running printellect/kiosk unit is missed
      if systemd_active; then
        running_unmatched="$(systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}' | grep -iE '(printellect|kiosk)' | grep -vE '^(printellect|printellect-migration-recover)\.service$' || true)"
        if [[ -n "${running_unmatched}" ]]; then
          fatal "Active service(s) matching printellect/kiosk detected via systemctl (${running_unmatched}), but unit files could not be safely resolved and backed up. Aborting without stopping any service. Specify unit explicitly with --migrate-legacy <unit>."
        fi
      fi
      log "No legacy Printellect service units detected in systemd search paths. Proceeding with fresh service setup."
    elif [[ "${#MATCHED_UNITS[@]}" -eq 1 ]]; then
      ACTUAL_LEGACY_UNIT_PATH="${MATCHED_UNITS[0]}"
      ACTUAL_LEGACY_READ_PATH="${MATCHED_READ_PATHS[0]}"
      log "Auto-discovered legacy Printellect service: $(basename "${ACTUAL_LEGACY_UNIT_PATH}")"
    else
      fatal "Multiple candidate legacy services discovered: [${MATCHED_UNITS[*]}]. Migration target is ambiguous! Aborting to prevent modifying the wrong service. Please specify explicitly using --migrate-legacy <unit_name>."
    fi
  fi
fi

# Audit discovered legacy unit & drop-ins in systemd precedence order
LEGACY_USER=""
LEGACY_WORKDIR=""
LEGACY_EXECSTART=""
LEGACY_ETC_DROPIN_DIR=""
LEGACY_VENDOR_DROPIN_DIRS=()
LEGACY_IS_VENDOR=false
LEGACY_IS_SYMLINK=false
LEGACY_SYMLINK_TARGET=""
WAS_ENABLED=false
WAS_ACTIVE=false
ACTIVE_STATE="unknown"
EFFECTIVE_LEGACY_FILES=()

if [[ -n "${ACTUAL_LEGACY_UNIT_PATH}" ]]; then
  ACTUAL_LEGACY_UNIT_NAME="$(basename "${ACTUAL_LEGACY_UNIT_PATH}")"
  log "Auditing legacy service: ${ACTUAL_LEGACY_UNIT_NAME} (${ACTUAL_LEGACY_UNIT_PATH})"

  if is_vendor_systemd_path "${ACTUAL_LEGACY_UNIT_PATH}"; then
    LEGACY_IS_VENDOR=true
    log "Legacy unit resides in vendor-managed directory (${ACTUAL_LEGACY_UNIT_PATH}); vendor file will not be modified."
  fi

  if [[ -L "${ACTUAL_LEGACY_UNIT_PATH}" ]]; then
    LEGACY_IS_SYMLINK=true
    LEGACY_SYMLINK_TARGET="$(readlink "${ACTUAL_LEGACY_UNIT_PATH}" || true)"
    log "Legacy unit is a symlink: ${ACTUAL_LEGACY_UNIT_PATH} -> ${LEGACY_SYMLINK_TARGET}"
  fi

  while IFS= read -r ddir; do
    [[ -z "${ddir}" ]] && continue
    if is_vendor_systemd_path "${ddir}"; then
      LEGACY_VENDOR_DROPIN_DIRS+=("${ddir}")
      log "Detected vendor drop-in directory (read-only): ${ddir}"
    else
      LEGACY_ETC_DROPIN_DIR="${ddir}"
      log "Detected admin drop-in directory: ${LEGACY_ETC_DROPIN_DIR}"
      if [[ -f "${ddir}/99-printellect-node24-canary.conf" ]]; then
        fatal "Temporary staged Node.js 24 canary override detected at ${ddir}/99-printellect-node24-canary.conf. Run 'sudo bash scripts/validate-legacy-node24.sh --restore' to restore the clean legacy baseline before starting migration."
      fi
    fi
  done < <(collect_dropin_dirs "${ACTUAL_LEGACY_UNIT_NAME}" "${ACTUAL_LEGACY_UNIT_PATH}")

  while IFS= read -r ef; do
    [[ -z "${ef}" ]] && continue
    if [[ -L "${ef}" ]]; then
      EFFECTIVE_LEGACY_FILES+=("$(resolve_symlink_target_in_root "${ef}")")
    else
      EFFECTIVE_LEGACY_FILES+=("${ef}")
    fi
  done < <(collect_effective_unit_files "${ACTUAL_LEGACY_UNIT_NAME}" "${ACTUAL_LEGACY_READ_PATH}" "${ACTUAL_LEGACY_UNIT_PATH}")

  # Extract effective User=, WorkingDirectory=, ExecStart= using last non-empty assignment (systemd override precedence)
  LEGACY_USER="$(grep -hE '^[[:space:]]*User=.+' "${EFFECTIVE_LEGACY_FILES[@]}" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]"\047' || true)"
  LEGACY_WORKDIR="$(grep -hE '^[[:space:]]*WorkingDirectory=.+' "${EFFECTIVE_LEGACY_FILES[@]}" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]"\047' || true)"
  LEGACY_EXECSTART="$(grep -hE '^[[:space:]]*ExecStart=.+' "${EFFECTIVE_LEGACY_FILES[@]}" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"

  log "Legacy service details: User='${LEGACY_USER:-root}', WorkDir='${LEGACY_WORKDIR:-unknown}'"

  # Determine pre-migration enabled and active states
  if systemd_active; then
    if systemctl is-enabled "${ACTUAL_LEGACY_UNIT_NAME}" >/dev/null 2>&1; then
      WAS_ENABLED=true
    fi
    ACTIVE_STATE="$(systemctl is-active "${ACTUAL_LEGACY_UNIT_NAME}" 2>/dev/null || echo "inactive")"
    if [[ "${ACTIVE_STATE}" == "active" || "${ACTIVE_STATE}" == "activating" ]]; then
      WAS_ACTIVE=true
    fi
  else
    for wlink in "${SYSTEMD_DIR}"/*.target.wants/"${ACTUAL_LEGACY_UNIT_NAME}"; do
      if [[ -L "${wlink}" || -e "${wlink}" ]]; then
        WAS_ENABLED=true
        break
      fi
    done
  fi

  log "Legacy service state: enabled=${WAS_ENABLED}, active=${WAS_ACTIVE} (${ACTIVE_STATE})"
fi

# ==============================================================================
# RESOLVE KIOSK_SESSION_ID SAFELY
# ==============================================================================
RESOLVED_SESSION_ID="${SESSION_ID}"

# 1. Check existing environment file
if [[ -z "${RESOLVED_SESSION_ID}" && -f "${ENV_FILE}" ]]; then
  RESOLVED_SESSION_ID="$(grep -E '^KIOSK_SESSION_ID=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- | tr -d '"'\''[:space:]' || true)"
fi

# 2. Check legacy unit + drop-ins Environment= declarations
if [[ -z "${RESOLVED_SESSION_ID}" && "${#EFFECTIVE_LEGACY_FILES[@]}" -gt 0 ]]; then
  env_match="$(grep -hE '^[[:space:]]*Environment=' "${EFFECTIVE_LEGACY_FILES[@]}" 2>/dev/null | grep -oE 'KIOSK_SESSION_ID=[^ "'\'']+' | tail -n1 | cut -d= -f2- || true)"
  if [[ -n "${env_match}" ]]; then
    RESOLVED_SESSION_ID="${env_match}"
  fi
fi

# 3. Check legacy unit + drop-ins EnvironmentFile= declarations
if [[ -z "${RESOLVED_SESSION_ID}" && "${#EFFECTIVE_LEGACY_FILES[@]}" -gt 0 ]]; then
  while IFS= read -r env_file_decl; do
    [[ -z "${env_file_decl}" ]] && continue
    clean_ef="$(echo "${env_file_decl}" | cut -d= -f2- | sed -E 's/^[[:space:]]*-?//; s/[[:space:]"'\'']//g')"
    [[ -z "${clean_ef}" ]] && continue
    if [[ -n "${ROOT_DIR}" && "${clean_ef}" == /* && "${clean_ef}" != "${ROOT_DIR}"/* && -f "${ROOT_DIR}${clean_ef}" ]]; then
      clean_ef="${ROOT_DIR}${clean_ef}"
    fi
    if [[ -r "${clean_ef}" ]]; then
      ef_sid="$(grep -E '^[[:space:]]*KIOSK_SESSION_ID=' "${clean_ef}" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"'\''[:space:]' || true)"
      if [[ -n "${ef_sid}" ]]; then
        RESOLVED_SESSION_ID="${ef_sid}"
      fi
    fi
  done < <(grep -hE '^[[:space:]]*EnvironmentFile=.+' "${EFFECTIVE_LEGACY_FILES[@]}" 2>/dev/null || true)
fi

# 4. Check legacy ExecStart arguments
if [[ -z "${RESOLVED_SESSION_ID}" && -n "${ACTUAL_LEGACY_UNIT_PATH}" && -n "${LEGACY_EXECSTART}" ]]; then
  clean_exec="$(echo "${LEGACY_EXECSTART}" | sed -E 's/["'\'']//g')"
  extracted=""
  after_index=false
  for token in ${clean_exec}; do
    if [[ "${after_index}" == "true" ]]; then
      if [[ ! "${token}" =~ ^-- ]] && [[ "${token}" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        extracted="${token}"
        break
      fi
    fi
    if [[ "${token}" =~ index\.js$ ]]; then
      after_index=true
    fi
  done

  if [[ -z "${extracted}" ]]; then
    for token in ${clean_exec}; do
      if [[ ! "${token}" =~ ^-- ]] && [[ ! "${token}" =~ (node|npm|sudo|bash|sh)$ ]] && [[ "${token}" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        extracted="${token}"
      fi
    done
  fi

  if [[ -n "${extracted}" ]]; then
    RESOLVED_SESSION_ID="${extracted}"
  fi
fi

# Validate session ID resolution before making ANY system modifications
if [[ -n "${RESOLVED_SESSION_ID}" ]]; then
  log "Kiosk Session ID configured (fingerprint: $(mask_token "${RESOLVED_SESSION_ID}"))."
else
  if [[ -n "${ACTUAL_LEGACY_UNIT_PATH}" || "${START_SERVICE}" == "true" ]]; then
    fatal "Could not unambiguously determine KIOSK_SESSION_ID. Aborting before modifying system or stopping legacy service. Run with: --session-id <YOUR_SESSION_ID>"
  else
    warn "No KIOSK_SESSION_ID specified. The daemon will require KIOSK_SESSION_ID in ${ENV_FILE} before starting."
  fi
fi

# Resolve legacy workdir path for config check
RESOLVED_LEGACY_WORKDIR="${LEGACY_WORKDIR}"
if [[ -n "${ROOT_DIR}" && -n "${LEGACY_WORKDIR}" && "${LEGACY_WORKDIR}" == /* && "${LEGACY_WORKDIR}" != "${ROOT_DIR}"/* ]]; then
  RESOLVED_LEGACY_WORKDIR="${ROOT_DIR}${LEGACY_WORKDIR}"
fi

# Preflight config gate when --start is requested: ensure a valid printer config exists before stopping legacy service
if [[ "${START_SERVICE}" == "true" ]]; then
  CANDIDATE_CFG=""
  if [[ -f "${CONFIG_FILE}" ]]; then
    CANDIDATE_CFG="${CONFIG_FILE}"
  elif [[ -n "${RESOLVED_LEGACY_WORKDIR}" && -f "${RESOLVED_LEGACY_WORKDIR}/config.json" ]]; then
    CANDIDATE_CFG="${RESOLVED_LEGACY_WORKDIR}/config.json"
  fi

  if [[ -z "${CANDIDATE_CFG}" ]]; then
    fatal "Cannot start printellect.service: no printer configuration found at ${CONFIG_FILE} or legacy workdir. Run 'sudo printellect-setup' first. Aborting without stopping legacy service."
  fi

  if command -v node >/dev/null 2>&1; then
    if ! node -e 'const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!cfg || (!cfg.bwPrinter && !cfg.colorPrinter)) process.exit(1);' "${CANDIDATE_CFG}" >/dev/null 2>&1; then
      fatal "Printer configuration at ${CANDIDATE_CFG} is malformed or defines neither bwPrinter nor colorPrinter. Aborting without stopping legacy service."
    fi
  fi
fi

if [[ "${PREFLIGHT_ONLY}" == "true" ]]; then
  echo ""
  echo "=========================================================="
  echo "   PREFLIGHT VALIDATION COMPLETED                         "
  echo "=========================================================="
  log "Prerequisites, release paths, and template unit verified."
  if [[ -n "${ACTUAL_LEGACY_UNIT_PATH}" ]]; then
    log "Legacy migration candidate verified: ${ACTUAL_LEGACY_UNIT_NAME} (vendor=${LEGACY_IS_VENDOR}, symlink=${LEGACY_IS_SYMLINK})"
  fi
  log "No system modifications were made."
  exit 0
fi

# ==============================================================================
# INSTALLATION & STAGED NON-ATOMIC MIGRATION EXECUTION
# ==============================================================================

# 1. Create service user and group
log "Ensuring dedicated service account '${SERVICE_USER}' exists..."
if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY RUN] Would verify/create system user '${SERVICE_USER}' with group '${CUPS_GROUP}'"
else
  if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
    if command -v groupadd >/dev/null 2>&1; then
      groupadd -r "${SERVICE_GROUP}" || true
    fi
  fi

  if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
      useradd -r -s /usr/sbin/nologin -d /var/lib/printellect -g "${SERVICE_GROUP}" -c "PRINTELLECT Kiosk Service" "${SERVICE_USER}" || true
    fi
  fi

  if getent group "${CUPS_GROUP}" >/dev/null 2>&1; then
    if command -v usermod >/dev/null 2>&1; then
      usermod -a -G "${CUPS_GROUP}" "${SERVICE_USER}" || true
      log "Added '${SERVICE_USER}' to group '${CUPS_GROUP}' for CUPS access."
    fi
  fi
fi

# 2. Provision Directory Hierarchy with Minimal Permissions
log "Setting up directory permissions..."
if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY RUN] Would provision ${BASE_DIR} (0755 root), ${CONFIG_DIR} (0750 ${SERVICE_USER}), ${ENV_DIR} (0750 root:${SERVICE_GROUP}), ${BACKUP_DIR} (0700)"
else
  mkdir -p "${BASE_DIR}" "${CONFIG_DIR}" "${BACKUP_DIR}" "${ENV_DIR}" "${SYSTEMD_DIR}"

  chown -R root:root "${BASE_DIR}" >/dev/null 2>&1 || true
  chmod 0755 "${BASE_DIR}"

  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${CONFIG_DIR}" >/dev/null 2>&1 || true
  chmod 0750 "${CONFIG_DIR}"

  chown root:"${SERVICE_GROUP}" "${ENV_DIR}" >/dev/null 2>&1 || true
  chmod 0750 "${ENV_DIR}"
  chown root:root "${BACKUP_DIR}" >/dev/null 2>&1 || true
  chmod 0700 "${BACKUP_DIR}"
fi

# 3. Create or Update Environment File Atomically (umask 077, printf-safe, no symlink follow)
if [[ -n "${RESOLVED_SESSION_ID}" ]] && [[ ! "${RESOLVED_SESSION_ID}" =~ ^[A-Za-z0-9_.:@-]{1,128}$ ]]; then
  fatal "Invalid characters in Kiosk Session ID (only [A-Za-z0-9_.:@-] up to 128 chars allowed)."
fi
log "Writing environment configuration to ${ENV_FILE}..."
if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY RUN] Would write ${ENV_FILE} with KIOSK_SESSION_ID fingerprint $(mask_token "${RESOLVED_SESSION_ID}")"
else
  ENV_TMP="${ENV_FILE}.tmp.$$"
  (
    umask 077
    printf '# PRINTELLECT Kiosk Production Environment\n# Managed by install-service.sh — Do not commit to source control\nKIOSK_SESSION_ID="%s"\nPRINTELLECT_CONFIG_PATH="%s"\nNODE_ENV="production"\n' \
      "${RESOLVED_SESSION_ID}" "${CONFIG_FILE}" > "${ENV_TMP}"
  )
  chown root:"${SERVICE_GROUP}" "${ENV_TMP}" >/dev/null 2>&1 || true
  chmod 0640 "${ENV_TMP}"
  mv -f "${ENV_TMP}" "${ENV_FILE}"
fi

# 4. Migrate Existing Printer Configuration if Target Missing (never delete legacy source)
if [[ ! -f "${CONFIG_FILE}" && -n "${RESOLVED_LEGACY_WORKDIR}" && -f "${RESOLVED_LEGACY_WORKDIR}/config.json" ]]; then
  log "Migrating legacy printer configuration from ${RESOLVED_LEGACY_WORKDIR}/config.json..."
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[DRY RUN] Would copy ${RESOLVED_LEGACY_WORKDIR}/config.json -> ${CONFIG_FILE}"
  else
    atomic_install_file "${RESOLVED_LEGACY_WORKDIR}/config.json" "${CONFIG_FILE}" 0644
    chown "${SERVICE_USER}:${SERVICE_GROUP}" "${CONFIG_FILE}" >/dev/null 2>&1 || true
    log "Preserved and migrated existing printer configuration."
  fi
elif [[ -f "${CONFIG_FILE}" ]]; then
  log "Existing persistent configuration preserved at ${CONFIG_FILE}."
fi

# ==============================================================================
# 5. WRITE-AHEAD PERSISTENT BACKUP & CHECKPOINT (BEFORE STOPPING LEGACY SERVICE)
# ==============================================================================
CUTOVER_IN_FLIGHT=false
ROLLBACK_ALREADY_TRIGGERED=false

on_cutover_interrupt() {
  local exit_code=$?
  trap - ERR INT TERM
  if [[ "${CUTOVER_IN_FLIGHT}" == "true" && "${ROLLBACK_ALREADY_TRIGGERED}" != "true" ]]; then
    ROLLBACK_ALREADY_TRIGGERED=true
    warn "Cutover interrupted or command failed (exit=${exit_code})! Initiating automatic rollback from persistent checkpoint..."
    if [[ -n "${ACTUAL_LEGACY_UNIT_NAME}" ]]; then
      perform_rollback_from_metadata "cutover_interrupted_or_command_failed" || true
    fi
  fi
  exit "${exit_code}"
}

ETC_DROPIN_BACKUP=""
VENDOR_DROPIN_BACKUP=""
legacy_backup=""

if [[ -n "${ACTUAL_LEGACY_UNIT_PATH}" ]]; then
  timestamp="$(date -u +"%Y%m%d%H%M%S")"
  legacy_backup="${BACKUP_DIR}/${ACTUAL_LEGACY_UNIT_NAME}.bak.${timestamp}"

  if [[ -n "${LEGACY_ETC_DROPIN_DIR}" && -d "${LEGACY_ETC_DROPIN_DIR}" ]]; then
    ETC_DROPIN_BACKUP="${BACKUP_DIR}/${ACTUAL_LEGACY_UNIT_NAME}.d.bak.${timestamp}"
  fi
  if [[ "${#LEGACY_VENDOR_DROPIN_DIRS[@]}" -gt 0 ]]; then
    VENDOR_DROPIN_BACKUP="${BACKUP_DIR}/${ACTUAL_LEGACY_UNIT_NAME}.vendor.d.bak.${timestamp}"
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[DRY RUN] Would create verified backup ${ACTUAL_LEGACY_READ_PATH} -> ${legacy_backup}"
    [[ -n "${ETC_DROPIN_BACKUP}" ]] && log "[DRY RUN] Would backup /etc drop-ins ${LEGACY_ETC_DROPIN_DIR} -> ${ETC_DROPIN_BACKUP}"
    [[ -n "${VENDOR_DROPIN_BACKUP}" ]] && log "[DRY RUN] Would archive vendor drop-ins (read-only) -> ${VENDOR_DROPIN_BACKUP}"
    log "[DRY RUN] Would commit write-ahead checkpoint to ${MIGRATION_META} before stopping ${ACTUAL_LEGACY_UNIT_NAME}"
    if [[ "${WAS_ACTIVE}" == "true" ]]; then log "[DRY RUN] Would stop ${ACTUAL_LEGACY_UNIT_NAME}"; fi
    if [[ "${WAS_ENABLED}" == "true" ]]; then log "[DRY RUN] Would disable ${ACTUAL_LEGACY_UNIT_NAME}"; fi
  else
    log "Creating persistent backup of legacy unit: ${legacy_backup}..."
    cp -L "${ACTUAL_LEGACY_READ_PATH}" "${legacy_backup}" \
      || fatal "Failed to copy legacy unit to ${legacy_backup}. Aborting without stopping legacy service."
    chmod 0600 "${legacy_backup}"

    # Verify backup integrity byte-for-byte before touching running legacy service
    if [[ ! -s "${legacy_backup}" ]] || ! cmp -s "${ACTUAL_LEGACY_READ_PATH}" "${legacy_backup}"; then
      rm -f "${legacy_backup}"
      fatal "Backup verification failed for ${legacy_backup}. Aborting without stopping legacy service."
    fi

    BACKUP_SHA256=""
    if command -v sha256sum >/dev/null 2>&1; then
      BACKUP_SHA256="$(sha256sum "${legacy_backup}" | awk '{print $1}')"
    fi

    if [[ -n "${ETC_DROPIN_BACKUP}" ]]; then
      log "Creating persistent backup of /etc drop-in directory: ${ETC_DROPIN_BACKUP}..."
      mkdir -p "${ETC_DROPIN_BACKUP}"
      for df in "${LEGACY_ETC_DROPIN_DIR}"/*; do
        [[ ! -e "${df}" ]] && continue
        cp -L "${df}" "${ETC_DROPIN_BACKUP}/$(basename "${df}")" \
          || fatal "Failed to back up drop-in file ${df}. Aborting without stopping legacy service."
        if ! cmp -s "${df}" "${ETC_DROPIN_BACKUP}/$(basename "${df}")"; then
          fatal "Drop-in backup verification failed for ${df}. Aborting without stopping legacy service."
        fi
      done
    fi

    if [[ -n "${VENDOR_DROPIN_BACKUP}" ]]; then
      log "Archiving read-only snapshot of vendor drop-in directory: ${VENDOR_DROPIN_BACKUP}..."
      mkdir -p "${VENDOR_DROPIN_BACKUP}"
      for vdd in "${LEGACY_VENDOR_DROPIN_DIRS[@]}"; do
        for vdf in "${vdd}"/*; do
          [[ ! -e "${vdf}" ]] && continue
          cp -L "${vdf}" "${VENDOR_DROPIN_BACKUP}/$(basename "${vdf}")" || true
        done
      done
    fi

    # Write-ahead migration checkpoint atomically BEFORE stopping or disabling legacy unit
    META_TMP="${MIGRATION_META}.tmp.$$"
    STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    if command -v node >/dev/null 2>&1; then
      node -e '
        const fs = require("fs");
        const payload = {
          schemaVersion: 2,
          legacyUnitName: process.argv[2],
          legacyUnitPath: process.argv[3],
          legacyUnitRealPath: process.argv[4],
          legacyUnitIsVendor: process.argv[5] === "true",
          legacyUnitIsSymlink: process.argv[6] === "true",
          legacySymlinkTarget: process.argv[7],
          unitBackup: process.argv[8],
          unitBackupSha256: process.argv[9],
          dropinDir: process.argv[10],
          dropinBackup: process.argv[11],
          etcDropinDir: process.argv[10],
          etcDropinBackup: process.argv[11],
          vendorDropinBackup: process.argv[12],
          wasEnabled: process.argv[13] === "true",
          wasActive: process.argv[14] === "true",
          activeState: process.argv[15],
          legacyUser: process.argv[16],
          legacyWorkDir: process.argv[17],
          targetUnitName: "printellect.service",
          targetUnitPath: process.argv[18],
          migratedAt: process.argv[19],
          updatedAt: process.argv[19],
          checkpointPhase: "checkpoint_saved",
          status: "in_progress"
        };
        fs.writeFileSync(process.argv[1], JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
      ' "${META_TMP}" \
        "${ACTUAL_LEGACY_UNIT_NAME}" \
        "${ACTUAL_LEGACY_UNIT_PATH}" \
        "${ACTUAL_LEGACY_READ_PATH}" \
        "${LEGACY_IS_VENDOR}" \
        "${LEGACY_IS_SYMLINK}" \
        "${LEGACY_SYMLINK_TARGET}" \
        "${legacy_backup}" \
        "${BACKUP_SHA256}" \
        "${LEGACY_ETC_DROPIN_DIR}" \
        "${ETC_DROPIN_BACKUP}" \
        "${VENDOR_DROPIN_BACKUP}" \
        "${WAS_ENABLED}" \
        "${WAS_ACTIVE}" \
        "${ACTIVE_STATE}" \
        "${LEGACY_USER}" \
        "${LEGACY_WORKDIR}" \
        "${TARGET_UNIT_FILE}" \
        "${STARTED_AT}"
    else
      cat > "${META_TMP}" <<EOF
{
  "schemaVersion": 2,
  "legacyUnitName": "${ACTUAL_LEGACY_UNIT_NAME}",
  "legacyUnitPath": "${ACTUAL_LEGACY_UNIT_PATH}",
  "legacyUnitRealPath": "${ACTUAL_LEGACY_READ_PATH}",
  "legacyUnitIsVendor": ${LEGACY_IS_VENDOR},
  "legacyUnitIsSymlink": ${LEGACY_IS_SYMLINK},
  "legacySymlinkTarget": "${LEGACY_SYMLINK_TARGET}",
  "unitBackup": "${legacy_backup}",
  "unitBackupSha256": "${BACKUP_SHA256}",
  "dropinDir": "${LEGACY_ETC_DROPIN_DIR}",
  "dropinBackup": "${ETC_DROPIN_BACKUP}",
  "etcDropinDir": "${LEGACY_ETC_DROPIN_DIR}",
  "etcDropinBackup": "${ETC_DROPIN_BACKUP}",
  "vendorDropinBackup": "${VENDOR_DROPIN_BACKUP}",
  "wasEnabled": ${WAS_ENABLED},
  "wasActive": ${WAS_ACTIVE},
  "activeState": "${ACTIVE_STATE}",
  "legacyUser": "${LEGACY_USER}",
  "legacyWorkDir": "${LEGACY_WORKDIR}",
  "targetUnitName": "printellect.service",
  "targetUnitPath": "${TARGET_UNIT_FILE}",
  "migratedAt": "${STARTED_AT}",
  "updatedAt": "${STARTED_AT}",
  "checkpointPhase": "checkpoint_saved",
  "status": "in_progress"
}
EOF
    fi
    chmod 0600 "${META_TMP}"
    mv -f "${META_TMP}" "${MIGRATION_META}"
    flush_disk

    if [[ ! -s "${MIGRATION_META}" ]]; then
      fatal "Failed to persist migration checkpoint at ${MIGRATION_META}. Aborting without stopping legacy service."
    fi
    log "Write-ahead checkpoint committed to ${MIGRATION_META} (phase=checkpoint_saved)."

    # Acquire exclusive lock and arm boot power-loss recovery unit BEFORE stopping or disabling legacy unit
    acquire_migration_lock
    arm_boot_recovery_unit "${ACTUAL_LEGACY_UNIT_NAME}" "${TEMPLATE_RECOVER_UNIT}"

    if [[ "${PRINTELLECT_TEST_SYSTEMD:-0}" == "1" && -n "${ROOT_DIR}" && "${PRINTELLECT_TEST_CRASH_AT_PHASE:-}" == "checkpoint_saved" ]]; then
      echo "[TEST CRASH] Simulating sudden power loss at checkpointPhase=checkpoint_saved" >&2
      trap - ERR INT TERM
      exit 137
    fi

    # Arm cutover trap before mutating live service lifecycle
    CUTOVER_IN_FLIGHT=true
    trap on_cutover_interrupt ERR INT TERM

    # Failure Point 1 Transition: Stop legacy service
    if systemd_active; then
      if [[ "${WAS_ACTIVE}" == "true" ]]; then
        log "Stopping legacy service: ${ACTUAL_LEGACY_UNIT_NAME}..."
        systemctl stop "${ACTUAL_LEGACY_UNIT_NAME}"
        update_migration_checkpoint "in_progress" "legacy_stopped"
        log "Stopped legacy service: ${ACTUAL_LEGACY_UNIT_NAME} (phase=legacy_stopped)."
      fi

      # Failure Point 2 Transition: Disable legacy service
      if [[ "${WAS_ENABLED}" == "true" ]]; then
        log "Disabling legacy service: ${ACTUAL_LEGACY_UNIT_NAME}..."
        systemctl disable "${ACTUAL_LEGACY_UNIT_NAME}"
        update_migration_checkpoint "in_progress" "legacy_disabled"
        log "Disabled legacy service: ${ACTUAL_LEGACY_UNIT_NAME} (phase=legacy_disabled)."
      fi
    fi
  fi
fi

# ==============================================================================
# 6. INSTALL NEW SYSTEMD UNIT FILE ATOMICALLY (NEVER WRITE THROUGH SYMLINKS)
# ==============================================================================
log "Installing unit file to ${TARGET_UNIT_FILE}..."
if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY RUN] Would atomically install ${TEMPLATE_UNIT} -> ${TARGET_UNIT_FILE}"
  if [[ -n "${RUNTIME_OVERRIDE_BIN}" && "$(strip_root_prefix "${RUNTIME_OVERRIDE_BIN}")" != "/usr/bin/node" ]]; then
    log "[DRY RUN] Would write runtime override drop-in ${TARGET_RUNTIME_DROPIN_FILE} for ${RUNTIME_OVERRIDE_BIN}"
  fi
else
  atomic_install_file "${TEMPLATE_UNIT}" "${TARGET_UNIT_FILE}" 0644
  chown root:root "${TARGET_UNIT_FILE}" >/dev/null 2>&1 || true

  # Configure custom/staged Node.js runtime override drop-in if requested or auto-detected
  EFFECTIVE_DROPIN_NODE="${RUNTIME_OVERRIDE_BIN}"
  if [[ -n "${EFFECTIVE_DROPIN_NODE}" ]]; then
    logical_exec_node="$(strip_root_prefix "${EFFECTIVE_DROPIN_NODE}")"
    if [[ "${logical_exec_node}" != "/usr/bin/node" ]]; then
      mkdir -p "${TARGET_RUNTIME_DROPIN_DIR}"
      DROPIN_TMP="${TARGET_RUNTIME_DROPIN_FILE}.tmp.$$"
      cat > "${DROPIN_TMP}" <<EOF
# Managed by install-service.sh (versioned runtime override)
[Service]
ExecStart=
ExecStart=${logical_exec_node} /opt/printellect/current/index.js
EOF
      chmod 0644 "${DROPIN_TMP}"
      mv -f "${DROPIN_TMP}" "${TARGET_RUNTIME_DROPIN_FILE}"
      log "Configured versioned Node.js runtime drop-in: ${TARGET_RUNTIME_DROPIN_FILE} -> ${logical_exec_node}"
    fi
  elif [[ -f "${TARGET_RUNTIME_DROPIN_FILE}" ]]; then
    rm -f "${TARGET_RUNTIME_DROPIN_FILE}"
    rmdir "${TARGET_RUNTIME_DROPIN_DIR}" 2>/dev/null || true
  fi

  # Failure Point 3 Checkpoint: New unit installed on disk
  if [[ -n "${ACTUAL_LEGACY_UNIT_PATH}" ]]; then
    update_migration_checkpoint "in_progress" "new_unit_installed"
  fi
fi

# ==============================================================================
# 7. RELOAD SYSTEMD, ENABLE, START & EXPLICIT HEALTH-CHECK GATE
# ==============================================================================
if [[ "${DRY_RUN}" != "true" ]] && systemd_active; then
  log "Reloading systemd daemon..."
  systemctl daemon-reload
  if [[ -n "${ACTUAL_LEGACY_UNIT_PATH}" ]]; then
    update_migration_checkpoint "in_progress" "daemon_reloaded"
  fi

  # Failure Point 4 Transition: Enable new service
  if [[ "${ENABLE_SERVICE}" == "true" ]]; then
    log "Enabling printellect.service on boot..."
    systemctl enable printellect.service
    if [[ -n "${ACTUAL_LEGACY_UNIT_PATH}" ]]; then
      update_migration_checkpoint "in_progress" "new_service_enabled"
    fi
  fi

  # Failure Point 5 Transition: Start new service & enforce multi-criteria health gate
  if [[ "${START_SERVICE}" == "true" ]]; then
    PRE_START_ACTIVE="$(systemctl is-active printellect.service 2>/dev/null || echo "inactive")"
    PRE_START_PID=""
    if [[ "${PRE_START_ACTIVE}" == "active" ]]; then
      PRE_START_PID="$(systemctl show printellect.service -p MainPID 2>/dev/null | grep '^MainPID=' | cut -d= -f2- || true)"
    fi

    START_EPOCH="$(date -u +"%Y-%m-%d %H:%M:%S")"
    if [[ "${PRE_START_ACTIVE}" == "active" ]]; then
      log "Restarting already-active printellect.service to activate updated unit/release..."
      systemctl restart printellect.service
    else
      log "Starting printellect.service..."
      systemctl start printellect.service
    fi
    if [[ -n "${ACTUAL_LEGACY_UNIT_PATH}" ]]; then
      update_migration_checkpoint "in_progress" "new_service_started"
    fi

    log "Executing explicit post-start health-check gate (timeout=${HEALTH_TIMEOUT}s, stability_hold=${HEALTH_STABLE_SEC}s)..."
    IS_HEALTHY=false
    FAILURE_REASON=""
    READY_MAIN_PID=""

    for ((elapsed=1; elapsed<=HEALTH_TIMEOUT; elapsed++)); do
      sleep 1

      # Query structured systemd unit properties (catches Type=simple crash-loops & auto-restarts)
      show_out="$(systemctl show printellect.service -p ActiveState -p SubState -p MainPID -p NRestarts -p Result -p ExecMainStatus 2>/dev/null || true)"
      active_state="$(echo "${show_out}" | grep '^ActiveState=' | cut -d= -f2- || true)"
      sub_state="$(echo "${show_out}" | grep '^SubState=' | cut -d= -f2- || true)"
      main_pid="$(echo "${show_out}" | grep '^MainPID=' | cut -d= -f2- || echo "0")"
      n_restarts="$(echo "${show_out}" | grep '^NRestarts=' | cut -d= -f2- || echo "0")"
      unit_result="$(echo "${show_out}" | grep '^Result=' | cut -d= -f2- || true)"

      if [[ -z "${active_state}" ]]; then
        active_state="$(systemctl is-active printellect.service 2>/dev/null || echo "inactive")"
      fi

      # Fail immediately on crash-loop restart or failed state
      if [[ "${n_restarts}" =~ ^[0-9]+$ ]] && [[ "${n_restarts}" -gt 0 ]]; then
        FAILURE_REASON="service entered crash/restart loop (NRestarts=${n_restarts})"
        break
      fi
      if [[ "${active_state}" == "failed" || "${active_state}" == "inactive" || "${active_state}" == "deactivating" ]]; then
        FAILURE_REASON="service entered '${active_state}' state (Result=${unit_result:-unknown})"
        break
      fi

      if [[ "${active_state}" == "active" && ( -z "${sub_state}" || "${sub_state}" == "running" ) ]]; then
        # Reject stale MainPID from a previous service instance
        if [[ -n "${PRE_START_PID}" && "${PRE_START_PID}" != "0" && "${main_pid}" == "${PRE_START_PID}" ]]; then
          FAILURE_REASON="stale MainPID (${main_pid}) unchanged from previous service instance"
          continue
        fi

        # On a real Linux host, verify MainPID is executing inside /opt/printellect and expected Node runtime
        if [[ -z "${ROOT_DIR}" && -n "${main_pid}" && "${main_pid}" != "0" && -d "/proc/${main_pid}" ]]; then
          if [[ -L "/proc/${main_pid}/cwd" ]]; then
            proc_cwd="$(readlink -f "/proc/${main_pid}/cwd" 2>/dev/null || true)"
            expected_cwd="$(readlink -f "/opt/printellect/current" 2>/dev/null || echo "/opt/printellect/current")"
            if [[ -n "${proc_cwd}" && "${proc_cwd}" != "${expected_cwd}" ]]; then
              FAILURE_REASON="MainPID ${main_pid} working directory '${proc_cwd}' does not match release '${expected_cwd}'"
              break
            fi
          fi
          if [[ -L "/proc/${main_pid}/exe" ]]; then
            proc_exe="$(readlink -f "/proc/${main_pid}/exe" 2>/dev/null || true)"
            expected_exe="$(readlink -f "${RUNTIME_OVERRIDE_BIN:-/usr/bin/node}" 2>/dev/null || true)"
            if [[ -n "${proc_exe}" && -n "${expected_exe}" && "${proc_exe}" != "${expected_exe}" ]]; then
              FAILURE_REASON="MainPID ${main_pid} executable '${proc_exe}' does not match expected Node runtime '${expected_exe}'"
              break
            fi
          fi
        fi

        # Inspect journal logs strictly scoped to the new MainPID so a previous service run CANNOT satisfy readiness
        if command -v journalctl >/dev/null 2>&1; then
          journal_slice=""
          if [[ "${main_pid}" =~ ^[1-9][0-9]*$ ]]; then
            journal_slice="$(journalctl -u printellect.service "_PID=${main_pid}" --no-pager 2>/dev/null || true)"
          elif [[ -z "${show_out}" ]]; then
            # Only used if systemctl show is completely unavailable
            journal_slice="$(journalctl -u printellect.service --since "${START_EPOCH}" -n 60 --no-pager 2>/dev/null || true)"
          fi

          if echo "${journal_slice}" | grep -qE '(\[FATAL ERROR\]|\[FATAL CONFIG ERROR\]|Firebase Auth Error:|Firestore Listener Error:|ERR_DLOPEN_FAILED|ERR_MODULE_NOT_FOUND|SyntaxError:)'; then
            FAILURE_REASON="fatal daemon error detected in journald output"
            break
          fi

          if echo "${journal_slice}" | grep -q 'Connected to Firebase\.' && \
             echo "${journal_slice}" | grep -q 'Listening for print jobs'; then
            READY_MAIN_PID="${main_pid}"
            FAILURE_REASON=""
            IS_HEALTHY=true
            break
          fi
        else
          # Fallback only if journalctl binary does not exist on minimal container
          READY_MAIN_PID="${main_pid}"
          FAILURE_REASON=""
          IS_HEALTHY=true
          break
        fi
      fi
    done

    # Post-readiness stabilization hold: verify MainPID stays alive with NRestarts=0
    if [[ "${IS_HEALTHY}" == "true" && "${HEALTH_STABLE_SEC}" -gt 0 ]]; then
      log "Readiness markers observed (MainPID=${READY_MAIN_PID:-unknown}); verifying ${HEALTH_STABLE_SEC}s stability hold..."
      for ((hold=1; hold<=HEALTH_STABLE_SEC; hold++)); do
        sleep 1
        hold_out="$(systemctl show printellect.service -p ActiveState -p SubState -p MainPID -p NRestarts 2>/dev/null || true)"
        hold_active="$(echo "${hold_out}" | grep '^ActiveState=' | cut -d= -f2- || systemctl is-active printellect.service 2>/dev/null || echo "inactive")"
        hold_pid="$(echo "${hold_out}" | grep '^MainPID=' | cut -d= -f2- || echo "0")"
        hold_restarts="$(echo "${hold_out}" | grep '^NRestarts=' | cut -d= -f2- || echo "0")"

        if [[ "${hold_active}" != "active" ]]; then
          IS_HEALTHY=false
          FAILURE_REASON="service dropped out of active state during stability hold (${hold_active})"
          break
        fi
        if [[ "${hold_restarts}" =~ ^[0-9]+$ ]] && [[ "${hold_restarts}" -gt 0 ]]; then
          IS_HEALTHY=false
          FAILURE_REASON="service restarted during stability hold (NRestarts=${hold_restarts})"
          break
        fi
        if [[ -n "${READY_MAIN_PID}" && "${READY_MAIN_PID}" != "0" && -n "${hold_pid}" && "${hold_pid}" != "0" && "${hold_pid}" != "${READY_MAIN_PID}" ]]; then
          IS_HEALTHY=false
          FAILURE_REASON="MainPID changed during stability hold (${READY_MAIN_PID} -> ${hold_pid})"
          break
        fi
      done
    fi

    if [[ "${IS_HEALTHY}" != "true" ]]; then
      CUTOVER_IN_FLIGHT=false
      ROLLBACK_ALREADY_TRIGGERED=true
      trap - ERR INT TERM

      warn "printellect.service failed post-start health-check gate (${FAILURE_REASON:-timed out waiting for Firebase/listener readiness within ${HEALTH_TIMEOUT}s})."
      if command -v journalctl >/dev/null 2>&1; then
        warn "Recent journald logs for printellect.service (redacted):"
        (journalctl -u printellect.service -n 30 --no-pager 2>/dev/null || true) | redact_sensitive_stream >&2 || true
      fi

      if [[ -n "${ACTUAL_LEGACY_UNIT_NAME}" ]]; then
        warn "Initiating automatic emergency rollback to restore legacy service ${ACTUAL_LEGACY_UNIT_NAME}..."
        perform_rollback_from_metadata "post_start_health_check_failed: ${FAILURE_REASON:-readiness_timeout}" || true
      else
        systemctl stop printellect.service >/dev/null 2>&1 || true
      fi
      fatal "Migration aborted: printellect.service failed the post-start health-check gate."
    fi

    # Health-check gate passed! Disarm trap, commit final 'completed' status, and disarm boot recovery hook
    CUTOVER_IN_FLIGHT=false
    trap - ERR INT TERM
    if [[ -n "${ACTUAL_LEGACY_UNIT_PATH}" ]]; then
      update_migration_checkpoint "completed" "health_check_passed"
      disarm_boot_recovery_unit
    fi
    log "Health-check gate PASSED: printellect.service is active, connected to Firebase, and listening for jobs."
  else
    # Service was staged/enabled without --start
    CUTOVER_IN_FLIGHT=false
    trap - ERR INT TERM
    if [[ -n "${ACTUAL_LEGACY_UNIT_PATH}" ]]; then
      update_migration_checkpoint "staged_unverified" "awaiting_start_and_health_check"
      if [[ "${ENABLE_SERVICE}" == "true" ]]; then
        disarm_boot_recovery_unit
      fi
      warn "Migration staged without --start: post-start health-check gate has NOT been executed yet."
    fi
  fi
else
  # Dry-run or isolated --root-dir filesystem staging without active systemd
  CUTOVER_IN_FLIGHT=false
  trap - ERR INT TERM
  if [[ "${DRY_RUN}" != "true" && -n "${ACTUAL_LEGACY_UNIT_PATH}" && -f "${MIGRATION_META}" ]]; then
    update_migration_checkpoint "staged_unverified" "filesystem_staged"
    disarm_boot_recovery_unit
  fi
fi

echo ""
echo "=========================================================="
echo "   PRINTELLECT SYSTEMD SERVICE CONFIGURATION COMPLETE     "
echo "=========================================================="
echo "Service Unit       : ${TARGET_UNIT_FILE}"
echo "Node.js Runtime    : $(strip_root_prefix "${RUNTIME_OVERRIDE_BIN:-/usr/bin/node}")"
echo "Service Account    : ${SERVICE_USER} (Group: ${SERVICE_GROUP}, ${CUPS_GROUP})"
echo "Working Directory  : ${CURRENT_LINK}"
echo "Environment File   : ${ENV_FILE} (Mode: 0640)"
echo "Printer Config     : ${CONFIG_FILE}"
echo "Logging Output     : journalctl -u printellect.service -f"
echo "=========================================================="
echo ""
log "Service installation finished successfully."
exit 0
