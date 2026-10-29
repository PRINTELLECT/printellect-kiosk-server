#!/usr/bin/env bash

# ==============================================================================
# PRINTELLECT Kiosk Server — Standalone Bootstrap Installer
#
# Authenticates and extracts signed releases into /opt/printellect/releases/<ver>,
# updates /opt/printellect/current, provisions persistent state directories, and
# writes /etc/printellect/kiosk.env WITHOUT modifying or cutting over live
# systemd services (service cutover is strictly gated in install-service.sh).
#
# TRUST-ANCHOR BOUNDARY:
#   This script embeds DEFAULT_PUBLIC_KEY (matching keys/release-key.pub.pem) as
#   the pinned production trust anchor to verify manifest.json + manifest.json.sig
#   via Ed25519 before trusting any manifest field or extracting any archive byte.
#   Never trust a public key or SHA256SUMS file merely because it was downloaded
#   from the same release URL as the archive. Operators MUST obtain or verify
#   bootstrap.sh (and its embedded DEFAULT_PUBLIC_KEY) from an independently
#   trusted source (e.g., audited Git tag checkout or out-of-band SHA-256 digest)
#   and invoke production bootstrap WITHOUT --pubkey.
#   Never pipe unverified HTTP content directly into 'sudo bash'.
#
# Supported OS: Debian GNU/Linux 11, 12, 13, Raspbian / Raspberry Pi OS
# Supported Architecture: Linux ARM64 (aarch64)
# ==============================================================================

set -euo pipefail

SCRIPT_VERSION="1.3.0"
MIN_FREE_DISK_MB=250

# Embedded official public key (Ed25519) — matches keys/release-key.pub.pem
# Non-matching --pubkey overrides are rejected unless --allow-untrusted-pubkey is explicitly passed
DEFAULT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAYgGBLvQx7mUYr8rB0v21gNBFZ/V1MDjuxyc74XWRzJw=
-----END PUBLIC KEY-----"

# CLI arguments
ROOT_DIR=""
SESSION_ID=""
TARGET_VERSION=""
RELEASE_URL=""
LOCAL_RELEASE_DIR=""
CUSTOM_PUBKEY=""
ALLOW_UNTRUSTED_PUBKEY=false
SKIP_PRINTER_SETUP=false
SKIP_NPM_CI=false
INSTALL_SYSTEM_NODE=false
ALLOW_INSECURE_HTTP=false
DRY_RUN=false
ALLOW_UNSUPPORTED_ARCH=false

print_usage() {
  cat <<EOF
PRINTELLECT Kiosk Server — Bootstrap Installer v${SCRIPT_VERSION}

Usage:
  sudo bash bootstrap.sh --session-id <SESSION_ID> [OPTIONS]

Required:
  -s, --session-id <ID>       Kiosk Session ID for this kiosk station ([A-Za-z0-9_.:@-]{1,128})

Options:
  -v, --version <VER>         Specific release version to install (defaults to manifest version)
  --release-url <URL>         HTTPS base URL to fetch release artifacts (manifest, signature, archive)
  --allow-insecure-http       Allow http:// --release-url (isolated local test harnesses only)
  --local-release-dir <DIR>   Path to local directory with release artifacts (offline/recommended)
  --pubkey <FILE>             Path to Ed25519 public key file (must match pinned key unless --allow-untrusted-pubkey)
  --allow-untrusted-pubkey    Permit non-production --pubkey override (isolated testing / key-rotation drill ONLY)
  --install-system-node       Authorize installing Node.js 24 LTS via NodeSource apt if not pre-staged
  --skip-printer-setup        Do not launch interactive printer setup wizard during installation
  --skip-npm-ci               Skip 'npm ci --omit=dev' (for isolated offline filesystem staging tests)
  --root-dir <PATH>           Prefix installation paths (for isolated non-root testing)
  --dry-run                   Validate environment, prerequisites, and signature without mutating system
  --allow-unsupported-arch    Allow installation on non-aarch64 architectures (development/testing)
  -h, --help                  Show this help message

Example:
  sudo bash bootstrap.sh --session-id "station_rpi4_01" --local-release-dir ./dist --skip-printer-setup
EOF
}

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

require_arg_value() {
  local flag="$1"
  local count="$2"
  local val="${3:-}"
  if [[ "${count}" -lt 2 || -z "${val}" ]]; then
    fatal "Option ${flag} requires a non-empty value."
  fi
}

# Parse command line arguments strictly
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--session-id)
      require_arg_value "$1" "$#" "${2:-}"
      SESSION_ID="$2"
      shift 2
      ;;
    -v|--version)
      require_arg_value "$1" "$#" "${2:-}"
      TARGET_VERSION="$2"
      shift 2
      ;;
    --release-url)
      require_arg_value "$1" "$#" "${2:-}"
      RELEASE_URL="${2%/}"
      shift 2
      ;;
    --allow-insecure-http)
      ALLOW_INSECURE_HTTP=true
      shift
      ;;
    --release-dir|--local-release-dir)
      require_arg_value "$1" "$#" "${2:-}"
      LOCAL_RELEASE_DIR="$2"
      shift 2
      ;;
    --pubkey)
      require_arg_value "$1" "$#" "${2:-}"
      CUSTOM_PUBKEY="$2"
      shift 2
      ;;
    --allow-untrusted-pubkey)
      ALLOW_UNTRUSTED_PUBKEY=true
      shift
      ;;
    --install-system-node)
      INSTALL_SYSTEM_NODE=true
      shift
      ;;
    --skip-printer-setup)
      SKIP_PRINTER_SETUP=true
      shift
      ;;
    --skip-npm-ci)
      SKIP_NPM_CI=true
      shift
      ;;
    --root-dir)
      require_arg_value "$1" "$#" "${2:-}"
      ROOT_DIR="${2%/}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --allow-unsupported-arch)
      ALLOW_UNSUPPORTED_ARCH=true
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

