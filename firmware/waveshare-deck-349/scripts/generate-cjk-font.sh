#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONT_PATH=".pio/libdeps/waveshare_deck_349/lvgl/scripts/built_in_font/SourceHanSansSC-Normal.otf"
OUT_PATH="src/fonts/codex_deck_cjk_16.c"

cd "${ROOT_DIR}"

if [[ ! -f "${FONT_PATH}" ]]; then
  echo "SourceHanSansSC-Normal.otf not found. Run scripts/build.sh once to install PlatformIO libs." >&2
  exit 1
fi

mkdir -p "$(dirname "${OUT_PATH}")"

npx --yes lv_font_conv@1.5.3 \
  --bpp 1 \
  --size 16 \
  --font "${FONT_PATH}" \
  -r 0x20-0x7E,0x00A0-0x00FF,0x2000-0x206F,0x3000-0x303F,0xFF00-0xFFEF,0x4E00-0x9FA5 \
  --format lvgl \
  --lv-include lvgl.h \
  --lv-font-name codex_deck_cjk_16 \
  --force-fast-kern-format \
  --no-kerning \
  -o "${OUT_PATH}"

echo "Generated ${ROOT_DIR}/${OUT_PATH}"
