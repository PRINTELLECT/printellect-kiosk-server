#!/usr/bin/env bash

# ==============================================================================
# PRINTELLECT Kiosk Server — Standalone Migration Crash & Boot Recovery Entrypoint
#
# Reconciles an interrupted in-progress systemd service cutover (e.g. after
# sudden power loss, kernel panic, or SIGKILL) or executes deterministic
# operator rollback from persisted /etc/printellect/migration.json and
# permanent backups in /var/lib/printellect/backups/.
#
# Design:
#   - During cutover, arm_boot_recovery_unit() installs a standalone copy of
#     the full recovery engine at /etc/printellect/recover-migration.sh (0700)
#     invoked by printellect-migration-recover.service Before=printellect.service
#     and Before=<legacy-unit>.service.
#   - When invoked directly from the repository or /opt/printellect/current/scripts,
#     this entrypoint validates recovery flags and delegates atomically to the
#     colocated install-service.sh (or /etc/printellect/recover-migration.sh),
#     defaulting to --reconcile-boot when no explicit action flag is supplied.
# ==============================================================================

set -euo pipefail

SCRIPT_VERSION="1.0.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_PATH="${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]}")"

print_usage() {
  cat <<EOF
PRINTELLECT Kiosk Server — Migration Crash & Boot Recovery v${SCRIPT_VERSION}

Usage:
  sudo bash recover-migration.sh [OPTIONS]

Actions (defaults to --reconcile-boot if omitted):
  --reconcile-boot               Idempotently reconcile an interrupted 'in_progress' migration
  --rollback                     Force rollback to the backed-up legacy service configuration

Options:
  --non-blocking-start           Use 'systemctl start --no-block' when starting restored legacy unit
  --lock-timeout <SEC>           Max seconds to wait for exclusive migration flock (0=immediate, default: 60)
  --root-dir <PATH>              Prefix filesystem operations for isolated non-root testing
  --dry-run                      Simulate recovery decisions without mutating systemd or files
  -h, --help                     Show this help message
EOF
}

HAS_ACTION=false
ROOT_DIR_ARG=""
FORWARD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reconcile-boot|--rollback)
      HAS_ACTION=true
      FORWARD_ARGS+=("$1")
      shift
      ;;
    --non-blocking-start|--dry-run)
      FORWARD_ARGS+=("$1")
      shift
      ;;
    --lock-timeout)
      if [[ $# -lt 2 ]]; then
        echo "[FATAL ERROR] --lock-timeout requires a non-negative integer argument." >&2
        exit 1
      fi
      FORWARD_ARGS+=("$1" "$2")
      shift 2
      ;;
    --root-dir)
      if [[ $# -lt 2 ]]; then
        echo "[FATAL ERROR] --root-dir requires a directory path argument." >&2
        exit 1
      fi
      ROOT_DIR_ARG="${2%/}"
      FORWARD_ARGS+=("$1" "$2")
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown recovery option: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

if [[ "${HAS_ACTION}" != "true" ]]; then
  FORWARD_ARGS=("--reconcile-boot" "${FORWARD_ARGS[@]}")
fi

CANDIDATE_COLOCATED="${SCRIPT_DIR}/install-service.sh"
CANDIDATE_ETC="${ROOT_DIR_ARG}/etc/printellect/recover-migration.sh"

if [[ -f "${CANDIDATE_COLOCATED}" && ! "${CANDIDATE_COLOCATED}" -ef "${SELF_PATH}" ]]; then
  exec bash "${CANDIDATE_COLOCATED}" "${FORWARD_ARGS[@]}"
elif [[ -f "${CANDIDATE_ETC}" && ! "${CANDIDATE_ETC}" -ef "${SELF_PATH}" ]]; then
  exec bash "${CANDIDATE_ETC}" "${FORWARD_ARGS[@]}"
else
  echo "[FATAL ERROR] Recovery engine not found at ${CANDIDATE_COLOCATED} or ${CANDIDATE_ETC}." >&2
  exit 1
fi

