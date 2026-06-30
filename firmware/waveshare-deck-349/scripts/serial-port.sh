#!/bin/bash
set -euo pipefail

detect_serial_port() {
  local candidates=()
  local pattern
  for pattern in /dev/cu.usbmodem* /dev/cu.usbserial* /dev/cu.wchusbserial* /dev/cu.SLAB_USBtoUART*; do
    if compgen -G "$pattern" > /dev/null; then
      while IFS= read -r port; do
        candidates+=("$port")
      done < <(compgen -G "$pattern" | sort)
    fi
  done

  if [[ "${#candidates[@]}" -eq 0 ]]; then
    echo "No USB serial port found." >&2
    return 1
  fi

  if [[ "${#candidates[@]}" -gt 1 ]]; then
    echo "Multiple USB serial ports found; refusing to guess:" >&2
    printf '  %s\n' "${candidates[@]}" >&2
    return 1
  fi

  printf '%s\n' "${candidates[0]}"
}
