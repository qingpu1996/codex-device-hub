#include "deck_client.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <string.h>

static void copyText(char *dest, size_t destSize, const char *value)
{
  if (!dest || destSize == 0) {
    return;
  }
  if (!value) {
    dest[0] = '\0';
    return;
  }
  const size_t len = strlen(value);
  const size_t copyLen = len < destSize - 1 ? len : destSize - 1;
  memcpy(dest, value, copyLen);
  dest[copyLen] = '\0';
}

static size_t utf8CharLen(unsigned char ch)
{
  if (ch < 0x80) {
    return 1;
  }
  if ((ch & 0xe0) == 0xc0) {
    return 2;
  }
  if ((ch & 0xf0) == 0xe0) {
    return 3;
  }
  if ((ch & 0xf8) == 0xf0) {
    return 4;
  }
  return 0;
}

static void copyUtf8Text(char *dest, size_t destSize, const char *value)
{
  if (!dest || destSize == 0) {
    return;
  }
  dest[0] = '\0';
  if (!value) {
    return;
  }
  const unsigned char *src = reinterpret_cast<const unsigned char *>(value);
  size_t out = 0;
  while (*src && out < destSize - 1) {
    const size_t len = utf8CharLen(*src);
    if (len == 0 || out + len >= destSize) {
      break;
    }
    bool valid = true;
    for (size_t i = 1; i < len; i++) {
      if ((src[i] & 0xc0) != 0x80) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      break;
    }
    memcpy(dest + out, src, len);
    out += len;
    src += len;
  }
  dest[out] = '\0';
}

static bool isDisplayAscii(const char *value)
{
  if (!value) {
    return true;
  }
  for (const unsigned char *cursor = reinterpret_cast<const unsigned char *>(value); *cursor; cursor++) {
    if (*cursor >= 0x80) {
      return false;
    }
    if (*cursor < 0x20 && *cursor != '\n' && *cursor != '\r' && *cursor != '\t') {
      return false;
    }
  }
  return true;
}

static void copyDisplayText(char *dest, size_t destSize, const char *value, const char *fallback)
{
  if (isDisplayAscii(value)) {
    copyText(dest, destSize, value);
    return;
  }
  copyText(dest, destSize, fallback);
}

static bool isPlaceholder(const char *value)
{
  if (!value || value[0] == '\0') {
    return true;
  }
  return strstr(value, "YOUR_") != nullptr || strstr(value, "192.168.x.x") != nullptr;
}

static String deckUrl(const DeckSettings *settings, const char *path)
{
  String base = settings->hubBaseUrl;
  while (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  String url = base + "/api/deck/" + settings->deckToken;
  url += path;
  return url;
}

static String urlEncode(const char *value)
{
  static const char hex[] = "0123456789ABCDEF";
  String encoded;
  if (!value) {
    return encoded;
  }
  for (const unsigned char *cursor = reinterpret_cast<const unsigned char *>(value); *cursor; cursor++) {
    const unsigned char ch = *cursor;
    if ((ch >= 'a' && ch <= 'z') ||
        (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') ||
        ch == '-' || ch == '_' || ch == '.' || ch == '~') {
      encoded += static_cast<char>(ch);
    } else {
      encoded += '%';
      encoded += hex[(ch >> 4) & 0x0f];
      encoded += hex[ch & 0x0f];
    }
  }
  return encoded;
}

static DeckClientStatus fetchJson(const DeckSettings *settings, const char *path, JsonDocument &doc, DeckSnapshot *snapshot)
{
  if (!deckClientConfigReady(settings)) {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "not configured");
    }
    return DeckClientStatus::ConfigMissing;
  }

  HTTPClient http;
  const String url = deckUrl(settings, path);
  if (!http.begin(url)) {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "http begin failed");
    }
    return DeckClientStatus::HttpBeginFailed;
  }
  http.setTimeout(CODEX_DECK_HTTP_TIMEOUT_MS);
  http.addHeader("Accept", "application/json");

  const int code = http.GET();
  if (snapshot) {
    snapshot->httpStatus = code;
  }
  if (code != HTTP_CODE_OK) {
    if (snapshot) {
      snprintf(snapshot->error, sizeof(snapshot->error), "http %d", code);
    }
    http.end();
    return DeckClientStatus::HttpError;
  }

  const String payload = http.getString();
  http.end();

  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), error.c_str());
    }
    return DeckClientStatus::JsonError;
  }

  return DeckClientStatus::Ok;
}

