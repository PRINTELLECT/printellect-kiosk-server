#!/usr/bin/env bash

# ==============================================================================
# PRINTELLECT Kiosk Server — Versioned Node.js 24 Runtime Stager & Validator
#
# Stages a self-contained, versioned Node.js 24 LTS runtime under
# /opt/printellect/runtime/ and validates both legacy and new daemon workdirs
# BEFORE modifying the active /usr/bin/node runtime or stopping any service.
#
# Supported OS: Debian GNU/Linux 11, 12, 13, Raspberry Pi OS (ARM64 / x64)
# ==============================================================================

set -euo pipefail

SCRIPT_VERSION="1.0.0"
DEFAULT_NODE_VERSION="v24.14.0"
NODE_DIST_BASE_URL="https://nodejs.org/dist"

ROOT_DIR=""
NODE_VERSION="${DEFAULT_NODE_VERSION}"
LOCAL_TARBALL=""
LOCAL_SHASUMS=""
VALIDATE_ONLY=false
EXISTING_NODE_BIN=""
DRY_RUN=false
ALLOW_UNSUPPORTED_ARCH=false
WORKDIRS_TO_VALIDATE=()

print_usage() {
  cat <<EOF
PRINTELLECT Kiosk Server — Versioned Node.js Runtime Stager v${SCRIPT_VERSION}

Usage:
  sudo bash stage-node-runtime.sh [OPTIONS]

Options:
  --version <v24.x.y>           Node.js 24 LTS version to stage (default: ${DEFAULT_NODE_VERSION})
  --tarball <FILE>              Use pre-downloaded official node-v24.x.y-linux-<arch>.tar.xz/.tar.gz
  --shasums <FILE>              Use pre-downloaded official SHASUMS256.txt for offline verification
  --validate-workdir <DIR>      Validate daemon directory compatibility under staged Node 24
                                (may be specified multiple times, e.g. legacy dir and new release dir)
  --validate-only               Skip staging; validate --validate-workdir targets using --node-bin
  --node-bin <PATH>             Node.js >= 24 binary to use with --validate-only
  --root-dir <PATH>             Prefix staging paths for isolated non-root testing
  --allow-unsupported-arch      Allow non-arm64 architectures for development/testing
  --dry-run                     Simulate staging and validation without writing to /opt
  -h, --help                    Show this help message

Examples:
  # Stage Node.js 24 side-by-side and validate legacy + new daemon before touching /usr/bin/node
  sudo bash stage-node-runtime.sh --version v24.14.0 \\
    --validate-workdir /home/aaryan/printellect/printellect-kiosk-server \\
    --validate-workdir /opt/printellect/current
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      NODE_VERSION="$2"
      shift 2
      ;;
    --tarball)
      LOCAL_TARBALL="$2"
      shift 2
      ;;
    --shasums)
      LOCAL_SHASUMS="$2"
      shift 2
      ;;
    --validate-workdir)
      WORKDIRS_TO_VALIDATE+=("$2")
      shift 2
      ;;
    --validate-only)
      VALIDATE_ONLY=true
      shift
      ;;
    --node-bin)
      EXISTING_NODE_BIN="$2"
      shift 2
      ;;
    --root-dir)
      ROOT_DIR="$2"
      shift 2
      ;;
    --allow-unsupported-arch)
      ALLOW_UNSUPPORTED_ARCH=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
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

# Normalize version prefix (ensure leading 'v')
if [[ ! "${NODE_VERSION}" =~ ^v ]]; then
  NODE_VERSION="v${NODE_VERSION}"
fi

