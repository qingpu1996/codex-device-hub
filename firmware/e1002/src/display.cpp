#include "display.h"

#include <Arduino.h>
#include <math.h>
#include <string.h>
#include "feature_flags.h"
#if FEATURE_MEAL
#include "meal_image_client.h"
#endif
#if FEATURE_WEATHER
#include "weather_client.h"
#endif
#include "TFT_eSPI.h"

#ifndef EPAPER_ENABLE
#error "This firmware requires Seeed_GFX Setup521. Check src/driver.h defines BOARD_SCREEN_COMBO 521."
#endif

static EPaper epaper;

static uint16_t percentColor(int percent) {
  if (percent > 50) {
    return TFT_GREEN;
  }
  if (percent >= 20) {
    return TFT_YELLOW;
  }
  return TFT_RED;
}

static uint16_t percentTextColor(int percent) {
  if (percent > 50) {
    return TFT_GREEN;
  }
  if (percent >= 20) {
    return TFT_BLACK;
  }
  return TFT_RED;
}

static uint16_t batteryColor(const BatteryStatus& battery) {
  if (!battery.valid) {
    return TFT_BLACK;
  }
  return percentTextColor(battery.percent);
}

static void text(const char* value, int x, int y, int size, uint16_t color, uint8_t datum = TL_DATUM) {
  epaper.setTextDatum(datum);
  epaper.setTextColor(color, TFT_WHITE);
  epaper.setTextSize(size);
  epaper.drawString(value, x, y);
}

static void centered(const char* value, int x, int y, int size, uint16_t color) {
  text(value, x, y, size, color, MC_DATUM);
}

static void drawProgressBar(int x, int y, int w, int h, int percent, uint16_t color) {
  epaper.drawRect(x, y, w, h, TFT_BLACK);
  epaper.drawRect(x + 1, y + 1, w - 2, h - 2, TFT_BLACK);
  const int fillW = ((w - 6) * percent) / 100;
  epaper.fillRect(x + 3, y + 3, fillW, h - 6, color);
}

static void drawCard(int x, int y, int w, int h, const QuotaWindow& window) {
  const uint16_t color = percentColor(window.remainingPercent);
  const uint16_t readableTextColor = percentTextColor(window.remainingPercent);
  epaper.drawRect(x, y, w, h, TFT_BLACK);
  epaper.drawRect(x + 1, y + 1, w - 2, h - 2, TFT_BLACK);
  epaper.drawRect(x + 2, y + 2, w - 4, h - 4, TFT_BLACK);

  centered(window.title, x + w / 2, y + 34, 3, TFT_BLUE);

  char pct[8];
  snprintf(pct, sizeof(pct), "%d%%", window.remainingPercent);
  centered(pct, x + w / 2, y + 105, 8, readableTextColor);

  drawProgressBar(x + 36, y + 170, w - 72, 30, window.remainingPercent, color);

  centered("RESET", x + w / 2, y + 228, 2, TFT_BLACK);
  centered(window.resetText, x + w / 2, y + 262, 3, TFT_BLACK);
}

static void drawEmptyCard(int x, int y, int w, int h) {
  epaper.drawRect(x, y, w, h, TFT_BLACK);
  epaper.drawRect(x + 1, y + 1, w - 2, h - 2, TFT_BLACK);
  epaper.drawRect(x + 2, y + 2, w - 4, h - 4, TFT_BLACK);
  centered("NO WINDOW", x + w / 2, y + h / 2, 3, TFT_RED);
}

