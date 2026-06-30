#!/usr/bin/env bash
set -euo pipefail

ENV_NAME="${1:-waveshare_deck_349}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/.pio/build/${ENV_NAME}"
ELF="${BUILD_DIR}/firmware.elf"
BIN="${BUILD_DIR}/firmware.bin"

find_tool() {
  local name="$1"
  local local_tool="${ROOT_DIR}/.pio/packages/toolchain-xtensa-esp-elf/bin/${name}"
  if [[ -x "${local_tool}" ]]; then
    printf "%s\n" "${local_tool}"
    return 0
  fi
  if command -v "${name}" >/dev/null 2>&1; then
    command -v "${name}"
    return 0
  fi
  return 1
}

cd "${ROOT_DIR}"

echo "== Build for ${ENV_NAME} =="
pio run -e "${ENV_NAME}"

echo
echo "== PlatformIO size for ${ENV_NAME} =="
pio run -e "${ENV_NAME}" -t size -v

if [[ ! -f "${ELF}" ]]; then
  echo "Missing ELF: ${ELF}" >&2
  exit 1
fi

echo
echo "== firmware.bin =="
if [[ -f "${BIN}" ]]; then
  ls -lh "${BIN}"
  stat -f "%z bytes" "${BIN}" 2>/dev/null || stat -c "%s bytes" "${BIN}"
else
  echo "Missing BIN: ${BIN}" >&2
fi

echo
echo "== Section sizes =="
if SIZE_TOOL="$(find_tool xtensa-esp32s3-elf-size)"; then
  "${SIZE_TOOL}" -A "${ELF}" | sort -k2 -nr | head -80
else
  echo "xtensa-esp32s3-elf-size not found in PATH or .pio/packages"
fi

echo
echo "== Largest symbols =="
if NM_TOOL="$(find_tool xtensa-esp32s3-elf-nm)"; then
  "${NM_TOOL}" -S --size-sort -C "${ELF}" | tail -120 | awk '{ lines[NR] = $0 } END { for (i = NR; i >= 1; i--) print lines[i] }'
else
  echo "xtensa-esp32s3-elf-nm not found in PATH or .pio/packages"
fi