static DeckClientStatus postJsonBody(const DeckSettings *settings, const char *path, const String &body, JsonDocument &doc, DeckSnapshot *snapshot)
{
  if (!deckClientConfigReady(settings)) {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "not configured");
    }
    return DeckClientStatus::ConfigMissing;
  }

  HTTPClient http;
  const String url = deckUrl(settings, path);
  if (!http.begin(url)) {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "http begin failed");
    }
    return DeckClientStatus::HttpBeginFailed;
  }
  http.setTimeout(CODEX_DECK_HTTP_TIMEOUT_MS);
  http.addHeader("Accept", "application/json");
  http.addHeader("Content-Type", "application/json");

  const int code = http.POST(body);
  if (snapshot) {
    snapshot->httpStatus = code;
  }
  if (code != HTTP_CODE_OK) {
    if (snapshot) {
      snprintf(snapshot->error, sizeof(snapshot->error), "http %d", code);
    }
    http.end();
    return DeckClientStatus::HttpError;
  }

  const String payload = http.getString();
  http.end();

  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), error.c_str());
    }
    return DeckClientStatus::JsonError;
  }

  return DeckClientStatus::Ok;
}

void deckSnapshotInit(DeckSnapshot *snapshot)
{
  if (!snapshot) {
    return;
  }
  memset(snapshot, 0, sizeof(*snapshot));
  snapshot->status = DeckClientStatus::ConfigMissing;
  snapshot->httpStatus = 0;
  copyText(snapshot->codexStatus, sizeof(snapshot->codexStatus), "--");
  copyText(snapshot->storageStatus, sizeof(snapshot->storageStatus), "--");
}

void deckJobSnapshotInit(DeckJobSnapshot *job)
{
  if (!job) {
    return;
  }
  memset(job, 0, sizeof(*job));
  copyText(job->type, sizeof(job->type), "codex");
  copyText(job->status, sizeof(job->status), "--");
}

void deckAudioUploadSnapshotInit(DeckAudioUploadSnapshot *audio)
{
  if (!audio) {
    return;
  }
  memset(audio, 0, sizeof(*audio));
  copyText(audio->status, sizeof(audio->status), "--");
}

bool deckClientConfigReady(const DeckSettings *settings)
{
  return settings &&
         settings->configured &&
         !isPlaceholder(settings->wifiSsid) &&
         !isPlaceholder(settings->hubBaseUrl) &&
         !isPlaceholder(settings->deckToken) &&
         strlen(settings->deckToken) == kDeckTokenMaxLen;
}

const char *deckClientStatusText(DeckClientStatus status)
{
  switch (status) {
    case DeckClientStatus::Ok:
      return "OK";
    case DeckClientStatus::ConfigMissing:
      return "CONFIG";
    case DeckClientStatus::WifiFailed:
      return "WIFI";
    case DeckClientStatus::HttpBeginFailed:
      return "HTTP BEGIN";
    case DeckClientStatus::HttpError:
      return "HTTP";
    case DeckClientStatus::JsonError:
      return "JSON";
    case DeckClientStatus::NoSlots:
      return "NO SLOTS";
    case DeckClientStatus::MissingJob:
      return "NO JOB";
  }
  return "ERROR";
}

DeckClientStatus deckConnectWifi(const DeckSettings *settings, DeckSnapshot *snapshot)
{
  if (!deckClientConfigReady(settings)) {
    if (snapshot) {
      snapshot->status = DeckClientStatus::ConfigMissing;
      copyText(snapshot->error, sizeof(snapshot->error), "run setup portal");
    }
    return DeckClientStatus::ConfigMissing;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(settings->wifiSsid, settings->wifiPassword);

  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < CODEX_DECK_WIFI_TIMEOUT_MS) {
    delay(250);
  }

  if (WiFi.status() != WL_CONNECTED) {
    if (snapshot) {
      snapshot->status = DeckClientStatus::WifiFailed;
      snprintf(snapshot->error, sizeof(snapshot->error), "wifi status %d", WiFi.status());
    }
    return DeckClientStatus::WifiFailed;
  }

  if (snapshot) {
    snapshot->wifiRssi = WiFi.RSSI();
    copyText(snapshot->localIp, sizeof(snapshot->localIp), WiFi.localIP().toString().c_str());
    copyText(snapshot->error, sizeof(snapshot->error), "");
  }
  return DeckClientStatus::Ok;
}