static void drawFooter(const char* pageIndicator, const char* subPageIndicator, const BatteryStatus& battery) {
  char batteryLabel[16];
  formatBatteryLabel(battery, batteryLabel, sizeof(batteryLabel));

  epaper.drawLine(20, 416, 780, 416, TFT_BLACK);
  text("L:N=PAGE", 34, 432, 2, TFT_BLACK);
  text("M:NEXT", 170, 432, 2, TFT_BLACK);
#if FEATURE_SUBPAGES
  text("HOLD:SUB", 280, 432, 2, TFT_BLACK);
  text("G:REFRESH", 420, 432, 2, TFT_BLACK);
#else
  text("G:REFRESH", 300, 432, 2, TFT_BLACK);
#endif
  if (subPageIndicator && subPageIndicator[0] != '\0') {
    text(subPageIndicator, 596, 432, 2, TFT_BLACK, TR_DATUM);
  }
  text(batteryLabel, 700, 432, 2, batteryColor(battery), TR_DATUM);
  text(pageIndicator, 766, 432, 2, TFT_BLACK, TR_DATUM);
}

static void drawUsageMetric(const char* label, const char* value, int centerX, uint16_t valueColor) {
  if (!value || value[0] == '\0') {
    return;
  }
  centered(label, centerX, 20, 2, TFT_BLACK);
  centered(value, centerX, 50, 2, valueColor);
}

void renderQuotaPage(const QuotaPayload& payload, const char* pageIndicator, const BatteryStatus& battery) {
  epaper.begin();
  epaper.fillScreen(TFT_WHITE);

  epaper.drawRect(0, 0, 800, 480, TFT_BLACK);
  epaper.drawRect(3, 3, 794, 474, TFT_BLACK);

  text("CODEX", 28, 24, 4, TFT_BLUE);
  centered(payload.plan, 400, 36, 4, TFT_BLACK);
  if (payload.hasUsage) {
    drawUsageMetric("TOTAL", payload.totalTokensText, 250, TFT_BLUE);
    drawUsageMetric("TODAY", payload.todayTokensText, 550, TFT_GREEN);
  }

  const char* status = strcmp(payload.status, "fresh") == 0 ? "ONLINE" :
                       strcmp(payload.status, "cached") == 0 ? "CACHED" : "STALE";
  text(status, 772, 24, 3, strcmp(status, "ONLINE") == 0 ? TFT_GREEN : TFT_RED, TR_DATUM);
  epaper.drawLine(20, 72, 780, 72, TFT_BLACK);

  static constexpr int cardY = 92;
  static constexpr int cardW = 350;
  static constexpr int cardH = 306;
  if (payload.windowCount > 0) {
    drawCard(34, cardY, cardW, cardH, payload.windows[0]);
  } else {
    drawEmptyCard(34, cardY, cardW, cardH);
  }
  if (payload.windowCount > 1) {
    drawCard(416, cardY, cardW, cardH, payload.windows[1]);
  } else {
    drawEmptyCard(416, cardY, cardW, cardH);
  }

  drawFooter(pageIndicator, "", battery);

  Serial1.println("[display] update start");
  Serial1.flush();
  const uint32_t start = millis();
  epaper.update();
  Serial1.printf("[display] update done in %lu ms\n", static_cast<unsigned long>(millis() - start));
  epaper.sleep();
}

#if FEATURE_MEAL
void renderTodayMealPage(const char* pageIndicator, const BatteryStatus& battery) {
  epaper.begin();
  epaper.fillScreen(TFT_WHITE);

  epaper.drawRect(0, 0, 800, 480, TFT_BLACK);
  epaper.drawRect(3, 3, 794, 474, TFT_BLACK);

  text("MEAL PLAN", 28, 24, 4, TFT_BLUE);
  text("STATIC", 772, 24, 3, TFT_BLACK, TR_DATUM);
  epaper.drawLine(20, 72, 780, 72, TFT_BLACK);

  centered("TODAY'S MENU", 400, 135, 4, TFT_BLUE);
  centered("NOT CONFIGURED", 400, 235, 6, TFT_RED);
  centered("MEAL DATA WILL BE ADDED NEXT", 400, 320, 2, TFT_BLACK);

  drawFooter(pageIndicator, "", battery);

  Serial1.println("[display] meal placeholder update start");
  Serial1.flush();
  const uint32_t start = millis();
  epaper.update();
  Serial1.printf("[display] meal placeholder update done in %lu ms\n", static_cast<unsigned long>(millis() - start));
  epaper.sleep();
}