NODE_MAJOR="$(echo "${NODE_VERSION}" | sed -E 's/^v([0-9]+)\..*/\1/')"
if [[ ! "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || [[ "${NODE_MAJOR}" -lt 24 ]]; then
  fatal "Target version '${NODE_VERSION}' is not supported. Node.js >= 24 LTS is required."
fi

TEMP_DIR=""
EXTRACT_TMP=""
PREV_RUNTIME_BACKUP=""
TARGET_RUNTIME_DIR=""

cleanup() {
  if [[ -n "${EXTRACT_TMP}" && -d "${EXTRACT_TMP}" ]]; then
    rm -rf "${EXTRACT_TMP}" 2>/dev/null || true
  fi
  if [[ -n "${PREV_RUNTIME_BACKUP}" && -d "${PREV_RUNTIME_BACKUP}" ]]; then
    if [[ -n "${TARGET_RUNTIME_DIR}" && ! -d "${TARGET_RUNTIME_DIR}" ]]; then
      mv "${PREV_RUNTIME_BACKUP}" "${TARGET_RUNTIME_DIR}" 2>/dev/null || true
    else
      rm -rf "${PREV_RUNTIME_BACKUP}" 2>/dev/null || true
    fi
  fi
  if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]]; then
    rm -rf "${TEMP_DIR}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

RUNTIME_BASE="${ROOT_DIR}/opt/printellect/runtime"
CURRENT_RUNTIME_LINK="${RUNTIME_BASE}/current"

validate_systemd_sandbox_path() {
  local check_path="$1"
  local stripped="${check_path}"
  if [[ -n "${ROOT_DIR}" && "${stripped}" == "${ROOT_DIR}"* ]]; then
    stripped="${stripped#${ROOT_DIR}}"
  fi
  if [[ "${stripped}" =~ ^/(home|root)(/|$) ]]; then
    fatal "Runtime path '${check_path}' resides under /home or /root, which is inaccessible to printellect.service due to ProtectHome=true. Stage runtimes under /opt/printellect/runtime/."
  fi
}

validate_daemon_workdir() {
  local node_exec="$1"
  local wdir="$2"

  if [[ ! -d "${wdir}" ]]; then
    fatal "Validation target directory does not exist: ${wdir}"
  fi

  log "Validating daemon directory against Node.js 24: ${wdir}"

  # 1. Scan for compiled native C++ addons (*.node) that break across ABI versions
  local native_addons=()
  if [[ -d "${wdir}/node_modules" ]]; then
    while IFS= read -r addon; do
      [[ -n "${addon}" ]] && native_addons+=("${addon}")
    done < <(find "${wdir}/node_modules" -name "*.node" -type f 2>/dev/null || true)
  fi

  if [[ "${#native_addons[@]}" -gt 0 ]]; then
    warn "Found ${#native_addons[@]} compiled native addon(s) in ${wdir}/node_modules:"
    for addon in "${native_addons[@]}"; do
      warn "  - ${addon}"
      # Attempt dlopen ABI check with staged Node 24
      if ! "${node_exec}" -e "process.dlopen({ exports: {} }, process.argv[1]);" "${addon}" >/dev/null 2>&1; then
        fatal "Native addon ABI incompatibility detected under Node 24: ${addon}. After runtime upgrade, run 'npm rebuild' inside ${wdir} before starting this daemon."
      fi
    done
    log "All native addons in ${wdir} passed Node 24 dlopen ABI verification."
  else
    log "✓ Zero compiled native (.node) addons in ${wdir} (pure JS dependency tree)."
  fi

  # 2. Verify JS syntax of daemon entrypoints using staged Node 24 (--check does not execute code)
  local js_files=("index.js" "printer.js" "firebase.js" "config.js" "setup.js")
  local checked_count=0
  for jsf in "${js_files[@]}"; do
    if [[ -f "${wdir}/${jsf}" ]]; then
      if ! "${node_exec}" --check "${wdir}/${jsf}"; then
        fatal "Node 24 syntax check failed for ${wdir}/${jsf}"
      fi
      checked_count=$((checked_count + 1))
    fi
  done

  if [[ "${checked_count}" -eq 0 ]]; then
    fatal "No recognizable daemon JavaScript entrypoints (e.g. index.js) found in ${wdir}"
  fi
  log "✓ ${checked_count} JavaScript module(s) in ${wdir} passed Node 24 syntax check."
}

echo "=========================================================="
echo "   PRINTELLECT — VERSIONED NODE.JS 24 STAGER & VALIDATOR  "
echo "=========================================================="

if [[ "${VALIDATE_ONLY}" == "true" ]]; then
  if [[ -z "${EXISTING_NODE_BIN}" ]]; then
    if [[ -x "${CURRENT_RUNTIME_LINK}/bin/node" ]]; then
      EXISTING_NODE_BIN="${CURRENT_RUNTIME_LINK}/bin/node"
    elif command -v node >/dev/null 2>&1; then
      EXISTING_NODE_BIN="$(command -v node)"
    else
      fatal "--node-bin <PATH> is required when using --validate-only."
    fi
  fi

  if [[ ! -x "${EXISTING_NODE_BIN}" ]]; then
    fatal "Specified Node binary is not executable: ${EXISTING_NODE_BIN}"
  fi

  validate_systemd_sandbox_path "${EXISTING_NODE_BIN}"

  VER_OUT="$("${EXISTING_NODE_BIN}" -v)"
  DET_MAJOR="$(echo "${VER_OUT}" | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ ! "${DET_MAJOR}" =~ ^[0-9]+$ ]] || [[ "${DET_MAJOR}" -lt 24 ]]; then
    fatal "Node binary ${EXISTING_NODE_BIN} reported ${VER_OUT}; Node.js >= 24 is required."
  fi
  log "Using Node.js binary for validation: ${EXISTING_NODE_BIN} (${VER_OUT})"

  for wd in "${WORKDIRS_TO_VALIDATE[@]:-}"; do
    [[ -n "${wd}" ]] && validate_daemon_workdir "${EXISTING_NODE_BIN}" "${wd}"
  done

  log "Validation completed successfully. Active system runtime was not modified."
  exit 0
fi

# Privilege check for staging into /opt
if [[ "${DRY_RUN}" != "true" && -z "${ROOT_DIR}" && "$(id -u)" -ne 0 ]]; then
  fatal "Staging into /opt/printellect/runtime requires root privileges (use sudo)."
fi

# Detect platform architecture
UNAME_ARCH="$(uname -m)"
NODE_ARCH=""
case "${UNAME_ARCH}" in
  aarch64|arm64)
    NODE_ARCH="arm64"
    ;;
  x86_64|amd64)
    if [[ "${ALLOW_UNSUPPORTED_ARCH}" == "true" ]]; then
      NODE_ARCH="x64"
      warn "Staging x64 runtime (--allow-unsupported-arch enabled)."
    else
      fatal "Unsupported architecture '${UNAME_ARCH}'. Production Pi requires arm64 (aarch64)."
    fi
    ;;
  *)
    fatal "Unsupported architecture '${UNAME_ARCH}'."
    ;;