DeckClientStatus deckFetchHealth(const DeckSettings *settings, DeckSnapshot *snapshot)
{
  JsonDocument doc;
  const DeckClientStatus status = fetchJson(settings, "/health", doc, snapshot);
  if (status != DeckClientStatus::Ok) {
    if (snapshot) {
      snapshot->status = status;
    }
    return status;
  }

  if (snapshot) {
    copyText(snapshot->codexStatus, sizeof(snapshot->codexStatus), doc["codex"].as<const char *>());
    copyText(snapshot->storageStatus, sizeof(snapshot->storageStatus), doc["storage"].as<const char *>());
  }
  return DeckClientStatus::Ok;
}

DeckClientStatus deckFetchSlots(const DeckSettings *settings, DeckSnapshot *snapshot)
{
  JsonDocument doc;
  const DeckClientStatus status = fetchJson(settings, "/slots", doc, snapshot);
  if (status != DeckClientStatus::Ok) {
    if (snapshot) {
      snapshot->status = status;
    }
    return status;
  }

  JsonArrayConst slots = doc.as<JsonArrayConst>();
  if (slots.isNull() || slots.size() == 0) {
    if (snapshot) {
      snapshot->status = DeckClientStatus::NoSlots;
      copyText(snapshot->error, sizeof(snapshot->error), "empty slots");
    }
    return DeckClientStatus::NoSlots;
  }

  int count = 0;
  for (JsonObjectConst slot : slots) {
    if (count >= CODEX_DECK_MAX_SLOTS) {
      break;
    }
    DeckSlotSnapshot &out = snapshot->slots[count];
    copyText(out.id, sizeof(out.id), slot["id"].as<const char *>());
    copyText(out.title, sizeof(out.title), slot["title"].as<const char *>());
    copyText(out.subtitle, sizeof(out.subtitle), slot["subtitle"].as<const char *>());
    copyText(out.status, sizeof(out.status), slot["status"].as<const char *>());
    copyDisplayText(out.lastSummary, sizeof(out.lastSummary), slot["lastSummary"].as<const char *>(), "");
    count++;
  }

  snapshot->slotCount = count;
  snapshot->status = DeckClientStatus::Ok;
  copyText(snapshot->error, sizeof(snapshot->error), "");
  return DeckClientStatus::Ok;
}

DeckClientStatus deckSubmitTextJob(const DeckSettings *settings, const char *slotId, const char *text, DeckJobSnapshot *job, DeckSnapshot *snapshot)
{
  if (job) {
    deckJobSnapshotInit(job);
  }

  JsonDocument requestDoc;
  requestDoc["slotId"] = slotId ? slotId : "";
  requestDoc["text"] = text ? text : "";
  String body;
  serializeJson(requestDoc, body);

  JsonDocument responseDoc;
  const DeckClientStatus status = postJsonBody(settings, "/debug/text", body, responseDoc, snapshot);
  if (status != DeckClientStatus::Ok) {
    return status;
  }

  const char *jobId = responseDoc["jobId"].as<const char *>();
  if (!jobId || jobId[0] == '\0') {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "missing job id");
    }
    return DeckClientStatus::MissingJob;
  }

  if (job) {
    copyText(job->jobId, sizeof(job->jobId), jobId);
    copyText(job->type, sizeof(job->type), "codex");
    copyText(job->status, sizeof(job->status), responseDoc["status"].as<const char *>());
    copyText(job->slotId, sizeof(job->slotId), slotId);
  }
  if (snapshot) {
    copyText(snapshot->error, sizeof(snapshot->error), "");
  }
  return DeckClientStatus::Ok;
}

