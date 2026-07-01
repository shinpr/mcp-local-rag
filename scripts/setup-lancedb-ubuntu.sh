#!/usr/bin/env bash
# Run on the Ubuntu server to create the LanceDB data directory and permissions.
# Usage: ./scripts/setup-lancedb-ubuntu.sh
# Optional env overrides: LANCEDB_DATA_DIR, LANCEDB_OWNER

set -euo pipefail

DATA_DIR="${LANCEDB_DATA_DIR:-/var/lib/mcp-local-rag/lancedb}"
OWNER_USER="${LANCEDB_OWNER:-${SUDO_USER:-$USER}}"
PARENT_DIR="$(dirname "$DATA_DIR")"

echo "==> LanceDB server setup"
echo "    Data directory: $DATA_DIR"
echo "    Owner:          $OWNER_USER"

if [[ ! -d "$PARENT_DIR" ]]; then
  echo "==> Creating $PARENT_DIR"
  sudo mkdir -p "$PARENT_DIR"
fi

sudo mkdir -p "$DATA_DIR/uploads"
sudo chown -R "$OWNER_USER:$OWNER_USER" "$PARENT_DIR"
chmod 755 "$PARENT_DIR"
chmod 750 "$DATA_DIR"

echo ""
echo "==> Done. Add these lines to .env on this server:"
echo "    LANCEDB_HOST_PATH=$DATA_DIR"
echo ""
echo "Docker Compose bind-mounts that path into the API container at /app/lancedb."
echo "Uploaded files are stored under $DATA_DIR/uploads/ (same tree as local dev)."
