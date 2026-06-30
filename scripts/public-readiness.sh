#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "public readiness check must run inside a Git worktree" >&2
  exit 1
fi

tracked_forbidden=(
  "firmware/e1002/include/secrets.h"
  "firmware/e1002/.local/features.env"
  "firmware/waveshare-deck-349/include/secrets.h"
  "firmware/waveshare-deck-349/.local/config.json"
  "service/dashboard/config.json"
  "service/dashboard/cache.json"
  ".env"
)

failed=0
for path in "${tracked_forbidden[@]}"; do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "forbidden tracked file: $path" >&2
    failed=1
  fi
done

if git ls-files | grep -E '(^|/)(node_modules|dist|\.pio|\.local)(/|$)' >/dev/null; then
  echo "generated or local build output is tracked:" >&2
  git ls-files | grep -E '(^|/)(node_modules|dist|\.pio|\.local)(/|$)' >&2
  failed=1
fi

if git grep -nI -E 'sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{20,}|api/device/[0-9a-f]{32,}|api/deck/[0-9a-f]{32,}|admin/[0-9a-f]{32,}|/Users/nihplod' -- . ':!scripts/public-readiness.sh' ':!service/dashboard/package-lock.json' ':!README.md' ':!service/dashboard/README.md' ':!firmware/e1002/README.md' ':!firmware/waveshare-deck-349/README.md' >/tmp/codex-e1002-secret-scan.txt; then
  echo "potential secret or machine-local value in tracked source:" >&2
  cat /tmp/codex-e1002-secret-scan.txt >&2
  failed=1
fi
rm -f /tmp/codex-e1002-secret-scan.txt

if ! git check-ignore -q firmware/e1002/include/secrets.h; then
  echo "firmware/e1002/include/secrets.h is not ignored" >&2
  failed=1
fi

if ! git check-ignore -q firmware/e1002/.local/features.env; then
  echo "firmware/e1002/.local/features.env is not ignored" >&2
  failed=1
fi

if ! git check-ignore -q firmware/waveshare-deck-349/include/secrets.h; then
  echo "firmware/waveshare-deck-349/include/secrets.h is not ignored" >&2
  failed=1
fi

if ! git check-ignore -q firmware/waveshare-deck-349/.local/config.json; then
  echo "firmware/waveshare-deck-349/.local/config.json is not ignored" >&2
  failed=1
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo "public readiness check passed"
