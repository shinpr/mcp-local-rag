#!/usr/bin/env bash
# Mount remote LanceDB directory over SSHFS for local dev (Postgres-style remote data).
# Usage: ./scripts/lancedb-mount.sh
# Reads LANCEDB_* / DB_HOST from .env in the project root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi

REMOTE_HOST="${LANCEDB_REMOTE_HOST:-${DB_HOST:-}}"
REMOTE_USER="${LANCEDB_REMOTE_USER:-$USER}"
REMOTE_PATH="${LANCEDB_REMOTE_PATH:-/var/lib/mcp-local-rag/lancedb}"
LOCAL_MOUNT="${LANCEDB_LOCAL_MOUNT:-./lancedb-remote}"
MOUNT_POINT="$PROJECT_ROOT/${LOCAL_MOUNT#./}"

if [[ -z "$REMOTE_HOST" ]]; then
  echo "Error: set LANCEDB_REMOTE_HOST or DB_HOST in .env" >&2
  exit 1
fi

if ! command -v sshfs &>/dev/null; then
  echo "Error: sshfs is not installed." >&2
  echo "  macOS:  brew install macfuse sshfs" >&2
  echo "  Ubuntu: sudo apt install sshfs" >&2
  exit 1
fi

mkdir -p "$MOUNT_POINT"

if mount | grep -q " on ${MOUNT_POINT} "; then
  echo "Already mounted: $MOUNT_POINT"
  exit 0
fi

SSH_TARGET="${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}"
echo "Mounting $SSH_TARGET -> $MOUNT_POINT"

sshfs "$SSH_TARGET" "$MOUNT_POINT" \
  -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,follow_symlinks,uid="$(id -u)",gid="$(id -g)"

echo ""
echo "Mounted. Update .env for local dev:"
echo "  DB_PATH=${LOCAL_MOUNT}/"
echo "  UPLOAD_DIR=${LOCAL_MOUNT}/uploads/"
echo ""
echo "Warning: do not run the API on the server and locally at the same time —"
echo "LanceDB is file-based and concurrent writers can corrupt data."
