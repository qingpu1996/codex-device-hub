#pragma once

#include "battery.h"
#include "feature_flags.h"
#include "quota_client.h"
#if FEATURE_WEATHER
#include "weather_client.h"
#endif

void renderQuotaPage(const QuotaPayload& payload, const char* pageIndicator, const BatteryStatus& battery);
#if FEATURE_MEAL
void renderTodayMealPage(const char* pageIndicator, const BatteryStatus& battery);
void renderMealImagePage(const uint8_t* image4bpp, size_t imageBytes, const char* pageIndicator, const char* subPageIndicator, const BatteryStatus& battery);
void renderMealErrorPage(const char* category, const char* pageIndicator, const char* subPageIndicator, const BatteryStatus& battery);
#endif
#if FEATURE_WEATHER
void renderWeatherPage(const WeatherPayload& payload, const char* pageIndicator, const char* subPageIndicator, const BatteryStatus& battery);
void renderWeatherErrorPage(const char* category, const char* pageIndicator, const char* subPageIndicator, const BatteryStatus& battery);
#endif
void renderSetupError(const char* category);
void renderWifiSetupPage(const char* apSsid, const char* apPassword, const char* setupUrl, const char* reason);
void renderProvisioningSavedPage();
