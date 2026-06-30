#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/deck-audio-play.sh <audioJobId>" >&2
  exit 2
fi

JOB_ID="$1"
if [[ ! "$JOB_ID" =~ ^audio_job_[a-f0-9]{24}$ ]]; then
  echo "Invalid audio job id" >&2
  exit 2
fi

AUDIO_DIR="${HOME}/Library/Application Support/CodexQuotaDashboard/deck/audio"
WAV_FILE="${AUDIO_DIR}/${JOB_ID}.wav"

if [[ ! -f "$WAV_FILE" ]]; then
  echo "Audio WAV not found: ${JOB_ID}" >&2
  exit 1
fi

if ! command -v afplay >/dev/null 2>&1; then
  echo "afplay is not available. WAV path:"
  echo "$WAV_FILE"
  exit 1
fi

afplay "$WAV_FILE"
