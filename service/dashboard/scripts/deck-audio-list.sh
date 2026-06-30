#!/bin/bash
set -euo pipefail

AUDIO_DIR="${HOME}/Library/Application Support/CodexQuotaDashboard/deck/audio"

node - "$AUDIO_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const audioDir = process.argv[2];
if (!fs.existsSync(audioDir)) {
  console.log("No Deck audio directory yet.");
  process.exit(0);
}

const rows = fs.readdirSync(audioDir)
  .filter((name) => /^audio_job_[a-f0-9]{24}\.json$/.test(name))
  .map((name) => {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(audioDir, name), "utf8"));
      return {
        jobId: metadata.jobId,
        slotId: metadata.slotId,
        durationMs: metadata.wav?.durationMs,
        sampleRate: metadata.wav?.sampleRate,
        channels: metadata.wav?.channels,
        bytes: metadata.bytes,
        createdAt: metadata.createdAt,
      };
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  .slice(0, 20);

if (rows.length === 0) {
  console.log("No Deck audio jobs found.");
  process.exit(0);
}

for (const row of rows) {
  const seconds = Number.isFinite(row.durationMs) ? `${(row.durationMs / 1000).toFixed(1)}s` : "--";
  const kb = Number.isFinite(row.bytes) ? `${Math.round(row.bytes / 1024)}KB` : "--";
  console.log(`${row.jobId}\t${row.slotId}\t${seconds}\t${row.sampleRate || "--"}Hz\t${row.channels || "--"}ch\t${kb}\t${row.createdAt}`);
}
NODE
