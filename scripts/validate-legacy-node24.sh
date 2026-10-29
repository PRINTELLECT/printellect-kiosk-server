#!/usr/bin/env bash

# ==============================================================================
# PRINTELLECT Kiosk Server — Gated Legacy Daemon Staged Node.js 24 Validator
#
# Validates that the existing legacy systemd daemon starts, authenticates with
# Firebase, attaches its print-job listener, and shuts down cleanly under a
# staged Node.js 24 executable (/opt/printellect/runtime/current/bin/node)
# BEFORE modifying /usr/bin/node, apt sources, or migrating to printellect.service.
#
# Safety Invariants:
#   1. Never modifies /usr/bin/node, apt repositories, or vendor unit files.
#   2. Never runs two Firebase job listeners simultaneously (uses single-unit
#      systemd restart via temporary drop-in 99-printellect-node24-canary.conf).
#   3. Preserves original User, Group, WorkingDirectory, Environment,
#      EnvironmentFile, KIOSK_SESSION_ID, config.json path, and dependencies.
#   4. Explicitly gated: --run-validation requires --confirm-restart.
#   5. Deterministic restoration on completion, failure, signal, or --restore.
# ==============================================================================

set -euo pipefail

SCRIPT_VERSION="1.0.0"
CANARY_CONF_NAME="99-printellect-node24-canary.conf"

ROOT_DIR=""
LEGACY_UNIT_SPEC="auto"
STAGED_NODE_BIN=""
MODE="preflight"
CONFIRM_RESTART=false
DRY_RUN=false
HEALTH_TIMEOUT=25
STABLE_SEC=5

print_usage() {
  cat <<EOF
PRINTELLECT Kiosk Server — Legacy Daemon Staged Node.js 24 Validator v${SCRIPT_VERSION}

Usage:
  sudo bash validate-legacy-node24.sh [OPTIONS]

Modes:
  --preflight                    Read-only inspection of legacy unit and staged Node 24 (default)
  --dry-run                      Simulate canary drop-in validation and restoration without changes
  --run-validation               Execute live gated validation of legacy service on staged Node 24
                                 (REQUIRES --confirm-restart; automatically restores baseline after check)
  --restore                      Deterministically remove temporary canary drop-in and restore baseline

Options:
  --confirm-restart              Explicit operator gate authorizing controlled legacy service restart
  --legacy-unit <NAME|auto>      Legacy systemd unit name (default: auto)
  --node-bin <PATH>              Staged Node.js >= 24 executable (default: /opt/printellect/runtime/current/bin/node)
  --timeout <SEC>                Max seconds to wait for Firebase & listener readiness (default: ${HEALTH_TIMEOUT})
  --stable-sec <SEC>             Post-readiness stability hold in seconds (default: ${STABLE_SEC})
  --root-dir <PATH>              Prefix filesystem paths for isolated non-root testing
  -h, --help                     Show this help message

Examples:
  sudo bash validate-legacy-node24.sh --preflight
  sudo bash validate-legacy-node24.sh --dry-run --legacy-unit auto
  sudo bash validate-legacy-node24.sh --run-validation --confirm-restart
  sudo bash validate-legacy-node24.sh --restore
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preflight)
      MODE="preflight"
      shift
      ;;
    --dry-run)
      MODE="dry-run"
      DRY_RUN=true
      shift
      ;;
    --run-validation)
      MODE="run"
      shift
      ;;
    --restore)
      MODE="restore"
      shift
      ;;
    --confirm-restart)
      CONFIRM_RESTART=true
      shift
      ;;
    --legacy-unit)
      LEGACY_UNIT_SPEC="$2"
      shift 2
      ;;
    --node-bin)
      STAGED_NODE_BIN="$2"
      shift 2
      ;;
    --timeout)
      HEALTH_TIMEOUT="$2"
      shift 2
      ;;
    --stable-sec)
      STABLE_SEC="$2"
      shift 2
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
  fatal "--timeout must be a positive integer."
fi
if [[ ! "${STABLE_SEC}" =~ ^[0-9]+$ ]]; then
  fatal "--stable-sec must be a non-negative integer."
fi

if [[ "${MODE}" == "run" && "${CONFIRM_RESTART}" != "true" ]]; then
  fatal "--run-validation requires explicit '--confirm-restart' because validating the legacy daemon restarts the single systemd unit to prevent concurrent Firebase listeners."
fi

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

