#pragma once

#include <stddef.h>
#include <stdint.h>

static constexpr int kWeatherMissing = -32768;
static constexpr size_t kWeatherEndpointUrlMaxLen = 288;
static constexpr size_t kMaxWeatherResponseBytes = 8192;
static constexpr uint8_t kWeatherMaxHours = 6;
static constexpr uint8_t kWeatherMaxDays = 3;
static constexpr uint8_t kWeatherSlotCount = 3;

struct WeatherCurrent {
  int16_t tempC;
  int16_t feelsLikeC;
  int16_t humidityPercent;
  char condition[16];
  char icon[12];
  int16_t weatherCode;
  int16_t windKph;
  int16_t windDirectionDeg;
  char windText[8];
  int16_t pressureHpa;
  int16_t precipTenthsMm;
  int16_t pm25;
  int16_t pm10;
  int16_t uvIndexTenths;
};

struct WeatherToday {
  int16_t highC;
  int16_t lowC;
  int16_t precipProbPercent;
  int16_t precipTenthsMm;
  char sunriseText[8];
  char sunsetText[8];
  int16_t uvIndexTenths;
};

struct WeatherDetails {
  int16_t aqiChn;
  int16_t visibilityTenthsKm;
  int16_t cloudPercent;
  int16_t localRainIntensityTenths;
  int16_t nearestRainDistanceTenthsKm;
  int16_t nearestRainIntensityTenths;
  int16_t comfortIndex;
  int16_t dressingIndex;
  int16_t coldRiskIndex;
};

struct WeatherHour {
  char timeText[8];
  int16_t tempC;
  int16_t precipProbPercent;
  int16_t precipTenthsMm;
  char condition[16];
  char icon[12];
  int16_t weatherCode;
};

struct WeatherDay {
  char dayText[8];
  int16_t highC;
  int16_t lowC;
  int16_t precipProbPercent;
  int16_t precipTenthsMm;
  char condition[16];
  char icon[12];
  int16_t weatherCode;
};

struct WeatherPayload {
  int schemaVersion;
  char status[16];
  char source[16];
  char location[48];
  char timezone[48];
  uint8_t slot;
  uint8_t slotCount;
  WeatherCurrent current;
  WeatherToday today;
  WeatherDetails details;
  WeatherHour hourly[kWeatherMaxHours];
  uint8_t hourlyCount;
  WeatherDay daily[kWeatherMaxDays];
  uint8_t dailyCount;
  bool hadFormatIssue;
};

enum class WeatherError : uint8_t {
  None,
  Url,
  Http,
  ContentType,
  ResponseTooLarge,
  JsonParse,
  Schema,
  MissingField,
};

struct WeatherParseResult {
  bool ok;
  WeatherError error;
};

WeatherParseResult parseWeatherJson(const char* json, size_t length, WeatherPayload* out);
uint32_t weatherPayloadHash(const WeatherPayload& payload);
bool buildWeatherEndpointUrl(const char* quotaApiUrl, uint8_t slot, char* out, size_t outSize);
const char* weatherErrorName(WeatherError error);

#ifndef QUOTA_HOST_TEST
struct FetchWeatherResult {
  bool ok;
  WeatherError error;
  int httpStatus;
  char contentType[48];
  WeatherPayload payload;
};

FetchWeatherResult fetchWeatherPayload(const char* quotaApiUrl, uint8_t slot);
#endif