DeckClientStatus deckFetchJob(const DeckSettings *settings, const char *jobId, DeckJobSnapshot *job, DeckSnapshot *snapshot)
{
  char requestedJobId[40];
  copyText(requestedJobId, sizeof(requestedJobId), jobId);
  if (job) {
    deckJobSnapshotInit(job);
  }
  if (requestedJobId[0] == '\0') {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "missing job id");
    }
    return DeckClientStatus::MissingJob;
  }

  String path = "/jobs/";
  path += requestedJobId;

  JsonDocument doc;
  const DeckClientStatus status = fetchJson(settings, path.c_str(), doc, snapshot);
  if (status != DeckClientStatus::Ok) {
    return status;
  }

  const char *publicJobId = doc["jobId"].as<const char *>();
  if (!publicJobId || publicJobId[0] == '\0') {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "missing job");
    }
    return DeckClientStatus::MissingJob;
  }

  if (job) {
    copyText(job->jobId, sizeof(job->jobId), publicJobId);
    copyText(job->type, sizeof(job->type), doc["type"].as<const char *>());
    copyText(job->status, sizeof(job->status), doc["status"].as<const char *>());
    copyText(job->slotId, sizeof(job->slotId), doc["slotId"].as<const char *>());
    copyUtf8Text(job->transcript, sizeof(job->transcript), doc["transcript"].as<const char *>());
    copyUtf8Text(job->screenTranscript, sizeof(job->screenTranscript), doc["screenTranscript"].as<const char *>());
    copyUtf8Text(job->screenReply, sizeof(job->screenReply), doc["screenReply"].as<const char *>());
    copyText(job->errorMessage, sizeof(job->errorMessage), doc["errorMessage"].as<const char *>());
    copyText(job->audioJobId, sizeof(job->audioJobId), doc["audioJobId"].as<const char *>());
    copyText(job->sourceAudioJobId, sizeof(job->sourceAudioJobId), doc["sourceAudioJobId"].as<const char *>());
    copyText(job->sourceSttJobId, sizeof(job->sourceSttJobId), doc["sourceSttJobId"].as<const char *>());
    job->fullReplyAvailable = doc["fullReplyAvailable"].as<bool>();
  }
  if (snapshot) {
    copyText(snapshot->error, sizeof(snapshot->error), "");
  }
  return DeckClientStatus::Ok;
}

DeckClientStatus deckStartAudioTranscription(const DeckSettings *settings, const char *audioJobId, DeckJobSnapshot *job, DeckSnapshot *snapshot)
{
  if (job) {
    deckJobSnapshotInit(job);
  }
  if (!audioJobId || audioJobId[0] == '\0') {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "missing audio job");
    }
    return DeckClientStatus::MissingJob;
  }

  String path = "/audio/";
  path += audioJobId;
  path += "/transcribe";

  JsonDocument requestDoc;
  requestDoc["language"] = "zh";
  String body;
  serializeJson(requestDoc, body);

  JsonDocument doc;
  const DeckClientStatus status = postJsonBody(settings, path.c_str(), body, doc, snapshot);
  if (status != DeckClientStatus::Ok) {
    return status;
  }

  const char *jobId = doc["jobId"].as<const char *>();
  if (!jobId || jobId[0] == '\0') {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "missing stt job");
    }
    return DeckClientStatus::MissingJob;
  }

  if (job) {
    copyText(job->jobId, sizeof(job->jobId), jobId);
    copyText(job->type, sizeof(job->type), "stt");
    copyText(job->status, sizeof(job->status), doc["status"].as<const char *>());
    copyText(job->slotId, sizeof(job->slotId), doc["slotId"].as<const char *>());
    copyText(job->audioJobId, sizeof(job->audioJobId), doc["audioJobId"].as<const char *>());
    copyUtf8Text(job->transcript, sizeof(job->transcript), doc["transcript"].as<const char *>());
    copyUtf8Text(job->screenTranscript, sizeof(job->screenTranscript), doc["screenTranscript"].as<const char *>());
    copyText(job->errorMessage, sizeof(job->errorMessage), doc["errorMessage"].as<const char *>());
  }
  if (snapshot) {
    copyText(snapshot->error, sizeof(snapshot->error), "");
  }
  return DeckClientStatus::Ok;
}

DeckClientStatus deckSubmitCodexSend(
  const DeckSettings *settings,
  const char *slotId,
  const char *transcript,
  const char *audioJobId,
  const char *sttJobId,
  DeckJobSnapshot *job,
  DeckSnapshot *snapshot
)
{
  if (job) {
    deckJobSnapshotInit(job);
  }
  if (!slotId || slotId[0] == '\0' || !transcript || transcript[0] == '\0') {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "missing transcript");
    }
    return DeckClientStatus::HttpError;
  }

  JsonDocument requestDoc;
  requestDoc["slotId"] = slotId;
  requestDoc["transcript"] = transcript;
  if (audioJobId && audioJobId[0]) {
    requestDoc["sourceAudioJobId"] = audioJobId;
  }
  if (sttJobId && sttJobId[0]) {
    requestDoc["sourceSttJobId"] = sttJobId;
  }
  String body;
  serializeJson(requestDoc, body);

  JsonDocument doc;
  const DeckClientStatus status = postJsonBody(settings, "/codex/send", body, doc, snapshot);
  if (status != DeckClientStatus::Ok) {
    return status;
  }

  const char *jobId = doc["jobId"].as<const char *>();
  if (!jobId || jobId[0] == '\0') {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "missing codex job");
    }
    return DeckClientStatus::MissingJob;
  }

  if (job) {
    copyText(job->jobId, sizeof(job->jobId), jobId);
    copyText(job->type, sizeof(job->type), "codex");
    copyText(job->status, sizeof(job->status), doc["status"].as<const char *>());
    copyText(job->slotId, sizeof(job->slotId), slotId);
    copyUtf8Text(job->transcript, sizeof(job->transcript), transcript);
    copyText(job->sourceAudioJobId, sizeof(job->sourceAudioJobId), audioJobId);
    copyText(job->sourceSttJobId, sizeof(job->sourceSttJobId), sttJobId);
  }
  if (snapshot) {
    copyText(snapshot->error, sizeof(snapshot->error), "");
  }
  return DeckClientStatus::Ok;
}

