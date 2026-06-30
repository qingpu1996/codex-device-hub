#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_NAME="${1:-waveshare_deck_349}"

cd "$PROJECT_DIR"
echo "Building Waveshare Codex Deck firmware"
echo "env=${ENV_NAME}"
echo "hardware_variant=V${DECK_HARDWARE_VARIANT:-2}"
echo "screen=172x640"
echo "psram=opi"
pio run -e "${ENV_NAME}"
pio run -e "${ENV_NAME}" -t size
