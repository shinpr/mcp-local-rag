#!/usr/bin/env zsh

set -euo pipefail

SCRIPT_DIR="${0:a:h}"
# shellcheck disable=SC1091
. "${SCRIPT_DIR}/husky-env.sh"

echo ""
echo "=== lint-staged (biome on staged src files) ==="
pnpm exec lint-staged

echo ""
echo "=== Type-check and related pre-commit checks ==="
node scripts/precommit.mjs --from-hook