# Resolve installation paths (honoring --root-dir when provided)
BASE_DIR="${ROOT_DIR}/opt/printellect"
RELEASES_DIR="${BASE_DIR}/releases"
CURRENT_LINK="${BASE_DIR}/current"
CONFIG_DIR="${ROOT_DIR}/var/lib/printellect"
CONFIG_FILE="${CONFIG_DIR}/config.json"
BACKUP_DIR="${CONFIG_DIR}/backups"
ENV_DIR="${ROOT_DIR}/etc/printellect"
ENV_FILE="${ENV_DIR}/kiosk.env"
CLI_SYMLINK="${ROOT_DIR}/usr/local/bin/printellect-setup"
LOGICAL_CONFIG_FILE="/var/lib/printellect/config.json"
[[ -n "${ROOT_DIR}" ]] && LOGICAL_CONFIG_FILE="${CONFIG_FILE}"

# Resolve Kiosk Session ID safely (CLI -> env -> kiosk.env -> systemd units)
if [[ -z "${SESSION_ID}" && -n "${KIOSK_SESSION_ID:-}" ]]; then
  SESSION_ID="${KIOSK_SESSION_ID}"
fi
if [[ -z "${SESSION_ID}" && -f "${ENV_FILE}" ]]; then
  SESSION_ID="$(grep -E '^[[:space:]]*KIOSK_SESSION_ID=' "${ENV_FILE}" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"'\''[:space:]' || true)"
fi
if [[ -z "${SESSION_ID}" ]]; then
  for ef in "${ROOT_DIR}/etc/systemd/system"/*.service "${ROOT_DIR}/etc/systemd/system"/*.service.d/*.conf; do
    if [[ -f "${ef}" ]]; then
      sid="$(grep -E '^[[:space:]]*(Environment=.*)?KIOSK_SESSION_ID=' "${ef}" 2>/dev/null | tail -n1 | sed -E 's/.*KIOSK_SESSION_ID=([^[:space:]"'\''\\]*).*/\1/' || true)"
      if [[ -n "${sid}" ]]; then
        SESSION_ID="${sid}"
        break
      fi
    fi
  done
fi

if [[ -z "${SESSION_ID}" && "${DRY_RUN}" == "true" ]]; then
  SESSION_ID="dry-run-preflight-session"
fi

# Validate required arguments & strict SESSION_ID format (prevents env/heredoc injection)
if [[ -z "${SESSION_ID}" ]]; then
  echo "[FATAL ERROR] Kiosk Session ID is required." >&2
  echo "Specify it using --session-id <SESSION_ID> or ensure ${ENV_FILE} exists." >&2
  exit 1
fi

if [[ ! "${SESSION_ID}" =~ ^[A-Za-z0-9_.:@-]{1,128}$ ]]; then
  fatal "Invalid --session-id format. Allowed characters: [A-Za-z0-9_.:@-] (1-128 chars; no whitespace, quotes, newlines, or shell metacharacters)."
fi

if [[ -n "${LOCAL_RELEASE_DIR}" && -n "${RELEASE_URL}" ]]; then
  fatal "Specify either --local-release-dir (or --release-dir) or --release-url, not both."
fi

