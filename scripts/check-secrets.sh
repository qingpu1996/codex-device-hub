#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files --error-unmatch include/secrets.h >/dev/null 2>&1; then
    echo "include/secrets.h is tracked by Git; remove it from the index before flashing." >&2
    exit 1
  fi
fi

if [[ ! -f include/secrets.h ]]; then
  echo "secrets ok: include/secrets.h absent; device will use the setup portal"
  exit 0
fi

if ! git check-ignore -q include/secrets.h 2>/dev/null; then
  echo "include/secrets.h exists but is not ignored by Git." >&2
  exit 1
fi

echo "secrets ok: include/secrets.h is ignored"