esac

DIST_STEM="node-${NODE_VERSION}-linux-${NODE_ARCH}"
ARCHIVE_FILENAME="${DIST_STEM}.tar.xz"
if [[ -n "${LOCAL_TARBALL}" ]]; then
  if [[ "${LOCAL_TARBALL}" == *.tar.gz ]]; then
    ARCHIVE_FILENAME="${DIST_STEM}.tar.gz"
  fi
elif ! command -v xz >/dev/null 2>&1; then
  # Fallback to official .tar.gz if xz (xz-utils) is not installed on minimal Debian 13
  ARCHIVE_FILENAME="${DIST_STEM}.tar.gz"
fi

TEMP_DIR="$(mktemp -d /tmp/printellect-node-stage.XXXXXX)"
chmod 0700 "${TEMP_DIR}"
STAGED_ARCHIVE="${TEMP_DIR}/${ARCHIVE_FILENAME}"
STAGED_SHASUMS="${TEMP_DIR}/SHASUMS256.txt"

# 1. Obtain archive and SHASUMS256.txt
if [[ -n "${LOCAL_TARBALL}" ]]; then
  [[ ! -f "${LOCAL_TARBALL}" ]] && fatal "Local tarball not found: ${LOCAL_TARBALL}"
  ARCHIVE_FILENAME="$(basename "${LOCAL_TARBALL}")"
  STAGED_ARCHIVE="${TEMP_DIR}/${ARCHIVE_FILENAME}"
  cp "${LOCAL_TARBALL}" "${STAGED_ARCHIVE}"
  log "Loaded local Node.js archive: ${LOCAL_TARBALL}"