if [[ -n "${TARGET_VERSION}" ]]; then
  if [[ "${TARGET_VERSION}" == "0.0.0" || ! "${TARGET_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
    fatal "Invalid --version '${TARGET_VERSION}'. Expected non-zero SemVer (e.g. 1.0.0)."
  fi
fi

# Mask sensitive tokens so session credentials are never printed in logs or diagnostics
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

# Temporary & atomic swap state management (preserves previous working release if interrupted)
TEMP_DIR=""
STAGE_DIR=""
PREV_RELEASE_BACKUP=""
TARGET_RELEASE_DIR=""

cleanup() {
  if [[ -n "${STAGE_DIR}" && -d "${STAGE_DIR}" ]]; then
    rm -rf "${STAGE_DIR}" 2>/dev/null || true
  fi
  if [[ -n "${PREV_RELEASE_BACKUP}" && -d "${PREV_RELEASE_BACKUP}" ]]; then
    if [[ -n "${TARGET_RELEASE_DIR}" && ! -d "${TARGET_RELEASE_DIR}" ]]; then
      mv "${PREV_RELEASE_BACKUP}" "${TARGET_RELEASE_DIR}" 2>/dev/null || true
    else
      rm -rf "${PREV_RELEASE_BACKUP}" 2>/dev/null || true
    fi
  fi
  if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" ]]; then
    rm -rf "${TEMP_DIR}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "========================================================"
echo "   PRINTELLECT KIOSK SERVER — BOOTSTRAP INSTALLER       "
echo "========================================================"
log "Session ID : $(mask_token "${SESSION_ID}")"
if [[ "${DRY_RUN}" == "true" ]]; then
  log "Mode       : DRY RUN (no modifications will be made)"
fi

# 1. Privilege check
if [[ "${DRY_RUN}" != "true" && -z "${ROOT_DIR}" && "$(id -u)" -ne 0 ]]; then
  fatal "This installer must be run as root (e.g. sudo bash bootstrap.sh)."
fi

# 2. Operating System and Architecture detection
log "Detecting operating system and platform architecture..."

ARCH="$(uname -m)"
if [[ "${ARCH}" != "aarch64" && "${ARCH}" != "arm64" ]]; then
  if [[ "${ALLOW_UNSUPPORTED_ARCH}" == "true" ]]; then
    warn "Running on unsupported architecture '${ARCH}' (--allow-unsupported-arch enabled)."
  else
    fatal "Unsupported architecture '${ARCH}'. PRINTELLECT Kiosk Server requires Linux ARM64 (aarch64)."
  fi
fi

if [[ -f /etc/os-release ]]; then
  # shellcheck source=/dev/null
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_ID_LIKE="${ID_LIKE:-}"
  log "Detected OS: ${PRETTY_NAME:-$OS_ID} (${ARCH})"

  if [[ "${OS_ID}" != "debian" && "${OS_ID}" != "raspbian" && "${OS_ID_LIKE}" != *"debian"* ]]; then
    warn "OS '${OS_ID}' is not an officially tested Debian/Raspbian distribution."
  fi
else
  warn "/etc/os-release not found. Proceeding with caution."
fi

# 3. Disk space validation
log "Checking available disk space..."
if command -v df >/dev/null 2>&1; then
  AVAIL_KB=$(df -Pk / | awk 'NR==2 {print $4}')
  AVAIL_MB=$(( AVAIL_KB / 1024 ))
  if [[ "${AVAIL_MB}" -lt "${MIN_FREE_DISK_MB}" ]]; then
    fatal "Insufficient disk space: ${AVAIL_MB} MB available. At least ${MIN_FREE_DISK_MB} MB required."
  fi
  log "Available disk space: ${AVAIL_MB} MB (Minimum: ${MIN_FREE_DISK_MB} MB required)"
fi

# 4. Prerequisites check & installation (skipped inside isolated --root-dir test mode)
log "Checking system prerequisites..."
REQUIRED_PKGS=("curl" "tar" "openssl" "ca-certificates" "cups" "cups-client" "ipp-usb")
MISSING_PKGS=()

for pkg in "${REQUIRED_PKGS[@]}"; do
  if ! dpkg -s "${pkg}" >/dev/null 2>&1 && ! command -v "${pkg}" >/dev/null 2>&1; then
    MISSING_PKGS+=("${pkg}")
  fi
done

if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[DRY RUN] Would install missing system packages: ${MISSING_PKGS[*]}"
  elif [[ -n "${ROOT_DIR}" ]]; then
    log "[ISOLATED ROOT] Skipping apt-get prerequisite install for: ${MISSING_PKGS[*]}"
  else
    log "Installing missing prerequisites: ${MISSING_PKGS[*]}..."
    apt-get update -y
    apt-get install -y --no-install-recommends "${MISSING_PKGS[@]}"
  fi
fi

# 5. Check Node.js runtime (requires Node.js >= 24 LTS)
# Prefer pre-staged versioned runtime under /opt/printellect/runtime/current so /usr/bin/node
# and apt sources remain untouched unless --install-system-node is explicitly authorized.
NODE_INSTALLED=false
ACTIVE_NODE_CMD=""
if [[ -x "${BASE_DIR}/runtime/current/bin/node" ]]; then
  ACTIVE_NODE_CMD="${BASE_DIR}/runtime/current/bin/node"
  export PATH="${BASE_DIR}/runtime/current/bin:${PATH}"
elif [[ -x "/opt/printellect/runtime/current/bin/node" ]]; then
  ACTIVE_NODE_CMD="/opt/printellect/runtime/current/bin/node"
  export PATH="/opt/printellect/runtime/current/bin:${PATH}"
elif command -v node >/dev/null 2>&1; then
  ACTIVE_NODE_CMD="$(command -v node)"
fi

if [[ -n "${ACTIVE_NODE_CMD}" ]]; then
  NODE_VER_RAW="$("${ACTIVE_NODE_CMD}" -v 2>/dev/null | sed 's/^v//' || echo "0.0.0")"
  NODE_MAJOR="$(echo "${NODE_VER_RAW}" | cut -d. -f1)"
  if [[ "${NODE_MAJOR}" =~ ^[0-9]+$ ]] && [[ "${NODE_MAJOR}" -ge 24 ]]; then
    NODE_INSTALLED=true
    log "Found supported Node.js runtime: ${ACTIVE_NODE_CMD} (v${NODE_VER_RAW})"
  else
    warn "Detected Node.js at ${ACTIVE_NODE_CMD} (v${NODE_VER_RAW}) is older than required Node.js 24 LTS."
  fi
fi

if [[ "${NODE_INSTALLED}" != "true" ]]; then
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[DRY RUN] Node.js >= 24 not yet active (stage side-by-side via stage-node-runtime.sh or pass --install-system-node)."
  elif [[ -n "${ROOT_DIR}" && "${SKIP_NPM_CI}" == "true" ]]; then
    log "[ISOLATED ROOT] Proceeding without system Node.js 24 (--skip-npm-ci active)."
  elif [[ "${INSTALL_SYSTEM_NODE}" == "true" ]]; then
    log "Installing Node.js 24 LTS from official NodeSource distribution (--install-system-node authorized)..."
    curl -fsSL --connect-timeout 15 --max-time 180 https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
    ACTIVE_NODE_CMD="$(command -v node)"
    log "Node.js installed: $("${ACTIVE_NODE_CMD}" -v)"
  else
    fatal "Node.js >= 24 LTS not found at ${BASE_DIR}/runtime/current/bin/node or in PATH. Stage Node.js 24 side-by-side first with stage-node-runtime.sh (leaves /usr/bin/node untouched), or pass --install-system-node to authorize system-wide NodeSource upgrade."
  fi
fi

# 6. Validate release source & prepare secure temporary staging directory
if [[ -z "${LOCAL_RELEASE_DIR}" && -z "${RELEASE_URL}" ]]; then
  fatal "Either --release-url or --local-release-dir must be specified to provide release artifacts."
fi

if [[ -n "${RELEASE_URL}" ]]; then
  if [[ "${RELEASE_URL}" =~ ^http:// ]]; then
    if [[ "${ALLOW_INSECURE_HTTP}" == "true" ]]; then
      warn "SECURITY ALERT: Downloading release over insecure HTTP (--allow-insecure-http explicitly enabled). Ed25519 signature verification remains mandatory."
    else
      fatal "Insecure HTTP release URL rejected: '${RELEASE_URL}'. Use an https:// release URL (or pass --allow-insecure-http only for isolated local testing)."
    fi
  elif [[ ! "${RELEASE_URL}" =~ ^https:// ]]; then
    fatal "Unsupported release URL scheme: '${RELEASE_URL}'. Only https:// URLs are permitted (use --local-release-dir for local directories)."
  fi
fi

TEMP_DIR="$(mktemp -d /tmp/printellect-boot.XXXXXX)"
chmod 0700 "${TEMP_DIR}"

MANIFEST_FILE="${TEMP_DIR}/manifest.json"
SIG_FILE="${TEMP_DIR}/manifest.json.sig"
PINNED_PUBKEY_FILE="${TEMP_DIR}/pinned-release-key.pub.pem"
PUBKEY_FILE="${TEMP_DIR}/release-key.pub.pem"
printf '%s\n' "${DEFAULT_PUBLIC_KEY}" > "${PINNED_PUBKEY_FILE}"

normalize_pem_key() {
  grep -v '^-----' "$1" 2>/dev/null | tr -d '[:space:]' || true
}

# Setup public key for verification (enforcing pinned production trust anchor by default)
if [[ -n "${CUSTOM_PUBKEY}" ]]; then
  if [[ ! -f "${CUSTOM_PUBKEY}" ]]; then
    fatal "Specified custom public key file not found: ${CUSTOM_PUBKEY}"
  fi
  PINNED_KEY_BODY="$(normalize_pem_key "${PINNED_PUBKEY_FILE}")"
  CUSTOM_KEY_BODY="$(normalize_pem_key "${CUSTOM_PUBKEY}")"
  if [[ -z "${CUSTOM_KEY_BODY}" ]]; then
    fatal "Specified --pubkey file (${CUSTOM_PUBKEY}) does not contain a valid PEM public key."
  fi
  if [[ "${CUSTOM_KEY_BODY}" == "${PINNED_KEY_BODY}" ]]; then
    log "Specified --pubkey matches pinned official production public key."
    cp "${PINNED_PUBKEY_FILE}" "${PUBKEY_FILE}"
  elif [[ "${ALLOW_UNTRUSTED_PUBKEY}" == "true" ]]; then
    warn "SECURITY OVERRIDE ACTIVE (--allow-untrusted-pubkey): Bypassing pinned production trust anchor with custom key (${CUSTOM_PUBKEY})."
    warn "This override is strictly for isolated test harnesses or an authorized key-rotation drill."
    cp "${CUSTOM_PUBKEY}" "${PUBKEY_FILE}"
  else
    fatal "TRUST ANCHOR VIOLATION: Custom --pubkey (${CUSTOM_PUBKEY}) does not match the pinned official production public key! Downloading or supplying an unpinned public key alongside a release bypasses signature verification. Omit --pubkey for production deployments (or pass --allow-untrusted-pubkey ONLY in isolated development/testing)."
  fi
else
  cp "${PINNED_PUBKEY_FILE}" "${PUBKEY_FILE}"
  log "Using pinned official production public key."
fi

# 7. Fetch release manifest and signature
log "Fetching release artifacts..."

if [[ -n "${LOCAL_RELEASE_DIR}" ]]; then
  log "Loading release artifacts from local directory: ${LOCAL_RELEASE_DIR}"
  if [[ ! -f "${LOCAL_RELEASE_DIR}/manifest.json" ]]; then
    fatal "manifest.json not found in ${LOCAL_RELEASE_DIR}"
  fi
  cp "${LOCAL_RELEASE_DIR}/manifest.json" "${MANIFEST_FILE}"

  if [[ -f "${LOCAL_RELEASE_DIR}/manifest.json.sig" ]]; then
    cp "${LOCAL_RELEASE_DIR}/manifest.json.sig" "${SIG_FILE}"
  else
    fatal "manifest.json.sig not found in ${LOCAL_RELEASE_DIR}. Signed release required."
  fi
else
  log "Downloading release manifest from ${RELEASE_URL}/manifest.json..."
  curl -fsSL --connect-timeout 15 --max-time 180 "${RELEASE_URL}/manifest.json" -o "${MANIFEST_FILE}" \
    || fatal "Failed to download manifest.json from ${RELEASE_URL}"
  curl -fsSL --connect-timeout 15 --max-time 180 "${RELEASE_URL}/manifest.json.sig" -o "${SIG_FILE}" \
    || fatal "Failed to download manifest.json.sig from ${RELEASE_URL}"
fi

# 8. Cryptographic Trust Verification (Ed25519)
log "Verifying cryptographic Ed25519 signature of release manifest..."
SIG_BYTES="$(wc -c < "${SIG_FILE}" | tr -d '[:space:]')"
if [[ "${SIG_BYTES}" != "64" ]]; then
  fatal "CRYPTOGRAPHIC VERIFICATION FAILED! Invalid Ed25519 signature length (${SIG_BYTES} bytes; expected 64 bytes)."
fi

if ! openssl pkeyutl -verify -pubin -inkey "${PUBKEY_FILE}" -rawin -in "${MANIFEST_FILE}" -sigfile "${SIG_FILE}" >/dev/null 2>&1; then
  fatal "CRYPTOGRAPHIC VERIFICATION FAILED! Manifest signature does not match trusted public key."
fi
log "✓ Manifest Ed25519 signature is VALID."

# Mandatory archive file allowlist (15 source files + release.json = 16 archive entries)
MANDATORY_ARCHIVE_FILES=(
  "index.js"
  "printer.js"
  "firebase.js"
  "config.js"
  "setup.js"
  "package.json"
  "package-lock.json"
  "release.json"
  "bin/printellect-setup"
  "systemd/printellect.service"
  "systemd/printellect-migration-recover.service"
  "scripts/install-service.sh"
  "scripts/recover-migration.sh"
  "scripts/stage-node-runtime.sh"
  "scripts/validate-legacy-node24.sh"
  "scripts/verify-print-acceptance.js"
)

# Parse and strictly validate schemaVersion 2 manifest
NODE_PARSER=""
if [[ -n "${ACTIVE_NODE_CMD}" && -x "${ACTIVE_NODE_CMD}" ]]; then
  NODE_PARSER="${ACTIVE_NODE_CMD}"
elif command -v node >/dev/null 2>&1; then
  NODE_PARSER="$(command -v node)"
fi

EXPECTED_SIZE_BYTES="0"
SOURCE_HASHES_TSV="${TEMP_DIR}/source-hashes.tsv"
: > "${SOURCE_HASHES_TSV}"

if [[ -n "${NODE_PARSER}" ]]; then
  MANIFEST_CHECK_OUT="$("${NODE_PARSER}" - "${MANIFEST_FILE}" "${SOURCE_HASHES_TSV}" <<'JS'
const fs = require('fs');
const manifestPath = process.argv[2];
const tsvPath = process.argv[3];
const required = [
  'index.js',
  'printer.js',
  'firebase.js',
  'config.js',
  'setup.js',
  'package.json',
  'package-lock.json',
  'bin/printellect-setup',
  'systemd/printellect.service',
  'systemd/printellect-migration-recover.service',
  'scripts/install-service.sh',
  'scripts/recover-migration.sh',
  'scripts/stage-node-runtime.sh',
  'scripts/validate-legacy-node24.sh',
  'scripts/verify-print-acceptance.js',
];
let m;
try {
  m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error('INVALID MANIFEST JSON: ' + e.message);
  process.exit(2);
}
if (!m || typeof m !== 'object' || Array.isArray(m)) {
  console.error('INVALID MANIFEST SCHEMA: root must be object');
  process.exit(2);
}
if (m.schemaVersion !== 2) {
  console.error('INVALID MANIFEST SCHEMA: expected schemaVersion 2');
  process.exit(2);
}
if (m.name !== 'printellect-kiosk-daemon') {
  console.error('INVALID MANIFEST SCHEMA: unexpected package name');
  process.exit(2);
}
if (typeof m.version !== 'string' || m.version === '0.0.0' || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(m.version)) {
  console.error('UNSUPPORTED OR INVALID VERSION: ' + m.version);
  process.exit(2);
}
if (m.architecture !== 'linux-arm64') {
  console.error('UNSUPPORTED ARCHITECTURE: ' + m.architecture);
  process.exit(2);
}
if (m.minNodeVersion !== '>=24.0.0') {
  console.error('UNSUPPORTED MIN NODE VERSION: ' + m.minNodeVersion);
  process.exit(2);
}
const expectedArchive = `printellect-kiosk-daemon-${m.version}.tar.gz`;
if (
  !m.archive ||
  typeof m.archive !== 'object' ||
  m.archive.filename !== expectedArchive ||
  typeof m.archive.sha256 !== 'string' ||
  !/^[a-f0-9]{64}$/i.test(m.archive.sha256) ||
  !Number.isInteger(m.archive.sizeBytes) ||
  m.archive.sizeBytes <= 0
) {
  console.error('INVALID MANIFEST SCHEMA: malformed archive metadata');
  process.exit(2);
}
if (!m.sourceFiles || typeof m.sourceFiles !== 'object' || Array.isArray(m.sourceFiles)) {
  console.error('INVALID MANIFEST SCHEMA: missing sourceFiles map');
  process.exit(2);
}
const reqSet = new Set(required);
for (const k of Object.keys(m.sourceFiles)) {
  if (!reqSet.has(k)) {
    console.error('SECURITY ALERT: unexpected extra file in manifest.sourceFiles: ' + k);
    process.exit(2);
  }
}
const lines = [];
for (const r of required) {
  const h = m.sourceFiles[r];
  if (typeof h !== 'string' || !/^[a-f0-9]{64}$/i.test(h)) {
    console.error('INCOMPLETE RELEASE MANIFEST: missing valid sourceFiles hash for ' + r);
    process.exit(2);
  }
  lines.push(`${h.toLowerCase()}\t${r}`);
}
fs.writeFileSync(tsvPath, lines.join('\n') + '\n', 'utf8');
console.log(`${m.version}\n${m.archive.filename}\n${m.archive.sha256.toLowerCase()}\n${m.archive.sizeBytes}`);
JS
  )" || fatal "Manifest schema validation failed."

  {
    IFS= read -r RELEASE_VERSION
    IFS= read -r ARCHIVE_NAME
    IFS= read -r EXPECTED_SHA256
    IFS= read -r EXPECTED_SIZE_BYTES
  } <<< "${MANIFEST_CHECK_OUT}"
else
  grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*2([[:space:],}]|$)' "${MANIFEST_FILE}" \
    || fatal "INVALID MANIFEST SCHEMA: Expected schemaVersion 2."
  grep -Eq '"name"[[:space:]]*:[[:space:]]*"printellect-kiosk-daemon"' "${MANIFEST_FILE}" \
    || fatal "INVALID MANIFEST SCHEMA: Expected name 'printellect-kiosk-daemon'."
  grep -Eq '"architecture"[[:space:]]*:[[:space:]]*"linux-arm64"' "${MANIFEST_FILE}" \
    || fatal "UNSUPPORTED ARCHITECTURE in manifest."
  grep -Eq '"minNodeVersion"[[:space:]]*:[[:space:]]*">=24\.0\.0"' "${MANIFEST_FILE}" \
    || fatal "UNSUPPORTED MIN NODE VERSION in manifest."
  grep -Eq '"sourceFiles"[[:space:]]*:[[:space:]]*\{' "${MANIFEST_FILE}" \
    || fatal "INVALID MANIFEST SCHEMA: Missing sourceFiles map."
  RELEASE_VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "${MANIFEST_FILE}" | head -1 | sed -E 's/.*"([^"]*)"$/\1/' || true)"
  ARCHIVE_NAME="$(grep -o '"filename"[[:space:]]*:[[:space:]]*"[^"]*"' "${MANIFEST_FILE}" | head -1 | sed -E 's/.*"([^"]*)"$/\1/' || true)"
  EXPECTED_SHA256="$(grep -o '"sha256"[[:space:]]*:[[:space:]]*"[^"]*"' "${MANIFEST_FILE}" | head -1 | sed -E 's/.*"([^"]*)"$/\1/' | tr '[:upper:]' '[:lower:]' || true)"
  EXPECTED_SIZE_BYTES="$(grep -o '"sizeBytes"[[:space:]]*:[[:space:]]*[0-9]*' "${MANIFEST_FILE}" | head -1 | sed -E 's/.*:[[:space:]]*([0-9]*)$/\1/' || true)"

  if [[ -z "${EXPECTED_SIZE_BYTES}" || ! "${EXPECTED_SIZE_BYTES}" =~ ^[0-9]+$ || "${EXPECTED_SIZE_BYTES}" -le 0 ]]; then
    fatal "INVALID MANIFEST SCHEMA: Missing or non-positive archive.sizeBytes."
  fi

  awk '
    /"sourceFiles"[[:space:]]*:[[:space:]]*\{/ { in_sf = 1; next }
    in_sf && /\}/ { in_sf = 0; next }
    in_sf && match($0, /"[^"]+"[[:space:]]*:[[:space:]]*"[^"]+"/) {
      pair = substr($0, RSTART, RLENGTH)
      k = pair
      sub(/^"/, "", k)
      sub(/"[[:space:]]*:[[:space:]]*"[^"]+"$/, "", k)
      v = pair
      sub(/^"[^"]+"[[:space:]]*:[[:space:]]*"/, "", v)
      sub(/"$/, "", v)
      printf "%s\t%s\n", tolower(v), k
    }
  ' "${MANIFEST_FILE}" > "${SOURCE_HASHES_TSV}"

  for req_sf in "${MANDATORY_ARCHIVE_FILES[@]}"; do
    [[ "${req_sf}" == "release.json" ]] && continue
    sf_hash="$(awk -F'\t' -v target="${req_sf}" '$2 == target { print $1; exit }' "${SOURCE_HASHES_TSV}")"
    if [[ -z "${sf_hash}" || ! "${sf_hash}" =~ ^[a-f0-9]{64}$ ]]; then
      fatal "INCOMPLETE RELEASE MANIFEST: Missing valid sourceFiles SHA-256 digest for '${req_sf}'."
    fi
  done

  while IFS=$'\t' read -r _sf_h sf_k; do
    [[ -z "${sf_k}" ]] && continue
    sf_allowed=false
    for req_sf in "${MANDATORY_ARCHIVE_FILES[@]}"; do
      [[ "${req_sf}" == "release.json" ]] && continue
      if [[ "${sf_k}" == "${req_sf}" ]]; then
        sf_allowed=true
        break
      fi
    done
    if [[ "${sf_allowed}" != "true" ]]; then
      fatal "SECURITY ALERT: Manifest sourceFiles contains unexpected extra file entry: '${sf_k}'."
    fi
  done < "${SOURCE_HASHES_TSV}"
fi

if [[ -z "${RELEASE_VERSION}" || -z "${ARCHIVE_NAME}" || -z "${EXPECTED_SHA256}" ]]; then
  fatal "Invalid or incomplete manifest format in ${MANIFEST_FILE}"
fi
if [[ "${RELEASE_VERSION}" == "0.0.0" || ! "${RELEASE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  fatal "UNSUPPORTED OR INVALID VERSION in manifest: '${RELEASE_VERSION}'"
fi
if [[ "${ARCHIVE_NAME}" != "printellect-kiosk-daemon-${RELEASE_VERSION}.tar.gz" ]]; then
  fatal "INVALID MANIFEST SCHEMA: Archive filename '${ARCHIVE_NAME}' does not match release version '${RELEASE_VERSION}'."
fi
if [[ ! "${EXPECTED_SHA256}" =~ ^[a-f0-9]{64}$ ]]; then
  fatal "INVALID MANIFEST SCHEMA: Archive SHA-256 digest '${EXPECTED_SHA256}' is not a valid 64-character hex string."
fi

if [[ -n "${TARGET_VERSION}" && "${TARGET_VERSION}" != "${RELEASE_VERSION}" ]]; then
  fatal "Requested --version '${TARGET_VERSION}' does not match signed manifest version '${RELEASE_VERSION}'."
fi

log "Target Release Version : v${RELEASE_VERSION}"
log "Archive Name           : ${ARCHIVE_NAME}"
log "Expected SHA-256       : ${EXPECTED_SHA256}"

# Fetch archive into isolated temp dir before touching any installed files
ARCHIVE_FILE="${TEMP_DIR}/${ARCHIVE_NAME}"
if [[ -n "${LOCAL_RELEASE_DIR}" ]]; then
  if [[ ! -f "${LOCAL_RELEASE_DIR}/${ARCHIVE_NAME}" ]]; then
    fatal "Archive ${ARCHIVE_NAME} not found in ${LOCAL_RELEASE_DIR}"
  fi
  cp "${LOCAL_RELEASE_DIR}/${ARCHIVE_NAME}" "${ARCHIVE_FILE}"
else
  log "Downloading ${ARCHIVE_NAME}..."
  curl -fsSL --connect-timeout 15 --max-time 300 "${RELEASE_URL}/${ARCHIVE_NAME}" -o "${ARCHIVE_FILE}" \
    || fatal "Failed to download ${ARCHIVE_NAME}"
fi

# 9. Verify Archive Size & SHA-256 Checksum
if [[ "${EXPECTED_SIZE_BYTES}" =~ ^[0-9]+$ && "${EXPECTED_SIZE_BYTES}" -gt 0 ]]; then
  ACTUAL_SIZE_BYTES="$(wc -c < "${ARCHIVE_FILE}" | tr -d '[:space:]')"
  if [[ "${ACTUAL_SIZE_BYTES}" != "${EXPECTED_SIZE_BYTES}" ]]; then
    fatal "ARCHIVE SIZE MISMATCH! Expected ${EXPECTED_SIZE_BYTES} bytes, got ${ACTUAL_SIZE_BYTES} bytes."
  fi
fi

log "Verifying archive SHA-256 checksum..."
ACTUAL_SHA256="$(sha256sum "${ARCHIVE_FILE}" | awk '{print tolower($1)}')"
if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  fatal "CHECKSUM MISMATCH! Expected ${EXPECTED_SHA256}, got ${ACTUAL_SHA256}"
fi
log "✓ Archive SHA-256 checksum MATCHES."

# 10. Archive Security, Link Rejection & Strict Allowlist Inspection
log "Inspecting archive headers, paths, and mandatory file allowlist..."
TAR_VERBOSE_LIST="$(tar -tvf "${ARCHIVE_FILE}")" || fatal "Corrupted tar.gz archive: unable to list headers."
while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  type_char="${line:0:1}"
  if [[ "${type_char}" == "l" || "${type_char}" == "h" || "${type_char}" == "c" || "${type_char}" == "b" || "${type_char}" == "p" || "${type_char}" == "s" ]] \
     || [[ "${line}" == *" link to "* ]] || [[ "${line}" == *" -> "* ]]; then
    fatal "SECURITY ALERT: Archive contains forbidden link or special file entry: '${line}'"
  fi
done <<< "${TAR_VERBOSE_LIST}"

ARCHIVE_ENTRIES="$(tar -tzf "${ARCHIVE_FILE}")" || fatal "Corrupted tar.gz archive: unable to read entries."
SEEN_FILES_FILE="${TEMP_DIR}/seen-archive-files.txt"
: > "${SEEN_FILES_FILE}"

while IFS= read -r entry; do
  [[ -z "${entry}" ]] && continue
  if [[ "${entry}" =~ ^/ || "${entry}" == *"\\"* || "${entry}" =~ ^[A-Za-z]: || "${entry}" == *".."* ]]; then
    fatal "SECURITY ALERT: Archive contains unsafe path entry: '${entry}'"
  fi
  if [[ "${entry}" =~ (config\.json|\.env|\.git|\.pem|node_modules|\.keys|\.bak|(^|/)test(/|$)) ]]; then
    fatal "SECURITY ALERT: Archive contains forbidden file: '${entry}'"
  fi

  norm_entry="${entry#./}"
  if [[ -z "${norm_entry}" || "${entry}" == "." || "${entry}" == "./" || "${norm_entry}" == */ ]]; then
    dir_clean="${norm_entry%/}"
    [[ -z "${dir_clean}" ]] && dir_clean="."
    case "${dir_clean}" in
      .|bin|scripts|systemd)
        continue
        ;;
      *)
        fatal "SECURITY ALERT: Archive contains unexpected extra directory: '${entry}'"
        ;;
    esac
  fi

  if grep -qxF "${norm_entry}" "${SEEN_FILES_FILE}"; then
    fatal "SECURITY ALERT: Archive contains duplicate file entry: '${norm_entry}'"
  fi

  is_allowed=false
  for allowed_f in "${MANDATORY_ARCHIVE_FILES[@]}"; do
    if [[ "${norm_entry}" == "${allowed_f}" ]]; then
      is_allowed=true
      break
    fi
  done
  if [[ "${is_allowed}" != "true" ]]; then
    fatal "SECURITY ALERT: Archive contains unexpected extra file: '${norm_entry}'"
  fi

  printf '%s\n' "${norm_entry}" >> "${SEEN_FILES_FILE}"
done <<< "${ARCHIVE_ENTRIES}"

for req_entry in "${MANDATORY_ARCHIVE_FILES[@]}"; do
  if ! grep -qxF "${req_entry}" "${SEEN_FILES_FILE}"; then
    fatal "INCOMPLETE RELEASE ARCHIVE: Mandatory file '${req_entry}' is missing from ${ARCHIVE_NAME}."
  fi
done

# Extract into isolated temp verification dir to verify per-file SHA-256 digests against signed manifest
VERIFY_EXTRACT_DIR="${TEMP_DIR}/verify-extract"
mkdir -p "${VERIFY_EXTRACT_DIR}"
tar -xzf "${ARCHIVE_FILE}" -C "${VERIFY_EXTRACT_DIR}" --no-same-owner --no-same-permissions \
  || fatal "Archive extraction failed during integrity verification."

if [[ -n "$(find "${VERIFY_EXTRACT_DIR}" -type l 2>/dev/null || true)" ]]; then
  fatal "SECURITY ALERT: Extracted archive contains a symbolic link."
fi

if [[ ! -s "${SOURCE_HASHES_TSV}" ]]; then
  fatal "INVALID MANIFEST SCHEMA: Per-file sourceFiles hash table is empty."
fi

while IFS=$'\t' read -r exp_file_hash rel_file_path; do
  [[ -z "${rel_file_path}" ]] && continue
  extracted_target="${VERIFY_EXTRACT_DIR}/${rel_file_path}"
  if [[ ! -f "${extracted_target}" || -L "${extracted_target}" ]]; then
    fatal "INCOMPLETE RELEASE ARCHIVE: Missing regular file '${rel_file_path}' after extraction."
  fi
  act_file_hash="$(sha256sum "${extracted_target}" | awk '{print tolower($1)}')"
  if [[ "${act_file_hash}" != "${exp_file_hash}" ]]; then
    fatal "ARCHIVE INTEGRITY MISMATCH: File '${rel_file_path}' SHA-256 (${act_file_hash}) differs from signed manifest (${exp_file_hash})."
  fi
done < "${SOURCE_HASHES_TSV}"

log "✓ Archive safety, per-file SHA-256 integrity, and completeness validation passed (${#MANDATORY_ARCHIVE_FILES[@]} mandatory files verified)."

if [[ "${DRY_RUN}" == "true" ]]; then
  echo ""
  echo "========================================================"
  echo "   DRY RUN VALIDATION SUCCEEDED                         "
  echo "========================================================"
  log "All prerequisites, signatures, checksums, archive completeness,"
  log "per-file digests, and security boundaries verified successfully."
  log "No live services, configurations, or backups were modified."
  echo "========================================================"
  exit 0
fi

# 11. Create Directory Hierarchy (preserving any existing config.json and backups)
log "Provisioning directory structure..."
mkdir -p "${RELEASES_DIR}"
mkdir -p "${CONFIG_DIR}" "${CONFIG_DIR}/jobs" "${BACKUP_DIR}"
mkdir -p "${ENV_DIR}"
mkdir -p "$(dirname "${CLI_SYMLINK}")"

chmod 0755 "${BASE_DIR}" "${RELEASES_DIR}"
if getent group printellect >/dev/null 2>&1; then
  chown root:printellect "${ENV_DIR}" >/dev/null 2>&1 || true
  chmod 0750 "${ENV_DIR}"
else
  chmod 0750 "${ENV_DIR}"
fi
if id -u printellect >/dev/null 2>&1; then
  chown printellect:printellect "${CONFIG_DIR}" >/dev/null 2>&1 || true
  chmod 0750 "${CONFIG_DIR}"
  chmod 0750 "${CONFIG_DIR}/jobs" >/dev/null 2>&1 || true
  if [[ -f "${CONFIG_FILE}" ]]; then
    chown printellect:printellect "${CONFIG_FILE}" >/dev/null 2>&1 || true
    chmod 0640 "${CONFIG_FILE}" >/dev/null 2>&1 || true
  fi
else
  chmod 0750 "${CONFIG_DIR}"
  chmod 0750 "${CONFIG_DIR}/jobs" >/dev/null 2>&1 || true
fi
chmod 0700 "${BACKUP_DIR}"

# 12. Extract and Activate Release Atomically (preserving previous working release on failure)
TARGET_RELEASE_DIR="${RELEASES_DIR}/${RELEASE_VERSION}"
STAGE_DIR="${RELEASES_DIR}/.stage-${RELEASE_VERSION}-$$"
mkdir -p "${STAGE_DIR}"
log "Staging verified release v${RELEASE_VERSION}..."
tar -xzf "${ARCHIVE_FILE}" -C "${STAGE_DIR}" --no-same-owner --no-same-permissions

if [[ "${SKIP_NPM_CI}" == "true" ]]; then
  warn "Skipping 'npm ci --omit=dev' (--skip-npm-ci enabled)."
else
  log "Installing production dependencies (npm ci --omit=dev)..."
  (cd "${STAGE_DIR}" && npm ci --omit=dev)
fi

for exec_rel in \
  "bin/printellect-setup" \
  "scripts/install-service.sh" \
  "scripts/recover-migration.sh" \
  "scripts/stage-node-runtime.sh" \
  "scripts/validate-legacy-node24.sh" \
  "scripts/verify-print-acceptance.js"; do
  if [[ -f "${STAGE_DIR}/${exec_rel}" ]]; then
    chmod 0755 "${STAGE_DIR}/${exec_rel}"
  fi
done
chown -R root:root "${STAGE_DIR}" >/dev/null 2>&1 || true

log "Activating release into ${TARGET_RELEASE_DIR}..."
if [[ -d "${TARGET_RELEASE_DIR}" ]]; then
  PREV_RELEASE_BACKUP="${RELEASES_DIR}/.prev-${RELEASE_VERSION}-$$"
  mv "${TARGET_RELEASE_DIR}" "${PREV_RELEASE_BACKUP}"
fi
mv "${STAGE_DIR}" "${TARGET_RELEASE_DIR}"
STAGE_DIR=""
if [[ -n "${PREV_RELEASE_BACKUP}" && -d "${PREV_RELEASE_BACKUP}" ]]; then
  rm -rf "${PREV_RELEASE_BACKUP}"
  PREV_RELEASE_BACKUP=""
fi

# 13. Update Atomic Symlink to Current Release
log "Updating ${CURRENT_LINK} symlink..."
ln -sfn "releases/${RELEASE_VERSION}" "${BASE_DIR}/current.tmp"
if ! mv -Tf "${BASE_DIR}/current.tmp" "${CURRENT_LINK}" 2>/dev/null; then
  rm -rf "${CURRENT_LINK}"
  ln -sfn "releases/${RELEASE_VERSION}" "${CURRENT_LINK}"
  rm -rf "${BASE_DIR}/current.tmp"
fi

# 14. Symlink CLI
log "Linking CLI to ${CLI_SYMLINK}..."
if [[ -n "${ROOT_DIR}" ]]; then
  ln -sfn "../../opt/printellect/current/bin/printellect-setup" "${CLI_SYMLINK}"
else
  ln -sfn "/opt/printellect/current/bin/printellect-setup" "${CLI_SYMLINK}"
fi

# 15. Write Kiosk Environment Configuration Atomically (printf under umask 077; never follows destination symlinks)
log "Writing kiosk environment to ${ENV_FILE} (session fingerprint: $(mask_token "${SESSION_ID}"))..."
ENV_TMP="${ENV_FILE}.tmp.$$"
(
  umask 077
  {
    printf '# PRINTELLECT Kiosk Environment Configuration\n'
    printf '# Generated by bootstrap installer on %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    printf 'KIOSK_SESSION_ID="%s"\n' "${SESSION_ID}"
    printf 'PRINTELLECT_CONFIG_PATH="%s"\n' "${LOGICAL_CONFIG_FILE}"
    printf 'NODE_ENV="production"\n'
  } > "${ENV_TMP}"
)
if getent group printellect >/dev/null 2>&1; then
  chown root:printellect "${ENV_TMP}" >/dev/null 2>&1 || true
  chmod 0640 "${ENV_TMP}"
else
  chown root:root "${ENV_TMP}" >/dev/null 2>&1 || true
  chmod 0600 "${ENV_TMP}"
fi
mv -f "${ENV_TMP}" "${ENV_FILE}"

# 16. Printer Configuration Management (never overwrite existing config.json or delete backups)
log "Checking printer configuration..."
if [[ -f "${CONFIG_FILE}" ]]; then
  log "Found existing printer configuration at ${CONFIG_FILE} (Preserved unmodified)."
else
  MIGRATED=false
  if [[ -z "${ROOT_DIR}" ]]; then
    LEGACY_PATHS=("/home/pi/config.json" "/home/pi/printellect-kiosk-daemon/config.json" "./config.json")
    for leg_path in "${LEGACY_PATHS[@]}"; do
      if [[ -f "${leg_path}" ]]; then
        log "Found legacy configuration at ${leg_path}. Copying to ${CONFIG_FILE} (original preserved)..."
        CFG_TMP="${CONFIG_FILE}.tmp.$$"
        cp -L "${leg_path}" "${CFG_TMP}"
        chmod 0644 "${CFG_TMP}"
        mv -f "${CFG_TMP}" "${CONFIG_FILE}"
        MIGRATED=true
        break
      fi
    done
  fi

  if [[ "${MIGRATED}" != "true" ]]; then
    if [[ "${SKIP_PRINTER_SETUP}" != "true" && -z "${ROOT_DIR}" && -t 0 ]]; then
      log "Launching printer configuration wizard..."
      "${ACTIVE_NODE_CMD:-node}" "${CURRENT_LINK}/setup.js" || warn "Setup wizard did not complete. You can run 'sudo printellect-setup' later."
    else
      warn "No printer configuration found at ${CONFIG_FILE}. It will be migrated from the legacy service workdir during install-service.sh or configured via 'sudo printellect-setup'."
    fi
  fi
fi

echo ""
echo "========================================================"
echo "   PRINTELLECT KIOSK BOOTSTRAP INSTALLATION COMPLETE   "
echo "========================================================"
echo "Installed Version : v${RELEASE_VERSION}"
echo "Current Release   : ${CURRENT_LINK} -> releases/${RELEASE_VERSION}"
echo "Kiosk Session ID  : $(mask_token "${SESSION_ID}")"
echo "Environment File  : ${ENV_FILE}"
echo "Printer Config    : ${CONFIG_FILE}"
echo "Setup CLI Tool    : ${CLI_SYMLINK}"
echo "Service Cutover   : NOT EXECUTED (run install-service.sh separately after validation)"
echo "========================================================"
echo ""
log "Bootstrap staging completed successfully (live services untouched)."
exit 0