DeckClientStatus deckSubmitAudioUtterance(
  const DeckSettings *settings,
  const char *slotId,
  const uint8_t *wav,
  size_t wavLen,
  DeckAudioUploadSnapshot *audio,
  DeckSnapshot *snapshot
)
{
  if (audio) {
    deckAudioUploadSnapshotInit(audio);
  }
  if (!deckClientConfigReady(settings)) {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "not configured");
    }
    if (audio) {
      copyText(audio->error, sizeof(audio->error), "not configured");
    }
    return DeckClientStatus::ConfigMissing;
  }
  if (!slotId || slotId[0] == '\0' || !wav || wavLen == 0) {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "missing audio");
    }
    if (audio) {
      copyText(audio->error, sizeof(audio->error), "missing audio");
    }
    return DeckClientStatus::HttpError;
  }

  String path = "/audio/utterance?slotId=";
  path += urlEncode(slotId);

  HTTPClient http;
  const String url = deckUrl(settings, path.c_str());
  if (!http.begin(url)) {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "http begin failed");
    }
    if (audio) {
      copyText(audio->error, sizeof(audio->error), "http begin failed");
    }
    return DeckClientStatus::HttpBeginFailed;
  }
  http.setTimeout(CODEX_DECK_AUDIO_UPLOAD_TIMEOUT_MS);
  http.addHeader("Accept", "application/json");
  http.addHeader("Content-Type", "audio/wav");
  http.addHeader("X-Deck-Device", CODEX_DECK_DEVICE_NAME);

  const int code = http.POST(const_cast<uint8_t *>(wav), wavLen);
  if (snapshot) {
    snapshot->httpStatus = code;
  }
  if (audio) {
    audio->httpStatus = code;
  }
  if (code != HTTP_CODE_OK) {
    if (snapshot) {
      snprintf(snapshot->error, sizeof(snapshot->error), "http %d", code);
    }
    if (audio) {
      snprintf(audio->error, sizeof(audio->error), "http %d", code);
    }
    http.end();
    return DeckClientStatus::HttpError;
  }

  const String payload = http.getString();
  http.end();

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), error.c_str());
    }
    if (audio) {
      copyText(audio->error, sizeof(audio->error), error.c_str());
    }
    return DeckClientStatus::JsonError;
  }

  const char *jobId = doc["jobId"].as<const char *>();
  if (!jobId || jobId[0] == '\0') {
    if (snapshot) {
      copyText(snapshot->error, sizeof(snapshot->error), "missing audio job");
    }
    if (audio) {
      copyText(audio->error, sizeof(audio->error), "missing audio job");
    }
    return DeckClientStatus::MissingJob;
  }

  if (audio) {
    copyText(audio->jobId, sizeof(audio->jobId), jobId);
    copyText(audio->status, sizeof(audio->status), doc["status"].as<const char *>());
    copyText(audio->slotId, sizeof(audio->slotId), doc["slotId"].as<const char *>());
    audio->bytes = doc["bytes"].as<int>();
    JsonObjectConst format = doc["format"].as<JsonObjectConst>();
    audio->durationMs = format["durationMs"].as<int>();
    audio->sampleRate = format["sampleRate"].as<int>();
    audio->channels = format["channels"].as<int>();
    audio->bitsPerSample = format["bitsPerSample"].as<int>();
    copyText(audio->error, sizeof(audio->error), "");
  }
  if (snapshot) {
    copyText(snapshot->error, sizeof(snapshot->error), "");
  }
  return DeckClientStatus::Ok;
}