void renderMealImagePage(const uint8_t* image4bpp, size_t imageBytes, const char* pageIndicator, const char* subPageIndicator, const BatteryStatus& battery) {
  if (!image4bpp || imageBytes != kMealImageBytes) {
    renderMealErrorPage("image-buffer", pageIndicator, subPageIndicator, battery);
    return;
  }
  epaper.begin();
  epaper.pushImage(0, 0, 800, 480, reinterpret_cast<uint16_t*>(const_cast<uint8_t*>(image4bpp)), 4);
  drawFooter(pageIndicator, subPageIndicator, battery);

  Serial1.println("[display] meal image update start");
  Serial1.flush();
  const uint32_t start = millis();
  epaper.update();
  Serial1.printf("[display] meal image update done in %lu ms\n", static_cast<unsigned long>(millis() - start));
  epaper.sleep();
}

void renderMealErrorPage(const char* category, const char* pageIndicator, const char* subPageIndicator, const BatteryStatus& battery) {
  epaper.begin();
  epaper.fillScreen(TFT_WHITE);

  epaper.drawRect(0, 0, 800, 480, TFT_BLACK);
  epaper.drawRect(3, 3, 794, 474, TFT_BLACK);

  text("MEAL PLAN", 28, 24, 4, TFT_BLUE);
  text("ERROR", 772, 24, 3, TFT_RED, TR_DATUM);
  epaper.drawLine(20, 72, 780, 72, TFT_BLACK);

  centered("MEAL IMAGE ERROR", 400, 185, 5, TFT_RED);
  centered(category ? category : "unknown", 400, 260, 3, TFT_BLACK);
  centered("KEEP OLD PAGE IF AVAILABLE", 400, 325, 2, TFT_BLUE);

  drawFooter(pageIndicator, subPageIndicator, battery);

  Serial1.println("[display] meal error update start");
  Serial1.flush();
  const uint32_t start = millis();
  epaper.update();
  Serial1.printf("[display] meal error update done in %lu ms\n", static_cast<unsigned long>(millis() - start));
  epaper.sleep();
}
#endif

#if FEATURE_WEATHER
static bool hasWeatherValue(int16_t value) {
  return value != kWeatherMissing;
}

static void formatIntValue(int16_t value, const char* suffix, char* out, size_t outSize) {
  if (!out || outSize == 0) {
    return;
  }
  if (!hasWeatherValue(value)) {
    snprintf(out, outSize, "--%s", suffix ? suffix : "");
    return;
  }
  snprintf(out, outSize, "%d%s", static_cast<int>(value), suffix ? suffix : "");
}

static void formatTenthsValue(int16_t value, const char* suffix, char* out, size_t outSize) {
  if (!out || outSize == 0) {
    return;
  }
  if (!hasWeatherValue(value)) {
    snprintf(out, outSize, "--%s", suffix ? suffix : "");
    return;
  }
  snprintf(out, outSize, "%d.%d%s",
           static_cast<int>(value / 10),
           static_cast<int>(abs(value % 10)),
           suffix ? suffix : "");
}

static void formatTempNumber(int16_t value, char* out, size_t outSize) {
  if (!out || outSize == 0) {
    return;
  }
  if (!hasWeatherValue(value)) {
    snprintf(out, outSize, "--");
    return;
  }
  snprintf(out, outSize, "%d", static_cast<int>(value));
}

