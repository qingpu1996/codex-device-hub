#include "quota_client.h"

#include <ArduinoJson.h>
#include <string.h>

static int clampPercent(int value, bool* clamped) {
  if (value < 0) {
    *clamped = true;
    return 0;
  }
  if (value > 100) {
    *clamped = true;
    return 100;
  }
  return value;
}

static bool copyString(char* dest, size_t destSize, const char* value, bool* truncated) {
  if (!value || value[0] == '\0' || destSize == 0) {
    return false;
  }
  const size_t len = strlen(value);
  const size_t copyLen = len < destSize - 1 ? len : destSize - 1;
  memcpy(dest, value, copyLen);
  dest[copyLen] = '\0';
  if (len >= destSize) {
    *truncated = true;
  }
  return true;
}

static bool isAllowedStatus(const char* value) {
  return strcmp(value, "fresh") == 0 || strcmp(value, "cached") == 0 || strcmp(value, "stale") == 0;
}

ParseResult parseQuotaJson(const char* json, size_t length, QuotaPayload* out) {
  if (!json || !out) {
    return {false, QuotaError::MissingField};
  }
  if (length > kMaxQuotaResponseBytes) {
    return {false, QuotaError::ResponseTooLarge};
  }

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, json, length);
  if (error) {
    return {false, QuotaError::JsonParse};
  }

  memset(out, 0, sizeof(*out));
  out->schemaVersion = doc["schemaVersion"] | -1;
  if (out->schemaVersion != 1) {
    return {false, QuotaError::Schema};
  }

  bool formatIssue = false;
  out->generatedAt = doc["generatedAt"] | 0;
  if (out->generatedAt <= 0) {
    formatIssue = true;
  }

  if (!copyString(out->plan, sizeof(out->plan), doc["plan"].as<const char*>(), &formatIssue)) {
    return {false, QuotaError::MissingField};
  }
  if (!copyString(out->status, sizeof(out->status), doc["status"].as<const char*>(), &formatIssue)) {
    return {false, QuotaError::MissingField};
  }
  if (!isAllowedStatus(out->status)) {
    return {false, QuotaError::InvalidStatus};
  }

  JsonObject usage = doc["usage"].as<JsonObject>();
  if (!usage.isNull()) {
    const bool hasTotal = copyString(out->totalTokensText, sizeof(out->totalTokensText), usage["totalTokensText"].as<const char*>(), &formatIssue);
    const bool hasToday = copyString(out->todayTokensText, sizeof(out->todayTokensText), usage["todayTokensText"].as<const char*>(), &formatIssue);
    out->hasUsage = hasTotal && hasToday;
    if (!out->hasUsage) {
      formatIssue = true;
      out->totalTokensText[0] = '\0';
      out->todayTokensText[0] = '\0';
    }
  }

  JsonArray windows = doc["windows"].as<JsonArray>();
  if (windows.isNull() || windows.size() == 0) {
    return {false, QuotaError::NoWindows};
  }

  size_t index = 0;
  for (JsonObject item : windows) {
    if (index >= kMaxQuotaWindows) {
      formatIssue = true;
      break;
    }

    QuotaWindow& window = out->windows[index];
    if (!copyString(window.key, sizeof(window.key), item["key"].as<const char*>(), &formatIssue) ||
        !copyString(window.title, sizeof(window.title), item["title"].as<const char*>(), &formatIssue) ||
        !copyString(window.resetText, sizeof(window.resetText), item["resetText"].as<const char*>(), &formatIssue)) {
      return {false, QuotaError::MissingField};
    }

    if (!item["remainingPercent"].is<int>()) {
      return {false, QuotaError::MissingField};
    }
    bool clamped = false;
    window.remainingPercent = clampPercent(item["remainingPercent"].as<int>(), &clamped);
    window.percentWasClamped = clamped;
    if (clamped) {
      formatIssue = true;
    }
    window.resetsAt = item["resetsAt"].is<int64_t>() ? item["resetsAt"].as<int64_t>() : 0;
    if (window.resetsAt <= 0) {
      formatIssue = true;
    }
    index++;
  }

  out->windowCount = index;
  out->hadFormatIssue = formatIssue;
  return {true, QuotaError::None};
}

static uint32_t fnv1a(uint32_t hash, const void* data, size_t len) {
  const uint8_t* bytes = static_cast<const uint8_t*>(data);
  for (size_t i = 0; i < len; ++i) {
    hash ^= bytes[i];
    hash *= 16777619UL;
  }
  return hash;
}

static uint32_t hashCString(uint32_t hash, const char* value) {
  return fnv1a(hash, value, strlen(value) + 1);
}

