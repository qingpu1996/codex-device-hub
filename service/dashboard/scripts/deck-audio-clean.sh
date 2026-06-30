#!/bin/bash
set -euo pipefail

AUDIO_DIR="${HOME}/Library/Application Support/CodexQuotaDashboard/deck/audio"
DAYS="${1:-30}"

if [[ ! "$DAYS" =~ ^[0-9]+$ ]] || [[ "$DAYS" -lt 1 ]]; then
  echo "Usage: scripts/deck-audio-clean.sh [days]" >&2
  exit 2
fi

if [[ ! -d "$AUDIO_DIR" ]]; then
  echo "No Deck audio directory yet."
  exit 0
fi

mapfile -t FILES < <(find "$AUDIO_DIR" -type f \( -name 'audio_job_*.wav' -o -name 'audio_job_*.json' \) -mtime +"$DAYS" | sort)

if [[ "${#FILES[@]}" -eq 0 ]]; then
  echo "No Deck audio files older than ${DAYS} days."
  exit 0
fi

printf 'Files older than %s days:\n' "$DAYS"
printf '%s\n' "${FILES[@]}"
printf 'Delete these files? Type DELETE to continue: '
read -r CONFIRM

if [[ "$CONFIRM" != "DELETE" ]]; then
  echo "Aborted."
  exit 0
fi

rm -f "${FILES[@]}"
echo "Deleted ${#FILES[@]} files."