static void drawTemperatureCentered(int16_t value, int x, int y, int size, uint16_t color) {
  char number[12];
  formatTempNumber(value, number, sizeof(number));
  epaper.setTextSize(size);
  epaper.setTextDatum(ML_DATUM);
  epaper.setTextColor(color, TFT_WHITE);
  const int numberW = epaper.textWidth(number);
  const int cW = epaper.textWidth("C");
  const int gap = size * 3;
  const int radius = size >= 5 ? 5 : 3;
  const int totalW = numberW + gap + radius * 2 + gap + cW;
  const int startX = x - totalW / 2;
  epaper.drawString(number, startX, y);
  const int degreeX = startX + numberW + gap + radius;
  const int degreeY = y - size * 4;
  epaper.drawCircle(degreeX, degreeY, radius, color);
  epaper.drawString("C", degreeX + radius + gap, y);
}

static void drawTemperatureRangeCentered(int16_t high, int16_t low, int x, int y, int size, uint16_t color) {
  char highText[8];
  char lowText[8];
  char range[20];
  formatTempNumber(high, highText, sizeof(highText));
  formatTempNumber(low, lowText, sizeof(lowText));
  snprintf(range, sizeof(range), "%s/%s", highText, lowText);
  epaper.setTextSize(size);
  epaper.setTextDatum(ML_DATUM);
  epaper.setTextColor(color, TFT_WHITE);
  const int rangeW = epaper.textWidth(range);
  const int cW = epaper.textWidth("C");
  const int gap = size * 2;
  const int radius = size >= 5 ? 5 : 3;
  const int totalW = rangeW + gap + radius * 2 + gap + cW;
  const int startX = x - totalW / 2;
  epaper.drawString(range, startX, y);
  const int degreeX = startX + rangeW + gap + radius;
  const int degreeY = y - size * 4;
  epaper.drawCircle(degreeX, degreeY, radius, color);
  epaper.drawString("C", degreeX + radius + gap, y);
}

static uint16_t weatherIconColor(const char* icon) {
  if (!icon) {
    return TFT_BLUE;
  }
  if (strcmp(icon, "SUN") == 0 || strcmp(icon, "PARTLY") == 0) {
    return TFT_YELLOW;
  }
  if (strcmp(icon, "RAIN") == 0 || strcmp(icon, "SNOW") == 0 || strcmp(icon, "FOG") == 0) {
    return TFT_BLUE;
  }
  if (strcmp(icon, "STORM") == 0) {
    return TFT_RED;
  }
  return TFT_BLUE;
}