static uint32_t hashInt64(uint32_t hash, int64_t value) {
  return fnv1a(hash, &value, sizeof(value));
}

uint32_t quotaRenderHash(const QuotaPayload& payload) {
  uint32_t hash = 2166136261UL;
  hash = hashCString(hash, payload.plan);
  hash = hashCString(hash, payload.status);
  if (payload.hasUsage) {
    hash = hashCString(hash, payload.totalTokensText);
    hash = hashCString(hash, payload.todayTokensText);
  }
  for (size_t i = 0; i < payload.windowCount; ++i) {
    const QuotaWindow& window = payload.windows[i];
    hash = hashCString(hash, window.title);
    hash = hashInt64(hash, window.remainingPercent);
    hash = hashCString(hash, window.resetText);
  }
  return hash;
}

RefreshDecision decideRefresh(const QuotaPayload& payload, const RenderState& state, bool manualWake) {
  const uint32_t hash = quotaRenderHash(payload);
  if (!state.hasRenderedValidData) {
    return {true, "first valid data"};
  }
  if (manualWake) {
    return {true, "manual wake"};
  }
  if (hash != state.lastRenderHash) {
    return {true, "display hash changed"};
  }
  return {false, "display hash unchanged"};
}

bool shouldRenderSetupError(const RenderState& state) {
  return !state.hasRenderedValidData;
}

const char* quotaErrorName(QuotaError error) {
  switch (error) {
    case QuotaError::None: return "none";
    case QuotaError::ResponseTooLarge: return "response-too-large";
    case QuotaError::JsonParse: return "json-parse";
    case QuotaError::Schema: return "schema";
    case QuotaError::MissingField: return "missing-field";
    case QuotaError::InvalidStatus: return "invalid-status";
    case QuotaError::NoWindows: return "no-windows";
  }
  return "unknown";
}

#ifndef QUOTA_HOST_TEST
#include <HTTPClient.h>
#include <WiFi.h>
#include "provisioning.h"

static constexpr uint32_t kHttpTimeoutMs = 8000;
static constexpr int kHttpRetryCount = 2;

static void copyArduinoString(char* dest, size_t destSize, const String& value) {
  if (destSize == 0) {
    return;
  }
  const size_t copyLen = value.length() < destSize - 1 ? value.length() : destSize - 1;
  memcpy(dest, value.c_str(), copyLen);
  dest[copyLen] = '\0';
}

static bool contentTypeIsJson(const char* contentType) {
  return strstr(contentType, "application/json") != nullptr;
}

void logQuotaApiTarget(const char* apiUrl) {
  char target[80];
  formatApiTarget(apiUrl, target, sizeof(target));
  Serial1.printf("[api] target    : %s\n", target);
}

FetchResult fetchQuotaPayload(const char* apiUrl) {
  FetchResult result{};
  result.ok = false;
  result.error = QuotaError::None;
  result.httpStatus = 0;
  if (!apiUrl || apiUrl[0] == '\0') {
    result.error = QuotaError::MissingField;
    return result;
  }

  for (int attempt = 1; attempt <= kHttpRetryCount; ++attempt) {
    HTTPClient http;
    const char* headers[] = {"Content-Type"};
    http.setTimeout(kHttpTimeoutMs);
    http.setReuse(false);
    http.collectHeaders(headers, 1);

    if (!http.begin(apiUrl)) {
      result.error = QuotaError::MissingField;
      http.end();
      continue;
    }

    const int code = http.GET();
    result.httpStatus = code;
    copyArduinoString(result.contentType, sizeof(result.contentType), http.header("Content-Type"));
    Serial1.printf("[http] attempt %d status=%d content-type=%s\n", attempt, code, result.contentType);

    if (code == HTTP_CODE_OK && contentTypeIsJson(result.contentType)) {
      const int contentLength = http.getSize();
      if (contentLength > static_cast<int>(kMaxQuotaResponseBytes)) {
        result.error = QuotaError::ResponseTooLarge;
        http.end();
        return result;
      }
      const String body = http.getString();
      if (body.length() > kMaxQuotaResponseBytes) {
        result.error = QuotaError::ResponseTooLarge;
        http.end();
        return result;
      }
      const ParseResult parsed = parseQuotaJson(body.c_str(), body.length(), &result.payload);
      result.ok = parsed.ok;
      result.error = parsed.error;
      http.end();
      if (result.ok) {
        return result;
      }
    } else {
      result.error = code == HTTP_CODE_OK ? QuotaError::MissingField : QuotaError::None;
    }

    http.end();
    delay(300);
  }

  return result;
}
#endif
