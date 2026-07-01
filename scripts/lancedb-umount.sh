#!/usr/bin/env bash
# Unmount the SSHFS LanceDB mount created by lancedb-mount.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi

LOCAL_MOUNT="${LANCEDB_LOCAL_MOUNT:-./lancedb-remote}"
MOUNT_POINT="$PROJECT_ROOT/${LOCAL_MOUNT#./}"

if ! mount | grep -q " on ${MOUNT_POINT} "; then
  echo "Not mounted: $MOUNT_POINT"
  exit 0
fi

if command -v fusermount &>/dev/null; then
  fusermount -u "$MOUNT_POINT"
else
  umount "$MOUNT_POINT"
fi

echo "Unmounted $MOUNT_POINT"