static void drawWeatherIcon(const char* icon, int cx, int cy, int scale) {
  const uint16_t color = weatherIconColor(icon);
  const bool sun = icon && (strcmp(icon, "SUN") == 0 || strcmp(icon, "PARTLY") == 0);
  if (sun) {
    epaper.fillCircle(cx, cy, 12 * scale, TFT_YELLOW);
    epaper.drawCircle(cx, cy, 12 * scale, TFT_BLACK);
    if (strcmp(icon, "SUN") == 0) {
      for (int i = 0; i < 8; ++i) {
        const float angle = i * 0.785398f;
        const int x1 = cx + static_cast<int>(cosf(angle) * 18 * scale);
        const int y1 = cy + static_cast<int>(sinf(angle) * 18 * scale);
        const int x2 = cx + static_cast<int>(cosf(angle) * 26 * scale);
        const int y2 = cy + static_cast<int>(sinf(angle) * 26 * scale);
        epaper.drawLine(x1, y1, x2, y2, TFT_BLACK);
      }
    }
  }
  if (!icon || strcmp(icon, "SUN") != 0) {
    epaper.fillCircle(cx - 15 * scale, cy + 6 * scale, 11 * scale, TFT_WHITE);
    epaper.fillCircle(cx, cy, 15 * scale, TFT_WHITE);
    epaper.fillCircle(cx + 17 * scale, cy + 8 * scale, 10 * scale, TFT_WHITE);
    epaper.drawCircle(cx - 15 * scale, cy + 6 * scale, 11 * scale, TFT_BLACK);
    epaper.drawCircle(cx, cy, 15 * scale, TFT_BLACK);
    epaper.drawCircle(cx + 17 * scale, cy + 8 * scale, 10 * scale, TFT_BLACK);
    epaper.drawLine(cx - 30 * scale, cy + 18 * scale, cx + 30 * scale, cy + 18 * scale, TFT_BLACK);
  }
  if (icon && strcmp(icon, "RAIN") == 0) {
    for (int i = -1; i <= 1; ++i) {
      epaper.drawLine(cx + i * 16 * scale, cy + 30 * scale, cx + i * 16 * scale - 6 * scale, cy + 44 * scale, TFT_BLUE);
    }
  } else if (icon && strcmp(icon, "STORM") == 0) {
    epaper.drawLine(cx, cy + 26 * scale, cx - 8 * scale, cy + 48 * scale, TFT_RED);
    epaper.drawLine(cx - 8 * scale, cy + 48 * scale, cx + 7 * scale, cy + 40 * scale, TFT_RED);
    epaper.drawLine(cx + 7 * scale, cy + 40 * scale, cx - 2 * scale, cy + 60 * scale, TFT_RED);
  } else if (icon && strcmp(icon, "FOG") == 0) {
    epaper.drawLine(cx - 34 * scale, cy + 34 * scale, cx + 34 * scale, cy + 34 * scale, color);
    epaper.drawLine(cx - 28 * scale, cy + 45 * scale, cx + 28 * scale, cy + 45 * scale, color);
  } else if (icon && strcmp(icon, "SNOW") == 0) {
    for (int i = -1; i <= 1; ++i) {
      const int sx = cx + i * 16 * scale;
      const int sy = cy + 36 * scale;
      epaper.drawLine(sx - 5 * scale, sy, sx + 5 * scale, sy, TFT_BLUE);
      epaper.drawLine(sx, sy - 5 * scale, sx, sy + 5 * scale, TFT_BLUE);
      epaper.drawLine(sx - 4 * scale, sy - 4 * scale, sx + 4 * scale, sy + 4 * scale, TFT_BLUE);
      epaper.drawLine(sx - 4 * scale, sy + 4 * scale, sx + 4 * scale, sy - 4 * scale, TFT_BLUE);
    }
  }
}

static void drawWeatherHeader(const WeatherPayload& payload, const char* subPageIndicator) {
  text("WEATHER", 28, 24, 4, TFT_BLUE);
  centered(payload.location, 400, 34, 3, TFT_BLACK);
  text(payload.source, 772, 18, 2, TFT_BLACK, TR_DATUM);
  if (subPageIndicator && subPageIndicator[0] != '\0') {
    text(subPageIndicator, 772, 45, 2, TFT_GREEN, TR_DATUM);
  }
  epaper.drawLine(20, 72, 780, 72, TFT_BLACK);
}

static void drawMetricBox(int x, int y, int w, int h, const char* label, const char* value, uint16_t valueColor = TFT_BLACK) {
  epaper.drawRect(x, y, w, h, TFT_BLACK);
  text(label, x + 12, y + 12, 2, TFT_BLUE);
  centered(value, x + w / 2, y + h / 2 + 14, 3, valueColor);
}

static void drawTemperatureMetricBox(int x, int y, int w, int h, const char* label, int16_t value, uint16_t valueColor = TFT_BLACK) {
  epaper.drawRect(x, y, w, h, TFT_BLACK);
  text(label, x + 12, y + 12, 2, TFT_BLUE);
  drawTemperatureCentered(value, x + w / 2, y + h / 2 + 14, 3, valueColor);
}

static void drawSmallMetricBox(int x, int y, int w, int h, const char* label, const char* value, uint16_t valueColor = TFT_BLACK) {
  epaper.drawRect(x, y, w, h, TFT_BLACK);
  text(label, x + 10, y + 10, 2, TFT_BLUE);
  centered(value, x + w / 2, y + h / 2 + 12, 3, valueColor);
}

