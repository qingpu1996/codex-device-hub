#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/deck-audio-info.sh <audioJobId>" >&2
  exit 2
fi

JOB_ID="$1"
if [[ ! "$JOB_ID" =~ ^audio_job_[a-f0-9]{24}$ ]]; then
  echo "Invalid audio job id" >&2
  exit 2
fi

AUDIO_DIR="${HOME}/Library/Application Support/CodexQuotaDashboard/deck/audio"
METADATA_FILE="${AUDIO_DIR}/${JOB_ID}.json"

if [[ ! -f "$METADATA_FILE" ]]; then
  echo "Audio metadata not found: ${JOB_ID}" >&2
  exit 1
fi

node - "$METADATA_FILE" <<'NODE'
const fs = require("node:fs");
const metadata = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify(metadata, null, 2));
NODE