else
  DOWNLOAD_URL="${NODE_DIST_BASE_URL}/${NODE_VERSION}/${ARCHIVE_FILENAME}"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[DRY RUN] Would download ${DOWNLOAD_URL}"
  else
    log "Downloading ${DOWNLOAD_URL}..."
    curl -fsSL --connect-timeout 15 --max-time 300 "${DOWNLOAD_URL}" -o "${STAGED_ARCHIVE}" \
      || fatal "Failed to download ${DOWNLOAD_URL}"
  fi
fi

if [[ -n "${LOCAL_SHASUMS}" ]]; then
  [[ ! -f "${LOCAL_SHASUMS}" ]] && fatal "Local SHASUMS256.txt not found: ${LOCAL_SHASUMS}"
  cp "${LOCAL_SHASUMS}" "${STAGED_SHASUMS}"
  log "Loaded local checksums: ${LOCAL_SHASUMS}"
else
  SHASUMS_URL="${NODE_DIST_BASE_URL}/${NODE_VERSION}/SHASUMS256.txt"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[DRY RUN] Would download ${SHASUMS_URL}"
  else
    log "Downloading ${SHASUMS_URL}..."
    curl -fsSL --connect-timeout 15 --max-time 60 "${SHASUMS_URL}" -o "${STAGED_SHASUMS}" \
      || fatal "Failed to download ${SHASUMS_URL}"
  fi
fi

# 2. Verify SHA-256 checksum before extracting
if [[ -f "${STAGED_ARCHIVE}" && -f "${STAGED_SHASUMS}" ]]; then
  EXPECTED_HASH="$(awk -v fn="${ARCHIVE_FILENAME}" '$2 == fn || $2 == ("*" fn) { print $1; exit }' "${STAGED_SHASUMS}")"
  if [[ -z "${EXPECTED_HASH}" ]]; then
    fatal "Entry for '${ARCHIVE_FILENAME}' not found in SHASUMS256.txt"
  fi
  ACTUAL_HASH="$(sha256sum "${STAGED_ARCHIVE}" | awk '{print $1}')"
  if [[ "${ACTUAL_HASH}" != "${EXPECTED_HASH}" ]]; then
    fatal "SHA-256 mismatch for ${ARCHIVE_FILENAME}! Expected ${EXPECTED_HASH}, got ${ACTUAL_HASH}"
  fi
  log "✓ SHA-256 verified for ${ARCHIVE_FILENAME}: ${ACTUAL_HASH}"
fi

TARGET_RUNTIME_DIR="${RUNTIME_BASE}/${DIST_STEM}"
validate_systemd_sandbox_path "${TARGET_RUNTIME_DIR}"

if [[ "${DRY_RUN}" == "true" ]]; then
  log "[DRY RUN] Would extract runtime to ${TARGET_RUNTIME_DIR}"
  log "[DRY RUN] Would update symlink ${CURRENT_RUNTIME_LINK} -> ${TARGET_RUNTIME_DIR}"
  for wd in "${WORKDIRS_TO_VALIDATE[@]:-}"; do
    [[ -n "${wd}" ]] && log "[DRY RUN] Would validate daemon directory ${wd} against staged Node.js ${NODE_VERSION}"
  done
  log "[DRY RUN] Active /usr/bin/node would remain untouched."
  exit 0
fi