static void renderWeatherNow(const WeatherPayload& payload) {
  drawWeatherIcon(payload.current.icon, 116, 164, 2);
  centered(payload.current.condition, 116, 286, 3, TFT_BLACK);

  drawTemperatureCentered(payload.current.tempC, 300, 154, 8, TFT_RED);
  centered("FEELS", 300, 224, 2, TFT_BLACK);
  drawTemperatureCentered(payload.current.feelsLikeC, 300, 258, 3, TFT_BLACK);

  char humidity[20], wind[24], pm25[20], uv[20], windSpeed[12];
  char aqi[16], visibility[16], cloud[16], localRain[16];
  formatIntValue(payload.current.humidityPercent, "%", humidity, sizeof(humidity));
  formatIntValue(payload.current.windKph, "kph", windSpeed, sizeof(windSpeed));
  snprintf(wind, sizeof(wind), "%s %s", payload.current.windText, windSpeed);
  formatIntValue(payload.current.pm25, "", pm25, sizeof(pm25));
  formatTenthsValue(payload.current.uvIndexTenths, "", uv, sizeof(uv));
  formatIntValue(payload.details.aqiChn, "", aqi, sizeof(aqi));
  formatTenthsValue(payload.details.visibilityTenthsKm, "km", visibility, sizeof(visibility));
  formatIntValue(payload.details.cloudPercent, "%", cloud, sizeof(cloud));
  formatTenthsValue(payload.details.localRainIntensityTenths, "mm/h", localRain, sizeof(localRain));

  static constexpr int x1 = 428;
  static constexpr int x2 = 598;
  static constexpr int w = 150;
  static constexpr int h = 58;
  drawSmallMetricBox(x1, 96, w, h, "HUMID", humidity, TFT_BLUE);
  drawSmallMetricBox(x2, 96, w, h, "WIND", wind, TFT_BLACK);
  drawSmallMetricBox(x1, 166, w, h, "AQI", aqi, TFT_GREEN);
  drawSmallMetricBox(x2, 166, w, h, "VIS", visibility, TFT_BLUE);
  drawSmallMetricBox(x1, 236, w, h, "CLOUD", cloud, TFT_BLACK);
  drawSmallMetricBox(x2, 236, w, h, "RAIN", localRain, TFT_BLUE);
  drawSmallMetricBox(x1, 306, w, h, "PM2.5", pm25, TFT_GREEN);
  drawSmallMetricBox(x2, 306, w, h, "UV", uv, TFT_BLACK);
}

static void renderWeatherToday(const WeatherPayload& payload) {
  char rainProb[16], rainMm[16], uv[16], pressure[16];
  char comfort[16], dressing[16], coldRisk[16];
  formatIntValue(payload.today.precipProbPercent, "%", rainProb, sizeof(rainProb));
  formatTenthsValue(payload.today.precipTenthsMm, "mm", rainMm, sizeof(rainMm));
  formatTenthsValue(payload.today.uvIndexTenths, "", uv, sizeof(uv));
  formatIntValue(payload.current.pressureHpa, "hPa", pressure, sizeof(pressure));
  formatIntValue(payload.details.comfortIndex, "", comfort, sizeof(comfort));
  formatIntValue(payload.details.dressingIndex, "", dressing, sizeof(dressing));
  formatIntValue(payload.details.coldRiskIndex, "", coldRisk, sizeof(coldRisk));

  drawTemperatureMetricBox(50, 96, 210, 78, "HIGH", payload.today.highC, TFT_RED);
  drawTemperatureMetricBox(295, 96, 210, 78, "LOW", payload.today.lowC, TFT_BLUE);
  drawMetricBox(540, 96, 210, 78, "RAIN PROB", rainProb, TFT_BLUE);
  drawMetricBox(50, 198, 210, 78, "RAIN SUM", rainMm, TFT_BLUE);
  drawMetricBox(295, 198, 210, 78, "UV MAX", uv, TFT_BLACK);
  drawMetricBox(540, 198, 210, 78, "PRESSURE", pressure, TFT_BLACK);

  drawSmallMetricBox(36, 304, 124, 70, "SUNRISE", payload.today.sunriseText, TFT_BLACK);
  drawSmallMetricBox(187, 304, 124, 70, "SUNSET", payload.today.sunsetText, TFT_RED);
  drawSmallMetricBox(338, 304, 124, 70, "COMFORT", comfort, TFT_BLACK);
  drawSmallMetricBox(489, 304, 124, 70, "DRESS", dressing, TFT_BLACK);
  drawSmallMetricBox(640, 304, 124, 70, "COLD", coldRisk, TFT_BLACK);
}

