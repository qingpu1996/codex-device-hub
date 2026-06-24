#include "weather_client.h"

#include <ArduinoJson.h>
#include <stdio.h>
#include <string.h>

static bool copyString(char* dest, size_t destSize, const char* value, bool* truncated) {
  if (!dest || destSize == 0 || !value || value[0] == '\0') {
    return false;
  }
  const size_t len = strlen(value);
  const size_t copyLen = len < destSize - 1 ? len : destSize - 1;
  memcpy(dest, value, copyLen);
  dest[copyLen] = '\0';
  if (len >= destSize && truncated) {
    *truncated = true;
  }
  return true;
}

static int16_t jsonNumber(JsonVariantConst value, bool allowMissing = true) {
  if (value.isNull()) {
    return allowMissing ? kWeatherMissing : kWeatherMissing;
  }
  if (!value.is<float>() && !value.is<int>()) {
    return kWeatherMissing;
  }
  const float number = value.as<float>();
  if (number > 32000 || number < -32000) {
    return kWeatherMissing;
  }
  return static_cast<int16_t>(number >= 0 ? number + 0.5f : number - 0.5f);
}

static int16_t jsonTenths(JsonVariantConst value) {
  if (value.isNull() || (!value.is<float>() && !value.is<int>())) {
    return kWeatherMissing;
  }
  const float number = value.as<float>() * 10.0f;
  if (number > 32000 || number < -32000) {
    return kWeatherMissing;
  }
  return static_cast<int16_t>(number >= 0 ? number + 0.5f : number - 0.5f);
}

static bool parseCurrent(JsonObjectConst obj, WeatherCurrent* out, bool* formatIssue) {
  if (obj.isNull() || !out) {
    return false;
  }
  out->tempC = jsonNumber(obj["tempC"]);
  out->feelsLikeC = jsonNumber(obj["feelsLikeC"]);
  out->humidityPercent = jsonNumber(obj["humidityPercent"]);
  out->weatherCode = jsonNumber(obj["weatherCode"]);
  out->windKph = jsonNumber(obj["windKph"]);
  out->windDirectionDeg = jsonNumber(obj["windDirectionDeg"]);
  out->pressureHpa = jsonNumber(obj["pressureHpa"]);
  out->precipTenthsMm = jsonTenths(obj["precipMm"]);
  out->pm25 = jsonNumber(obj["pm25"]);
  out->pm10 = jsonNumber(obj["pm10"]);
  out->uvIndexTenths = jsonTenths(obj["uvIndex"]);
  return copyString(out->condition, sizeof(out->condition), obj["condition"].as<const char*>(), formatIssue) &&
         copyString(out->icon, sizeof(out->icon), obj["icon"].as<const char*>(), formatIssue) &&
         copyString(out->windText, sizeof(out->windText), obj["windText"].as<const char*>(), formatIssue);
}

static bool parseToday(JsonObjectConst obj, WeatherToday* out, bool* formatIssue) {
  if (obj.isNull() || !out) {
    return false;
  }
  out->highC = jsonNumber(obj["highC"]);
  out->lowC = jsonNumber(obj["lowC"]);
  out->precipProbPercent = jsonNumber(obj["precipProbPercent"]);
  out->precipTenthsMm = jsonTenths(obj["precipMm"]);
  out->uvIndexTenths = jsonTenths(obj["uvIndexMax"]);
  return copyString(out->sunriseText, sizeof(out->sunriseText), obj["sunriseText"].as<const char*>(), formatIssue) &&
         copyString(out->sunsetText, sizeof(out->sunsetText), obj["sunsetText"].as<const char*>(), formatIssue);
}

static void parseDetails(JsonObjectConst obj, WeatherDetails* out) {
  if (!out) {
    return;
  }
  out->aqiChn = jsonNumber(obj["aqiChn"]);
  out->visibilityTenthsKm = jsonTenths(obj["visibilityKm"]);
  out->cloudPercent = jsonNumber(obj["cloudPercent"]);
  out->localRainIntensityTenths = jsonTenths(obj["localRainIntensity"]);
  out->nearestRainDistanceTenthsKm = jsonTenths(obj["nearestRainDistanceKm"]);
  out->nearestRainIntensityTenths = jsonTenths(obj["nearestRainIntensity"]);
  out->comfortIndex = jsonNumber(obj["comfortIndex"]);
  out->dressingIndex = jsonNumber(obj["dressingIndex"]);
  out->coldRiskIndex = jsonNumber(obj["coldRiskIndex"]);
}

