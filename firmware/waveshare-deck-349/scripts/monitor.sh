#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/serial-port.sh"

PORT="${1:-}"
if [[ -z "$PORT" ]]; then
  PORT="$(detect_serial_port)"
fi

cd "$PROJECT_DIR"
echo "Opening serial monitor"
echo "port=$PORT"
echo "baud=115200"
pio device monitor --port "$PORT" --baud 115200
