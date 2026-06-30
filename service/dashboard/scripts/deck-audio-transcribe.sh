#!/bin/bash
set -euo pipefail

FORCE=false
if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
  shift
fi

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/deck-audio-transcribe.sh [--force] <audioJobId>" >&2
  exit 2
fi

JOB_ID="$1"
if [[ ! "$JOB_ID" =~ ^audio_job_[a-f0-9]{24}$ ]]; then
  echo "Invalid audio job id" >&2
  exit 2
fi

node - "$JOB_ID" "$FORCE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const audioJobId = process.argv[2];
const force = process.argv[3] === "true";
const root = path.join(process.env.HOME, "Library", "Application Support", "CodexQuotaDashboard");
const dashboardConfig = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
const deckConfig = JSON.parse(fs.readFileSync(path.join(root, "deck", "config.json"), "utf8"));
const host = process.env.DECK_DEV_HOST || dashboardConfig.bindHost;
const port = process.env.DECK_DEV_PORT || dashboardConfig.port;
const base = `http://${host}:${port}/api/deck/${deckConfig.deckToken}`;

async function main() {
  const start = await fetch(`${base}/audio/${audioJobId}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "zh", force }),
  });
  if (start.status === 404) {
    throw new Error("audio job not found or Deck service token rejected");
  }
  if (start.status < 200 || start.status >= 300) {
    throw new Error(`transcribe request failed: HTTP ${start.status}`);
  }
  const created = await start.json();
  const jobId = created.jobId;
  const deadline = Date.now() + 180000;
  let latest = created;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/jobs/${jobId}`, { cache: "no-store" });
    if (response.status !== 200) {
      throw new Error(`job poll failed: HTTP ${response.status}`);
    }
    latest = await response.json();
    if (latest.status === "done" || latest.status === "failed") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  console.log(`sttJobId=${jobId}`);
  console.log(`status=${latest.status || created.status}`);
  if (latest.status === "done") {
    console.log("transcript:");
    console.log(latest.transcript || latest.screenTranscript || "");
    return;
  }
  console.log(`error=${latest.errorMessage || "STT did not finish"}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(String(error.message || error));
  process.exit(1);
});
NODE
