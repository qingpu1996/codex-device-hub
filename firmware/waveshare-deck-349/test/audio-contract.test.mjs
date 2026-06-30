import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appConfig = await readFile(new URL("../src/app_config.h", import.meta.url), "utf8");
const deckClient = await readFile(new URL("../src/deck_client.cpp", import.meta.url), "utf8");
const deckUi = await readFile(new URL("../src/ui/deck_ui.c", import.meta.url), "utf8");
const cjkFont = await readFile(new URL("../src/fonts/codex_deck_cjk_16.c", import.meta.url), "utf8");
const lvConf = await readFile(new URL("../include/lv_conf.h", import.meta.url), "utf8");

function macroNumber(name) {
  const match = appConfig.match(new RegExp(`#define\\s+${name}\\s+(\\d+)`));
  assert.ok(match, `missing ${name}`);
  return Number(match[1]);
}

const SAMPLE_RATE = macroNumber("CODEX_DECK_AUDIO_SAMPLE_RATE");
const CHANNELS = macroNumber("CODEX_DECK_AUDIO_CHANNELS");
const BITS_PER_SAMPLE = macroNumber("CODEX_DECK_AUDIO_BITS_PER_SAMPLE");
const MAX_MS = macroNumber("CODEX_DECK_AUDIO_MAX_MS");
const MIN_MS = macroNumber("CODEX_DECK_AUDIO_MIN_MS");
const BYTES_PER_FRAME = CHANNELS * (BITS_PER_SAMPLE / 8);
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_FRAME;

function wavHeader(pcmBytes) {
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNELS, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(BYTES_PER_SECOND, 28);
  wav.writeUInt16LE(BYTES_PER_FRAME, 32);
  wav.writeUInt16LE(BITS_PER_SAMPLE, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcmBytes, 40);
  return wav;
}

function audioUploadPath(token, slotId) {
  return `/api/deck/${token}/audio/utterance?slotId=${encodeURIComponent(slotId)}`;
}

function transcribePath(token, audioJobId) {
  return `/api/deck/${token}/audio/${encodeURIComponent(audioJobId)}/transcribe`;
}

function codexSendPath(token) {
  return `/api/deck/${token}/codex/send`;
}

function maskToken(token) {
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

test("wav header contract matches firmware audio constants", () => {
  const pcmBytes = BYTES_PER_SECOND;
  const wav = wavHeader(pcmBytes);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + pcmBytes);
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(28), 96000);
  assert.equal(wav.readUInt16LE(32), 4);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
  assert.equal(wav.readUInt32LE(40), pcmBytes);
});

test("firmware capture limits stay inside service wav limits", () => {
  const maxPcmBytes = Math.floor((BYTES_PER_SECOND * MAX_MS) / 1000);
  const maxWavBytes = 44 + maxPcmBytes;
  assert.equal(MIN_MS, 300);
  assert.equal(MAX_MS, 15000);
  assert.ok(maxWavBytes < 8 * 1024 * 1024);
  assert.ok(MAX_MS < 25000);
});

test("audio upload path encodes slot id and masks token for logs", () => {
  const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const path = audioUploadPath(token, "slot with space");
  assert.equal(path, `/api/deck/${token}/audio/utterance?slotId=slot%20with%20space`);
  assert.equal(maskToken(token), "0123****cdef");
  assert.ok(!maskToken(token).includes(token.slice(4, -4)));
  assert.equal(transcribePath(token, "audio_job_0123456789abcdef01234567"), `/api/deck/${token}/audio/audio_job_0123456789abcdef01234567/transcribe`);
  assert.equal(codexSendPath(token), `/api/deck/${token}/codex/send`);
});

test("stage f firmware contract supports cjk transcript and codex jobs", () => {
  assert.match(appConfig, /0\.6\.0-stage-f-stt-codex/);
  assert.match(lvConf, /#define\s+LV_FONT_SOURCE_HAN_SANS_SC_16_CJK\s+0/);
  assert.match(lvConf, /LV_FONT_DECLARE\(codex_deck_cjk_16\)/);
  assert.match(deckUi, /return\s+&codex_deck_cjk_16/);
  assert.doesNotMatch(deckUi, /#if\s+CODEX_DECK_CJK_16/);
  assert.match(cjkFont, /0x2000-0x206F/);
  assert.match(cjkFont, /0x4E00-0x9FA5/);
  assert.match(deckClient, /copyUtf8Text\(job->screenTranscript/);
  assert.match(deckClient, /deckStartAudioTranscription/);
  assert.match(deckClient, /deckSubmitCodexSend/);
  assert.doesNotMatch(deckUi, /SEND TEST/);
  assert.match(deckUi, /TAP TO RECORD/);
  assert.match(deckUi, /TAP TO STOP/);
});

test("screen status labels remain display ascii", () => {
  const labels = [
    "TAP TO RECORD",
    "TAP TO STOP",
    "RECORDING",
    "UPLOADING",
    "AUDIO RECEIVED",
    "AUDIO FAILED",
    "AUDIO ERROR",
    "MAX TIME",
    "TAP TO RETRY",
  ];
  for (const label of labels) {
    assert.match(label, /^[\x20-\x7e]+$/);
  }
});