static bool parseHour(JsonObjectConst obj, WeatherHour* out, bool* formatIssue) {
  if (obj.isNull() || !out) {
    return false;
  }
  out->tempC = jsonNumber(obj["tempC"]);
  out->precipProbPercent = jsonNumber(obj["precipProbPercent"]);
  out->precipTenthsMm = jsonTenths(obj["precipMm"]);
  out->weatherCode = jsonNumber(obj["weatherCode"]);
  return copyString(out->timeText, sizeof(out->timeText), obj["timeText"].as<const char*>(), formatIssue) &&
         copyString(out->condition, sizeof(out->condition), obj["condition"].as<const char*>(), formatIssue) &&
         copyString(out->icon, sizeof(out->icon), obj["icon"].as<const char*>(), formatIssue);
}

static bool parseDay(JsonObjectConst obj, WeatherDay* out, bool* formatIssue) {
  if (obj.isNull() || !out) {
    return false;
  }
  out->highC = jsonNumber(obj["highC"]);
  out->lowC = jsonNumber(obj["lowC"]);
  out->precipProbPercent = jsonNumber(obj["precipProbPercent"]);
  out->precipTenthsMm = jsonTenths(obj["precipMm"]);
  out->weatherCode = jsonNumber(obj["weatherCode"]);
  return copyString(out->dayText, sizeof(out->dayText), obj["dayText"].as<const char*>(), formatIssue) &&
         copyString(out->condition, sizeof(out->condition), obj["condition"].as<const char*>(), formatIssue) &&
         copyString(out->icon, sizeof(out->icon), obj["icon"].as<const char*>(), formatIssue);
}

WeatherParseResult parseWeatherJson(const char* json, size_t length, WeatherPayload* out) {
  if (!json || !out) {
    return {false, WeatherError::MissingField};
  }
  if (length > kMaxWeatherResponseBytes) {
    return {false, WeatherError::ResponseTooLarge};
  }

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, json, length);
  if (error) {
    return {false, WeatherError::JsonParse};
  }

  memset(out, 0, sizeof(*out));
  out->schemaVersion = doc["schemaVersion"] | -1;
  if (out->schemaVersion != 1) {
    return {false, WeatherError::Schema};
  }

  bool formatIssue = false;
  if (!copyString(out->status, sizeof(out->status), doc["status"].as<const char*>(), &formatIssue) ||
      !copyString(out->source, sizeof(out->source), doc["source"].as<const char*>(), &formatIssue) ||
      !copyString(out->location, sizeof(out->location), doc["location"].as<const char*>(), &formatIssue) ||
      !copyString(out->timezone, sizeof(out->timezone), doc["timezone"].as<const char*>(), &formatIssue)) {
    return {false, WeatherError::MissingField};
  }

  const int slot = doc["slot"] | 0;
  const int slotCount = doc["slotCount"] | 0;
  if (slot < 1 || slot > 12 || slotCount < 1 || slotCount > 12) {
    return {false, WeatherError::MissingField};
  }
  out->slot = static_cast<uint8_t>(slot);
  out->slotCount = static_cast<uint8_t>(slotCount);

  if (!parseCurrent(doc["current"].as<JsonObjectConst>(), &out->current, &formatIssue) ||
      !parseToday(doc["today"].as<JsonObjectConst>(), &out->today, &formatIssue)) {
    return {false, WeatherError::MissingField};
  }
  parseDetails(doc["details"].as<JsonObjectConst>(), &out->details);

  JsonArrayConst hourly = doc["hourly"].as<JsonArrayConst>();
  for (JsonObjectConst item : hourly) {
    if (out->hourlyCount >= kWeatherMaxHours) {
      formatIssue = true;
      break;
    }
    if (!parseHour(item, &out->hourly[out->hourlyCount], &formatIssue)) {
      return {false, WeatherError::MissingField};
    }
    out->hourlyCount++;
  }

  JsonArrayConst daily = doc["daily"].as<JsonArrayConst>();
  for (JsonObjectConst item : daily) {
    if (out->dailyCount >= kWeatherMaxDays) {
      formatIssue = true;
      break;
    }
    if (!parseDay(item, &out->daily[out->dailyCount], &formatIssue)) {
      return {false, WeatherError::MissingField};
    }
    out->dailyCount++;
  }

  out->hadFormatIssue = formatIssue;
  return {true, WeatherError::None};
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