# 3. Extract into versioned directory atomically
mkdir -p "${RUNTIME_BASE}"
chmod 0755 "${RUNTIME_BASE}"

EXTRACT_TMP="${RUNTIME_BASE}/.stage-${DIST_STEM}-$$"
mkdir -p "${EXTRACT_TMP}"

if [[ "${ARCHIVE_FILENAME}" == *.tar.xz ]]; then
  if ! command -v xz >/dev/null 2>&1; then
    fatal "xz (xz-utils) is required to extract ${ARCHIVE_FILENAME}. Install xz-utils (apt install -y xz-utils) or provide the official node-*.tar.gz archive."
  fi
  tar -xJf "${STAGED_ARCHIVE}" -C "${EXTRACT_TMP}" --strip-components=1 --no-same-owner
else
  tar -xzf "${STAGED_ARCHIVE}" -C "${EXTRACT_TMP}" --strip-components=1 --no-same-owner
fi

STAGED_NODE_BIN="${EXTRACT_TMP}/bin/node"
if [[ ! -x "${STAGED_NODE_BIN}" ]]; then
  fatal "Extracted archive does not contain an executable bin/node."
fi

# Verify staged binary runs on this host's kernel/glibc (when running natively)
if [[ -z "${ROOT_DIR}" ]]; then
  STAGED_VER="$("${STAGED_NODE_BIN}" -v)"
  log "Verified staged runtime execution on host: ${STAGED_VER}"
fi

chown -R root:root "${EXTRACT_TMP}" >/dev/null 2>&1 || true
chmod -R a+rX "${EXTRACT_TMP}"

if [[ -d "${TARGET_RUNTIME_DIR}" ]]; then
  PREV_RUNTIME_BACKUP="${RUNTIME_BASE}/.prev-${DIST_STEM}-$$"
  mv "${TARGET_RUNTIME_DIR}" "${PREV_RUNTIME_BACKUP}"
fi
mv "${EXTRACT_TMP}" "${TARGET_RUNTIME_DIR}"
EXTRACT_TMP=""
if [[ -n "${PREV_RUNTIME_BACKUP}" && -d "${PREV_RUNTIME_BACKUP}" ]]; then
  rm -rf "${PREV_RUNTIME_BACKUP}"
  PREV_RUNTIME_BACKUP=""
fi

# Update /opt/printellect/runtime/current symlink atomically (relative sibling target works in both /opt and --root-dir)
ln -sfn "${DIST_STEM}" "${RUNTIME_BASE}/current.tmp"
if ! mv -Tf "${RUNTIME_BASE}/current.tmp" "${CURRENT_RUNTIME_LINK}" 2>/dev/null; then
  rm -rf "${CURRENT_RUNTIME_LINK}"
  cp -r "${TARGET_RUNTIME_DIR}" "${CURRENT_RUNTIME_LINK}"
  rm -rf "${RUNTIME_BASE}/current.tmp"
fi

FINAL_NODE_BIN="${CURRENT_RUNTIME_LINK}/bin/node"
log "Staged versioned Node.js runtime at: ${FINAL_NODE_BIN}"
log "Active /usr/bin/node was NOT modified."

# 4. Validate requested daemon directories before any cutover
if [[ -z "${ROOT_DIR}" ]]; then
  for wd in "${WORKDIRS_TO_VALIDATE[@]:-}"; do
    [[ -n "${wd}" ]] && validate_daemon_workdir "${FINAL_NODE_BIN}" "${wd}"
  done
fi

echo ""
echo "=========================================================="
echo "   NODE.JS 24 RUNTIME STAGED & VALIDATED                  "
echo "=========================================================="
echo "Staged Binary : ${FINAL_NODE_BIN}"
echo "Version Dir   : ${TARGET_RUNTIME_DIR}"
echo "System Node   : $(command -v node 2>/dev/null || echo 'none') ($(node -v 2>/dev/null || echo 'unchanged'))"
echo "=========================================================="
exit 0
