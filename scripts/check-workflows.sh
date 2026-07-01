#!/usr/bin/env zsh

set -euo pipefail

echo "=== Workflow checks (yamllint or act -n) ==="

if command -v yamllint >/dev/null 2>&1; then
  setopt local_options null_glob
  workflow_files=(.github/workflows/*.yml .github/workflows/*.yaml)

  if (( ${#workflow_files[@]} == 0 )); then
    echo "No workflow files found under .github/workflows"
  else
    yamllint "${workflow_files[@]}"
  fi
elif command -v act >/dev/null 2>&1; then
  act -n
else
  echo "Neither 'yamllint' nor 'act' is installed. Install one to validate workflows."
  exit 1
fi
