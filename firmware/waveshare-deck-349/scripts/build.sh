#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"
echo "Building Waveshare Codex Deck firmware"
echo "hardware_variant=V${DECK_HARDWARE_VARIANT:-2}"
echo "screen=172x640"
echo "psram=opi"
pio run
pio run -t size