static void renderWeatherHours(const WeatherPayload& payload) {
  for (int i = 0; i < payload.hourlyCount && i < 6; ++i) {
    const WeatherHour& hour = payload.hourly[i];
    const int x = 36 + i * 124;
    epaper.drawRect(x, 96, 118, 224, TFT_BLACK);
    centered(hour.timeText, x + 59, 120, 2, TFT_BLACK);
    drawWeatherIcon(hour.icon, x + 59, 176, 1);
    drawTemperatureCentered(hour.tempC, x + 59, 238, 3, TFT_RED);
    char rain[16];
    formatIntValue(hour.precipProbPercent, "%", rain, sizeof(rain));
    centered(rain, x + 59, 292, 2, TFT_BLUE);
  }
  if (payload.hourlyCount == 0) {
    centered("NO HOURLY DATA", 400, 210, 4, TFT_RED);
  }

  char nearDistance[16], nearRain[16], nearLine[48];
  formatTenthsValue(payload.details.nearestRainDistanceTenthsKm, "km", nearDistance, sizeof(nearDistance));
  formatTenthsValue(payload.details.nearestRainIntensityTenths, "mm/h", nearRain, sizeof(nearRain));
  snprintf(nearLine, sizeof(nearLine), "NEAR RAIN: %s / %s", nearDistance, nearRain);
  centered(nearLine, 400, 342, 2, TFT_BLACK);

  for (int i = 0; i < payload.dailyCount && i < 3; ++i) {
    const WeatherDay& day = payload.daily[i];
    const int x = 92 + i * 220;
    centered(day.dayText, x, 372, 2, TFT_BLUE);
    drawTemperatureRangeCentered(day.highC, day.lowC, x, 399, 2, TFT_BLACK);
  }
}

void renderWeatherPage(const WeatherPayload& payload, const char* pageIndicator, const char* subPageIndicator, const BatteryStatus& battery) {
  epaper.begin();
  epaper.fillScreen(TFT_WHITE);
  epaper.drawRect(0, 0, 800, 480, TFT_BLACK);
  epaper.drawRect(3, 3, 794, 474, TFT_BLACK);

  drawWeatherHeader(payload, subPageIndicator);
  if (payload.slot == 2) {
    renderWeatherToday(payload);
  } else if (payload.slot == 3) {
    renderWeatherHours(payload);
  } else {
    renderWeatherNow(payload);
  }
  drawFooter(pageIndicator, subPageIndicator, battery);

  Serial1.println("[display] weather update start");
  Serial1.flush();
  const uint32_t start = millis();
  epaper.update();
  Serial1.printf("[display] weather update done in %lu ms\n", static_cast<unsigned long>(millis() - start));
  epaper.sleep();
}