strip_root_prefix() {
  local p="$1"
  if [[ -n "${ROOT_DIR}" && "${p}" == "${ROOT_DIR}"/* ]]; then
    echo "${p#${ROOT_DIR}}"
  else
    echo "${p}"
  fi
}

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

# Mask positional session ID tokens after index.js so secrets never appear in diagnostic logs
mask_execstart_for_log() {
  local raw_exec="$1"
  local out=""
  local after_index=false
  for tok in ${raw_exec}; do
    if [[ "${after_index}" == "true" && ! "${tok}" =~ ^-- ]]; then
      local clean_tok="${tok//\"/}"
      clean_tok="${clean_tok//\'/}"
      out="${out} $(mask_token "${clean_tok}")"
      after_index=false
    else
      out="${out:+${out} }${tok}"
      if [[ "${tok}" =~ index\.js[\"\']?$ ]]; then
        after_index=true
      fi
    fi
  done
  echo "${out}"
}

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
    echo "$(dirname "${link_file}")/${raw_target}"
  fi
}

SYSTEMD_DIR="${ROOT_DIR}/etc/systemd/system"
ENV_DIR="${ROOT_DIR}/etc/printellect"
VALIDATION_META="${ENV_DIR}/legacy-node24-validation.json"
SYSTEM_NODE_PATH="${ROOT_DIR}/usr/bin/node"
[[ -z "${STAGED_NODE_BIN}" ]] && STAGED_NODE_BIN="${ROOT_DIR}/opt/printellect/runtime/current/bin/node"

if [[ "${MODE}" == "run" || "${MODE}" == "restore" ]]; then
  if [[ -z "${ROOT_DIR}" && "$(id -u)" -ne 0 ]]; then
    fatal "Mode '--${MODE}' requires root privileges (use sudo)."
  fi
fi

echo "=========================================================="
echo "   PRINTELLECT — LEGACY DAEMON STAGED NODE 24 VALIDATOR   "
echo "=========================================================="

# ==============================================================================
# STANDALONE --restore MODE
# ==============================================================================
perform_canary_restore() {
  local target_unit="$1"
  local was_active="$2"
  local reason="${3:-manual_restore}"
  local dropin_dir="${SYSTEMD_DIR}/${target_unit}.d"
  local canary_file="${dropin_dir}/${CANARY_CONF_NAME}"

  log "Restoring legacy unit '${target_unit}' to original runtime baseline (reason: ${reason})..."
  if [[ -f "${canary_file}" || -L "${canary_file}" ]]; then
    rm -f "${canary_file}"
    rmdir "${dropin_dir}" 2>/dev/null || true
    log "Removed temporary canary drop-in: ${canary_file}"
  else
    log "No temporary canary drop-in present at ${canary_file}."
  fi

  if systemd_active; then
    systemctl daemon-reload
    systemctl reset-failed "${target_unit}" >/dev/null 2>&1 || true
    if [[ "${was_active}" == "true" ]]; then
      systemctl restart "${target_unit}"
      local st
      st="$(systemctl is-active "${target_unit}" 2>/dev/null || echo "unknown")"
      if [[ "${st}" != "active" ]]; then
        warn "Legacy unit '${target_unit}' reported state '${st}' after baseline restore."
        return 1
      fi
      log "Verified legacy unit '${target_unit}' is active on original runtime baseline."
    else
      systemctl stop "${target_unit}" >/dev/null 2>&1 || true
      log "Legacy unit '${target_unit}' was originally inactive; left stopped."
    fi
  fi

  if [[ -d "${ENV_DIR}" && -f "${VALIDATION_META}" ]]; then
    local now_iso
    now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    local tmp_m="${VALIDATION_META}.tmp.$$"
    sed -E 's/"status"[[:space:]]*:[[:space:]]*"[^"]*"/"status": "'"${reason}"'"/' "${VALIDATION_META}" > "${tmp_m}" 2>/dev/null || cp "${VALIDATION_META}" "${tmp_m}"
    chmod 0600 "${tmp_m}"
    mv -f "${tmp_m}" "${VALIDATION_META}"
  fi
  return 0
}

if [[ "${MODE}" == "restore" ]]; then
  RESTORE_TARGET=""
  RESTORE_WAS_ACTIVE="true"
  if [[ "${LEGACY_UNIT_SPEC}" != "auto" ]]; then
    RESTORE_TARGET="${LEGACY_UNIT_SPEC}"
  elif [[ -f "${VALIDATION_META}" ]]; then
    RESTORE_TARGET="$(grep -E '"legacyUnitName"' "${VALIDATION_META}" | head -n1 | sed -E 's/.*"legacyUnitName"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true)"
    if grep -q '"wasActive"[[:space:]]*:[[:space:]]*false' "${VALIDATION_META}" 2>/dev/null; then
      RESTORE_WAS_ACTIVE="false"
    fi
  fi

  if [[ -z "${RESTORE_TARGET}" ]]; then
    for cf in "${SYSTEMD_DIR}"/*.service.d/"${CANARY_CONF_NAME}"; do
      if [[ -e "${cf}" || -L "${cf}" ]]; then
        RESTORE_TARGET="$(basename "$(dirname "${cf}")" .d)"
        break
      fi
    done
  fi

  if [[ -z "${RESTORE_TARGET}" ]]; then
    log "No active Node 24 canary override found to restore."
    exit 0
  fi

  perform_canary_restore "${RESTORE_TARGET}" "${RESTORE_WAS_ACTIVE}" "restored"
  exit 0
fi

# ==============================================================================
# 1. VERIFY STAGED NODE.JS 24 EXECUTABLE & SYSTEM /usr/bin/node ISOLATION
# ==============================================================================
LOGICAL_STAGED_NODE="$(strip_root_prefix "${STAGED_NODE_BIN}")"
if [[ "${LOGICAL_STAGED_NODE}" == "/usr/bin/node" ]]; then
  fatal "--node-bin must point to a side-by-side staged Node.js 24 executable (e.g. /opt/printellect/runtime/current/bin/node), NOT /usr/bin/node."
fi
if [[ "${LOGICAL_STAGED_NODE}" =~ ^/(home|root)(/|$) ]]; then
  fatal "--node-bin '${STAGED_NODE_BIN}' resides under /home or /root. Stage runtimes under /opt/printellect/runtime/."
fi
if [[ ! -x "${STAGED_NODE_BIN}" ]]; then
  fatal "Staged Node.js 24 executable not found or not executable at: ${STAGED_NODE_BIN}. Run stage-node-runtime.sh first."
fi

STAGED_VER="$("${STAGED_NODE_BIN}" -v || echo "unknown")"
STAGED_MAJOR="$(echo "${STAGED_VER}" | sed -E 's/^v([0-9]+).*/\1/' || echo "0")"
if [[ ! "${STAGED_MAJOR}" =~ ^[0-9]+$ ]] || [[ "${STAGED_MAJOR}" -lt 24 ]]; then
  fatal "Staged runtime at ${STAGED_NODE_BIN} reported '${STAGED_VER}'; Node.js >= 24 LTS is required."
fi
log "Verified staged Node.js 24 runtime: ${STAGED_NODE_BIN} (${STAGED_VER})"

SYS_NODE_BEFORE_DESC="absent"
if [[ -e "${SYSTEM_NODE_PATH}" || -L "${SYSTEM_NODE_PATH}" ]]; then
  SYS_NODE_VER="$("${SYSTEM_NODE_PATH}" -v 2>/dev/null || echo "unrunnable")"
  SYS_NODE_LINK="$(readlink "${SYSTEM_NODE_PATH}" 2>/dev/null || echo "regular_file")"
  SYS_NODE_BEFORE_DESC="${SYS_NODE_VER}:${SYS_NODE_LINK}"
  log "Current /usr/bin/node baseline (will NOT be modified): ${SYS_NODE_VER}"
fi

# ==============================================================================
# 2. DISCOVER LEGACY SERVICE UNIT & EFFECTIVE CONFIGURATION
# ==============================================================================
collect_non_canary_unit_files() {
  local unit_base="$1"
  local read_unit="$2"
  local orig_unit="$3"
  echo "${read_unit}"
  local candidate_dirs=(
    "${ROOT_DIR}/usr/lib/systemd/system/${unit_base}.d"
    "${ROOT_DIR}/lib/systemd/system/${unit_base}.d"
    "${ROOT_DIR}/usr/local/lib/systemd/system/${unit_base}.d"
    "${SYSTEMD_DIR}/${unit_base}.d"
  )
  [[ -n "${orig_unit}" ]] && candidate_dirs+=("${orig_unit}.d")

  local seen_dirs=()
  for d in "${candidate_dirs[@]}"; do
    [[ ! -d "${d}" ]] && continue
    local rp
    rp="$(cd "${d}" 2>/dev/null && pwd -P || echo "${d}")"
    local dup=false
    for s in "${seen_dirs[@]:-}"; do [[ "${s}" == "${rp}" ]] && dup=true && break; done
    [[ "${dup}" == "true" ]] && continue
    seen_dirs+=("${rp}")
    for cf in "${d}"/*.conf; do
      [[ ! -e "${cf}" && ! -L "${cf}" ]] && continue
      [[ "$(basename "${cf}")" == "${CANARY_CONF_NAME}" ]] && continue
      echo "${cf}"
    done
  done
}

FOUND_UNIT_PATH=""
FOUND_READ_PATH=""
FOUND_UNIT_NAME=""

if [[ "${LEGACY_UNIT_SPEC}" != "auto" ]]; then
  CANDIDATES=(
    "${SYSTEMD_DIR}/${LEGACY_UNIT_SPEC}"
    "${ROOT_DIR}/usr/local/lib/systemd/system/${LEGACY_UNIT_SPEC}"
    "${ROOT_DIR}/lib/systemd/system/${LEGACY_UNIT_SPEC}"
    "${ROOT_DIR}/usr/lib/systemd/system/${LEGACY_UNIT_SPEC}"
  )
  for wl in "${SYSTEMD_DIR}"/*.target.wants/"${LEGACY_UNIT_SPEC}"; do
    [[ -e "${wl}" || -L "${wl}" ]] && CANDIDATES+=("${wl}")
  done
  for c in "${CANDIDATES[@]}"; do
    if [[ -L "${c}" || -e "${c}" ]]; then
      FOUND_UNIT_PATH="${c}"
      break
    fi
  done
  [[ -z "${FOUND_UNIT_PATH}" ]] && fatal "Specified legacy unit '${LEGACY_UNIT_SPEC}' not found."
  if [[ -L "${FOUND_UNIT_PATH}" ]]; then
    FOUND_READ_PATH="$(resolve_symlink_target_in_root "${FOUND_UNIT_PATH}")"
    [[ "${FOUND_UNIT_PATH}" == *".target.wants/"* ]] && FOUND_UNIT_PATH="${FOUND_READ_PATH}"
  else
    FOUND_READ_PATH="${FOUND_UNIT_PATH}"
  fi
  FOUND_UNIT_NAME="$(basename "${FOUND_UNIT_PATH}")"
else
  MATCHED=()
  MATCHED_READ=()
  SEEN=()
  SCAN_FILES=()
  for f in "${SYSTEMD_DIR}"/*.service "${SYSTEMD_DIR}"/*.target.wants/*.service \
           "${ROOT_DIR}/usr/local/lib/systemd/system"/*.service \
           "${ROOT_DIR}/lib/systemd/system"/*.service \
           "${ROOT_DIR}/usr/lib/systemd/system"/*.service; do
    [[ -e "${f}" || -L "${f}" ]] && SCAN_FILES+=("${f}")
  done

  for u in "${SCAN_FILES[@]:-}"; do
    [[ -z "${u}" ]] && continue
    bu="$(basename "${u}")"
    [[ "${bu}" == "printellect.service" || "${bu}" == "printellect-migration-recover.service" ]] && continue
    dup=false
    for s in "${SEEN[@]:-}"; do [[ "${s}" == "${bu}" ]] && dup=true && break; done
    [[ "${dup}" == "true" ]] && continue

    upath="${u}"
    rpath="${u}"
    if [[ -L "${u}" ]]; then
      rpath="$(resolve_symlink_target_in_root "${u}")"
      [[ "${rpath}" == "/dev/null" ]] && SEEN+=("${bu}") && continue
      if [[ -z "${rpath}" || ! -e "${rpath}" ]]; then
        [[ "${bu}" =~ (kiosk|printellect) ]] && fatal "Broken symlink for candidate legacy unit '${u}'."
        continue
      fi
      [[ "${u}" == *".target.wants/"* ]] && upath="${rpath}"
    fi

    eff=()
    while IFS= read -r ef; do
      [[ -n "${ef}" && -r "${ef}" ]] && eff+=("${ef}")
    done < <(collect_non_canary_unit_files "${bu}" "${rpath}" "${upath}")

    if [[ "${bu}" =~ (kiosk|printellect) ]] || { [[ "${#eff[@]}" -gt 0 ]] && grep -qiE '(printellect|kiosk)' "${eff[@]}" 2>/dev/null; }; then
      if [[ "${bu}" =~ ^(kiosk-daemon|kiosk|printellect-kiosk|printellect-server|printellect-daemon)\.service$ ]] || \
         { [[ "${#eff[@]}" -gt 0 ]] && grep -qE '(index\.js|printellect-kiosk|printellect-server|printellect-daemon)' "${eff[@]}" 2>/dev/null; }; then
        MATCHED+=("${upath}")
        MATCHED_READ+=("${rpath}")
        SEEN+=("${bu}")
      fi
    fi
  done

  if [[ "${#MATCHED[@]}" -eq 0 ]]; then
    fatal "No legacy Printellect/kiosk systemd unit discovered. Specify explicitly with --legacy-unit <name>."
  elif [[ "${#MATCHED[@]}" -gt 1 ]]; then
    fatal "Multiple candidate legacy units discovered (${MATCHED[*]}). Specify explicitly with --legacy-unit <name>."
  fi
  FOUND_UNIT_PATH="${MATCHED[0]}"
  FOUND_READ_PATH="${MATCHED_READ[0]}"
  FOUND_UNIT_NAME="$(basename "${FOUND_UNIT_PATH}")"
fi

if [[ -z "${FOUND_READ_PATH}" || "${FOUND_READ_PATH}" == "/dev/null" || ! -r "${FOUND_READ_PATH}" || ! -s "${FOUND_READ_PATH}" ]]; then
  fatal "Legacy unit '${FOUND_UNIT_NAME}' is masked, unreadable, or empty."
fi

EFFECTIVE_FILES=()
while IFS= read -r ef; do
  if [[ -L "${ef}" ]]; then
    ef="$(resolve_symlink_target_in_root "${ef}")"
  fi
  [[ -n "${ef}" && -r "${ef}" ]] && EFFECTIVE_FILES+=("${ef}")
done < <(collect_non_canary_unit_files "${FOUND_UNIT_NAME}" "${FOUND_READ_PATH}" "${FOUND_UNIT_PATH}")

ORIG_EXECSTART="$(grep -hE '^[[:space:]]*ExecStart=.+' "${EFFECTIVE_FILES[@]}" 2>/dev/null | tail -n1 | sed -E 's/^[[:space:]]*ExecStart=[[:space:]]*//' || true)"
ORIG_USER="$(grep -hE '^[[:space:]]*User=.+' "${EFFECTIVE_FILES[@]}" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]"\047' || true)"
ORIG_WORKDIR="$(grep -hE '^[[:space:]]*WorkingDirectory=.+' "${EFFECTIVE_FILES[@]}" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]"\047' || true)"

if [[ -z "${ORIG_EXECSTART}" ]]; then
  fatal "Could not extract effective ExecStart= from legacy unit '${FOUND_UNIT_NAME}'."
fi

# Rewrite ONLY the leading node executable token in ExecStart=, preserving systemd prefixModifiers (@,-,+,!) and all arguments
EXEC_PREFIX=""
EXEC_REST="${ORIG_EXECSTART}"
if [[ "${EXEC_REST}" =~ ^([@+-!]+)(.*)$ ]]; then
  EXEC_PREFIX="${BASH_REMATCH[1]}"
  EXEC_REST="${BASH_REMATCH[2]}"
fi

FIRST_TOKEN="${EXEC_REST%%[[:space:]]*}"
REMAINING_ARGS=""
if [[ "${EXEC_REST}" == *[[:space:]]* ]]; then
  REMAINING_ARGS="${EXEC_REST#*[[:space:]]}"
fi

CLEAN_FIRST="${FIRST_TOKEN//\"/}"
CLEAN_FIRST="${CLEAN_FIRST//\'/}"
if [[ ! "$(basename "${CLEAN_FIRST}")" =~ ^node([0-9.]*)?$ ]]; then
  fatal "Legacy ExecStart executable '${CLEAN_FIRST}' is not a direct node binary invocation; refusing automatic ExecStart override to avoid breaking wrapper semantics."
fi

if [[ -n "${REMAINING_ARGS}" ]]; then
  CANARY_EXECSTART="${EXEC_PREFIX}${LOGICAL_STAGED_NODE} ${REMAINING_ARGS}"
else
  CANARY_EXECSTART="${EXEC_PREFIX}${LOGICAL_STAGED_NODE}"
fi

WAS_ACTIVE=false
if systemd_active; then
  cur_st="$(systemctl is-active "${FOUND_UNIT_NAME}" 2>/dev/null || echo "inactive")"
  [[ "${cur_st}" == "active" || "${cur_st}" == "activating" ]] && WAS_ACTIVE=true
fi

log "Target legacy unit   : ${FOUND_UNIT_NAME} (${FOUND_UNIT_PATH})"
log "Preserved User       : ${ORIG_USER:-root}"
log "Preserved WorkDir    : ${ORIG_WORKDIR:-(unit default)}"
log "Original ExecStart   : $(mask_execstart_for_log "${ORIG_EXECSTART}")"
log "Canary ExecStart     : $(mask_execstart_for_log "${CANARY_EXECSTART}")"
log "Currently active     : ${WAS_ACTIVE}"

if [[ "${MODE}" == "preflight" || "${DRY_RUN}" == "true" ]]; then
  echo ""
  echo "=========================================================="
  echo "   LEGACY NODE 24 CANARY PREFLIGHT / DRY-RUN COMPLETE     "
  echo "=========================================================="
  log "Temporary drop-in path : ${SYSTEMD_DIR}/${FOUND_UNIT_NAME}.d/${CANARY_CONF_NAME}"
  log "No files or running services were modified."
  exit 0
fi

# ==============================================================================
# 3. GATED EXECUTION: APPLY CANARY DROP-IN, RESTART SINGLE INSTANCE & VERIFY
# ==============================================================================
CANARY_DROPIN_DIR="${SYSTEMD_DIR}/${FOUND_UNIT_NAME}.d"
CANARY_DROPIN_FILE="${CANARY_DROPIN_DIR}/${CANARY_CONF_NAME}"
CANARY_IN_FLIGHT=false

on_canary_abort() {
  local ec=$?
  trap - ERR INT TERM
  if [[ "${CANARY_IN_FLIGHT}" == "true" ]]; then
    warn "Validation interrupted or failed (exit=${ec})! Restoring legacy service baseline automatically..."
    perform_canary_restore "${FOUND_UNIT_NAME}" "${WAS_ACTIVE}" "failed_restored" || true
  fi
  exit "${ec}"
}

mkdir -p "${ENV_DIR}" "${CANARY_DROPIN_DIR}"
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
META_TMP="${VALIDATION_META}.tmp.$$"
cat > "${META_TMP}" <<EOF
{
  "legacyUnitName": "${FOUND_UNIT_NAME}",
  "stagedNodeBin": "${LOGICAL_STAGED_NODE}",
  "stagedNodeVersion": "${STAGED_VER}",
  "canaryDropinFile": "${CANARY_DROPIN_FILE}",
  "wasActive": ${WAS_ACTIVE},
  "startedAt": "${STARTED_AT}",
  "status": "in_progress"
}
EOF
chmod 0600 "${META_TMP}"
mv -f "${META_TMP}" "${VALIDATION_META}"

CANARY_IN_FLIGHT=true
trap on_canary_abort ERR INT TERM

DROPIN_TMP="${CANARY_DROPIN_FILE}.tmp.$$"
cat > "${DROPIN_TMP}" <<EOF
# Temporary staged Node.js 24 validation override — managed by validate-legacy-node24.sh
# Preserves original User, WorkingDirectory, Environment, EnvironmentFile, and dependencies
[Service]
ExecStart=
ExecStart=${CANARY_EXECSTART}
EOF
chmod 0644 "${DROPIN_TMP}"
mv -f "${DROPIN_TMP}" "${CANARY_DROPIN_FILE}"
log "Installed temporary canary override: ${CANARY_DROPIN_FILE}"

if ! systemd_active; then
  fatal "Active systemd is required for --run-validation."
fi

RESTART_EPOCH="$(date -u +"%Y-%m-%d %H:%M:%S")"
systemctl daemon-reload
log "Restarting '${FOUND_UNIT_NAME}' (stops Node 20 process before starting staged Node 24 process — zero concurrent listeners)..."
systemctl restart "${FOUND_UNIT_NAME}"

IS_READY=false
FAIL_DETAIL=""
CANARY_PID=""

for ((elapsed=1; elapsed<=HEALTH_TIMEOUT; elapsed++)); do
  sleep 1
  show_out="$(systemctl show "${FOUND_UNIT_NAME}" -p ActiveState -p SubState -p MainPID -p NRestarts -p Result 2>/dev/null || true)"
  a_state="$(echo "${show_out}" | grep '^ActiveState=' | cut -d= -f2- || true)"
  s_state="$(echo "${show_out}" | grep '^SubState=' | cut -d= -f2- || true)"
  m_pid="$(echo "${show_out}" | grep '^MainPID=' | cut -d= -f2- || echo "0")"
  n_rest="$(echo "${show_out}" | grep '^NRestarts=' | cut -d= -f2- || echo "0")"
  u_res="$(echo "${show_out}" | grep '^Result=' | cut -d= -f2- || true)"

  [[ -z "${a_state}" ]] && a_state="$(systemctl is-active "${FOUND_UNIT_NAME}" 2>/dev/null || echo "inactive")"

  if [[ "${n_rest}" =~ ^[0-9]+$ ]] && [[ "${n_rest}" -gt 0 ]]; then
    FAIL_DETAIL="legacy daemon crash-looped under staged Node 24 (NRestarts=${n_rest})"
    break
  fi
  if [[ "${a_state}" == "failed" || "${a_state}" == "inactive" || "${a_state}" == "deactivating" ]]; then
    FAIL_DETAIL="legacy daemon entered '${a_state}' state under staged Node 24 (Result=${u_res:-unknown})"
    break
  fi

  if [[ "${a_state}" == "active" && ( -z "${s_state}" || "${s_state}" == "running" ) ]]; then
    # On real Linux host, verify /proc/<MainPID>/exe points to staged Node 24 binary
    if [[ -z "${ROOT_DIR}" && -n "${m_pid}" && "${m_pid}" != "0" && -L "/proc/${m_pid}/exe" ]]; then
      actual_exe="$(readlink -f "/proc/${m_pid}/exe" 2>/dev/null || true)"
      expected_exe="$(readlink -f "${STAGED_NODE_BIN}" 2>/dev/null || echo "${STAGED_NODE_BIN}")"
      if [[ -n "${actual_exe}" && "${actual_exe}" != "${expected_exe}" ]]; then
        FAIL_DETAIL="MainPID ${m_pid} executable '${actual_exe}' does not match staged Node 24 '${expected_exe}'"
        break
      fi
    fi

    if command -v journalctl >/dev/null 2>&1; then
      jslice=""
      if [[ "${m_pid}" =~ ^[1-9][0-9]*$ ]]; then
        jslice="$(journalctl -u "${FOUND_UNIT_NAME}" "_PID=${m_pid}" --no-pager 2>/dev/null || true)"
      elif [[ -z "${show_out}" ]]; then
        jslice="$(journalctl -u "${FOUND_UNIT_NAME}" --since "${RESTART_EPOCH}" -n 60 --no-pager 2>/dev/null || true)"
      fi

      if echo "${jslice}" | grep -qE '(\[FATAL ERROR\]|\[FATAL CONFIG ERROR\]|Firebase Auth Error:|Firestore Listener Error:|ERR_DLOPEN_FAILED|ERR_MODULE_NOT_FOUND|SyntaxError:|ReferenceError:)'; then
        FAIL_DETAIL="fatal runtime/Firebase error logged under staged Node 24"
        break
      fi

      if echo "${jslice}" | grep -q 'Connected to Firebase\.' && \
         echo "${jslice}" | grep -q 'Listening for print jobs'; then
        CANARY_PID="${m_pid}"
        IS_READY=true
        break
      fi
    else
      CANARY_PID="${m_pid}"
      IS_READY=true
      break
    fi
  fi
done

if [[ "${IS_READY}" == "true" && "${STABLE_SEC}" -gt 0 ]]; then
  log "Firebase auth & listener readiness confirmed on staged Node 24 (MainPID=${CANARY_PID:-unknown}); holding ${STABLE_SEC}s..."
  for ((h=1; h<=STABLE_SEC; h++)); do
    sleep 1
    hout="$(systemctl show "${FOUND_UNIT_NAME}" -p ActiveState -p MainPID -p NRestarts 2>/dev/null || true)"
    ha="$(echo "${hout}" | grep '^ActiveState=' | cut -d= -f2- || systemctl is-active "${FOUND_UNIT_NAME}" 2>/dev/null || echo "inactive")"
    hp="$(echo "${hout}" | grep '^MainPID=' | cut -d= -f2- || echo "0")"
    hr="$(echo "${hout}" | grep '^NRestarts=' | cut -d= -f2- || echo "0")"
    if [[ "${ha}" != "active" ]] || { [[ "${hr}" =~ ^[0-9]+$ ]] && [[ "${hr}" -gt 0 ]]; }; then
      IS_READY=false
      FAIL_DETAIL="legacy daemon became unstable during ${STABLE_SEC}s hold (state=${ha}, NRestarts=${hr})"
      break
    fi
    if [[ -n "${CANARY_PID}" && "${CANARY_PID}" != "0" && -n "${hp}" && "${hp}" != "0" && "${hp}" != "${CANARY_PID}" ]]; then
      IS_READY=false
      FAIL_DETAIL="MainPID changed during stability hold (${CANARY_PID} -> ${hp})"
      break
    fi
  done
fi

if [[ "${IS_READY}" != "true" ]]; then
  CANARY_IN_FLIGHT=false
  trap - ERR INT TERM
  warn "Staged Node.js 24 validation FAILED for '${FOUND_UNIT_NAME}': ${FAIL_DETAIL:-timed out waiting for readiness markers}"
  perform_canary_restore "${FOUND_UNIT_NAME}" "${WAS_ACTIVE}" "failed_restored" || true
  fatal "Legacy daemon failed staged Node.js 24 validation. Baseline runtime restored; do NOT upgrade /usr/bin/node until resolved."
fi

# 4. Verify clean SIGTERM shutdown under staged Node.js 24 before restoring baseline
log "Verifying clean shutdown of '${FOUND_UNIT_NAME}' under staged Node.js 24..."
systemctl stop "${FOUND_UNIT_NAME}"
stop_out="$(systemctl show "${FOUND_UNIT_NAME}" -p ActiveState -p Result -p ExecMainCode -p ExecMainStatus 2>/dev/null || true)"
stop_active="$(echo "${stop_out}" | grep '^ActiveState=' | cut -d= -f2- || systemctl is-active "${FOUND_UNIT_NAME}" 2>/dev/null || echo "inactive")"
stop_result="$(echo "${stop_out}" | grep '^Result=' | cut -d= -f2- || echo "success")"

if [[ "${stop_active}" != "inactive" ]]; then
  CANARY_IN_FLIGHT=false
  trap - ERR INT TERM
  perform_canary_restore "${FOUND_UNIT_NAME}" "${WAS_ACTIVE}" "shutdown_failed_restored" || true
  fatal "Legacy daemon did not reach inactive state cleanly on stop under Node 24 (state=${stop_active})."
fi
if [[ "${stop_result}" =~ ^(timeout|core-dump|watchdog)$ ]]; then
  CANARY_IN_FLIGHT=false
  trap - ERR INT TERM
  perform_canary_restore "${FOUND_UNIT_NAME}" "${WAS_ACTIVE}" "shutdown_failed_restored" || true
  fatal "Legacy daemon failed clean shutdown under Node 24 (Result=${stop_result})."
fi
log "✓ Clean shutdown verified under staged Node.js 24 (ActiveState=${stop_active}, Result=${stop_result:-success})."

# 5. Deterministically remove temporary canary drop-in and restore pre-test baseline
CANARY_IN_FLIGHT=false
trap - ERR INT TERM
perform_canary_restore "${FOUND_UNIT_NAME}" "${WAS_ACTIVE}" "passed_and_restored"

# 6. Confirm /usr/bin/node was never modified
SYS_NODE_AFTER_DESC="absent"
if [[ -e "${SYSTEM_NODE_PATH}" || -L "${SYSTEM_NODE_PATH}" ]]; then
  SYS_NODE_VER_AFTER="$("${SYSTEM_NODE_PATH}" -v 2>/dev/null || echo "unrunnable")"
  SYS_NODE_LINK_AFTER="$(readlink "${SYSTEM_NODE_PATH}" 2>/dev/null || echo "regular_file")"
  SYS_NODE_AFTER_DESC="${SYS_NODE_VER_AFTER}:${SYS_NODE_LINK_AFTER}"
fi
if [[ "${SYS_NODE_BEFORE_DESC}" != "${SYS_NODE_AFTER_DESC}" ]]; then
  fatal "Unexpected change detected on /usr/bin/node (${SYS_NODE_BEFORE_DESC} -> ${SYS_NODE_AFTER_DESC})!"
fi

echo ""
echo "=========================================================="
echo "   LEGACY DAEMON STAGED NODE 24 VALIDATION PASSED         "
echo "=========================================================="
log "Validated Unit    : ${FOUND_UNIT_NAME}"
log "Staged Runtime    : ${STAGED_NODE_BIN} (${STAGED_VER})"
log "Checks Passed     : Startup, Firebase Auth, Job Listener, Stability Hold, Clean Shutdown"
log "Baseline Restored : Temporary canary drop-in removed; /usr/bin/node unchanged."
echo "=========================================================="
exit 0

