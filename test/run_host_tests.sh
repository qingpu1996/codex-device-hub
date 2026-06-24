#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ARDUINOJSON_DIR="${ARDUINOJSON_DIR:-.pio/libdeps/reterminal_e1002/ArduinoJson/src}"
if [[ ! -d "$ARDUINOJSON_DIR" ]]; then
  echo "ArduinoJson headers not found at $ARDUINOJSON_DIR. Run scripts/build.sh first." >&2
  exit 1
fi

c++ -std=c++17 \
  -DQUOTA_HOST_TEST \
  -I src \
  -I include \
  -I "$ARDUINOJSON_DIR" \
  src/input_manager.cpp \
  src/page_manager.cpp \
  src/provisioning.cpp \
  src/quota_client.cpp \
  test/firmware_logic_tests.cpp \
  -o /tmp/codex-quota-e1002-firmware-tests

/tmp/codex-quota-e1002-firmware-tests

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files --error-unmatch include/secrets.h >/dev/null 2>&1; then
    echo "include/secrets.h is tracked by Git" >&2
    exit 1
  fi
else
  echo "secrets git tracking check skipped: not a git repo"
fi