uint32_t weatherPayloadHash(const WeatherPayload& payload) {
  uint32_t hash = 2166136261UL;
  hash = hashCString(hash, payload.source);
  hash = hashCString(hash, payload.location);
  hash = fnv1a(hash, &payload.slot, sizeof(payload.slot));
  hash = fnv1a(hash, &payload.slotCount, sizeof(payload.slotCount));
  hash = fnv1a(hash, &payload.current, sizeof(payload.current));
  hash = fnv1a(hash, &payload.today, sizeof(payload.today));
  hash = fnv1a(hash, &payload.details, sizeof(payload.details));
  hash = fnv1a(hash, payload.hourly, sizeof(payload.hourly));
  hash = fnv1a(hash, &payload.hourlyCount, sizeof(payload.hourlyCount));
  hash = fnv1a(hash, payload.daily, sizeof(payload.daily));
  hash = fnv1a(hash, &payload.dailyCount, sizeof(payload.dailyCount));
  return hash;
}

bool buildWeatherEndpointUrl(const char* quotaApiUrl, uint8_t slot, char* out, size_t outSize) {
  if (!quotaApiUrl || !out || outSize == 0) {
    return false;
  }
  out[0] = '\0';
  if (!strstr(quotaApiUrl, "/api/device/")) {
    return false;
  }
  const size_t baseLen = strlen(quotaApiUrl);
  const int written = snprintf(out, outSize, "%s/weather?slot=%u", quotaApiUrl, static_cast<unsigned>(slot < 1 ? 1 : slot));
  return written > 0 && static_cast<size_t>(written) < outSize && static_cast<size_t>(written) > baseLen;
}

const char* weatherErrorName(WeatherError error) {
  switch (error) {
    case WeatherError::None: return "none";
    case WeatherError::Url: return "url";
    case WeatherError::Http: return "http";
    case WeatherError::ContentType: return "content-type";
    case WeatherError::ResponseTooLarge: return "response-too-large";
    case WeatherError::JsonParse: return "json-parse";
    case WeatherError::Schema: return "schema";
    case WeatherError::MissingField: return "missing-field";
  }
  return "unknown";
}

#ifndef QUOTA_HOST_TEST
#include <Arduino.h>
#include <HTTPClient.h>

static constexpr uint32_t kHttpTimeoutMs = 8000;

static void copyArduinoString(char* dest, size_t destSize, const String& value) {
  if (destSize == 0) {
    return;
  }
  const size_t copyLen = value.length() < destSize - 1 ? value.length() : destSize - 1;
  memcpy(dest, value.c_str(), copyLen);
  dest[copyLen] = '\0';
}

static bool contentTypeContains(const char* contentType, const char* expected) {
  return contentType && expected && strstr(contentType, expected) != nullptr;
}

FetchWeatherResult fetchWeatherPayload(const char* quotaApiUrl, uint8_t slot) {
  FetchWeatherResult result{};
  result.error = WeatherError::None;
  char url[kWeatherEndpointUrlMaxLen];
  if (!buildWeatherEndpointUrl(quotaApiUrl, slot, url, sizeof(url))) {
    result.error = WeatherError::Url;
    return result;
  }

  HTTPClient http;
  const char* headers[] = {"Content-Type"};
  http.setTimeout(kHttpTimeoutMs);
  http.setReuse(false);
  http.collectHeaders(headers, 1);
  if (!http.begin(url)) {
    result.error = WeatherError::Url;
    http.end();
    return result;
  }

  const int code = http.GET();
  result.httpStatus = code;
  copyArduinoString(result.contentType, sizeof(result.contentType), http.header("Content-Type"));
  Serial1.printf("[weather] status=%d content-type=%s size=%d\n", code, result.contentType, http.getSize());
  if (code != HTTP_CODE_OK) {
    result.error = WeatherError::Http;
    http.end();
    return result;
  }
  if (!contentTypeContains(result.contentType, "application/json")) {
    result.error = WeatherError::ContentType;
    http.end();
    return result;
  }
  if (http.getSize() > static_cast<int>(kMaxWeatherResponseBytes)) {
    result.error = WeatherError::ResponseTooLarge;
    http.end();
    return result;
  }

  const String body = http.getString();
  http.end();
  if (body.length() > kMaxWeatherResponseBytes) {
    result.error = WeatherError::ResponseTooLarge;
    return result;
  }
  const WeatherParseResult parsed = parseWeatherJson(body.c_str(), body.length(), &result.payload);
  result.ok = parsed.ok;
  result.error = parsed.error;
  return result;
}
#endif
