# shellcheck shell=zsh
# Git hooks (IDE, GUI clients) often run with a minimal PATH. Load Node/nvm and
# global npm bins before hook scripts run.

# Repo root when sourced from .husky/* or scripts/*
if [[ -z "${REPO_ROOT:-}" ]]; then
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$REPO_ROOT" || exit 1

export PATH="${REPO_ROOT}/node_modules/.bin:${PATH}"

# Global npm CLI tools
if command -v npm >/dev/null 2>&1; then
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  if [[ -n "$npm_prefix" && -d "${npm_prefix}/bin" ]]; then
    export PATH="${npm_prefix}/bin:${PATH}"
  fi
fi

if command -v node >/dev/null 2>&1; then
  return 0
fi

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "${NVM_DIR}/nvm.sh"
  if [[ -f .nvmrc ]]; then
    nvm use >/dev/null 2>&1 || true
  fi
fi

if command -v node >/dev/null 2>&1; then
  return 0
fi

# Last resort: pick a compatible Node from nvm (22.13+ per package.json engines).
if [[ -d "${NVM_DIR}/versions/node" ]]; then
  for version_dir in \
    "${NVM_DIR}/versions/node"/v22.*(N) \
    "${NVM_DIR}/versions/node"/v24.*(N) \
    "${NVM_DIR}/versions/node"/v23.*(N); do
    node_bin="${version_dir}/bin"
    if [[ -x "${node_bin}/node" ]]; then
      export PATH="${node_bin}:${PATH}"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "husky: node not found in PATH." >&2
  echo "Install Node 22+ (see package.json engines) or load nvm before committing." >&2
  return 1
fi

return 0