void renderWeatherErrorPage(const char* category, const char* pageIndicator, const char* subPageIndicator, const BatteryStatus& battery) {
  epaper.begin();
  epaper.fillScreen(TFT_WHITE);
  epaper.drawRect(0, 0, 800, 480, TFT_BLACK);
  epaper.drawRect(3, 3, 794, 474, TFT_BLACK);

  text("WEATHER", 28, 24, 4, TFT_BLUE);
  text("ERROR", 772, 24, 3, TFT_RED, TR_DATUM);
  epaper.drawLine(20, 72, 780, 72, TFT_BLACK);
  centered("WEATHER ERROR", 400, 185, 5, TFT_RED);
  centered(category ? category : "unknown", 400, 260, 3, TFT_BLACK);
  centered("CHECK MAC CONFIG PAGE", 400, 325, 2, TFT_BLUE);
  drawFooter(pageIndicator, subPageIndicator, battery);

  Serial1.println("[display] weather error update start");
  Serial1.flush();
  const uint32_t start = millis();
  epaper.update();
  Serial1.printf("[display] weather error update done in %lu ms\n", static_cast<unsigned long>(millis() - start));
  epaper.sleep();
}
#endif

void renderSetupError(const char* category) {
  epaper.begin();
  epaper.fillScreen(TFT_WHITE);
  epaper.drawRect(0, 0, 800, 480, TFT_BLACK);
  epaper.drawRect(3, 3, 794, 474, TFT_BLACK);
  centered("SETUP ERROR", 400, 140, 6, TFT_RED);
  centered(category, 400, 230, 3, TFT_BLACK);
  centered("CHECK WIFI AND MAC API", 400, 300, 3, TFT_BLUE);
  centered("NO TOKEN PRINTED", 400, 360, 2, TFT_BLACK);

  Serial1.println("[display] setup error update start");
  Serial1.flush();
  const uint32_t start = millis();
  epaper.update();
  Serial1.printf("[display] setup error update done in %lu ms\n", static_cast<unsigned long>(millis() - start));
  epaper.sleep();
}

void renderWifiSetupPage(const char* apSsid, const char* apPassword, const char* setupUrl, const char* reason) {
  epaper.begin();
  epaper.fillScreen(TFT_WHITE);
  epaper.drawRect(0, 0, 800, 480, TFT_BLACK);
  epaper.drawRect(3, 3, 794, 474, TFT_BLACK);

  text("WIFI SETUP", 28, 24, 4, TFT_BLUE);
  text("PORTAL", 772, 24, 3, TFT_BLACK, TR_DATUM);
  epaper.drawLine(20, 72, 780, 72, TFT_BLACK);

  centered("CONNECT TO E1002 WIFI", 400, 120, 3, TFT_BLACK);
  centered(apSsid, 400, 175, 4, TFT_BLUE);
  centered("PASSWORD", 400, 230, 2, TFT_BLACK);
  centered(apPassword, 400, 265, 3, TFT_BLACK);
  centered("OPEN", 400, 320, 2, TFT_BLACK);
  centered(setupUrl, 400, 355, 3, TFT_GREEN);

  text("REASON", 34, 430, 2, TFT_BLACK);
  text(reason ? reason : "setup", 148, 430, 2, TFT_RED);

  Serial1.println("[display] wifi setup update start");
  Serial1.flush();
  const uint32_t start = millis();
  epaper.update();
  Serial1.printf("[display] wifi setup update done in %lu ms\n", static_cast<unsigned long>(millis() - start));
  epaper.sleep();
}

void renderProvisioningSavedPage() {
  epaper.begin();
  epaper.fillScreen(TFT_WHITE);
  epaper.drawRect(0, 0, 800, 480, TFT_BLACK);
  epaper.drawRect(3, 3, 794, 474, TFT_BLACK);
  centered("SETUP SAVED", 400, 165, 6, TFT_GREEN);
  centered("REBOOTING", 400, 250, 4, TFT_BLACK);
  centered("DO NOT REMOVE POWER", 400, 320, 2, TFT_BLUE);

  Serial1.println("[display] provisioning saved update start");
  Serial1.flush();
  const uint32_t start = millis();
  epaper.update();
  Serial1.printf("[display] provisioning saved update done in %lu ms\n", static_cast<unsigned long>(millis() - start));
  epaper.sleep();
}
