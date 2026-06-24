#include "display.h"

#include <Arduino.h>
#include <string.h>
#include "meal_image_client.h"
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

static uint16_t batteryColor(const BatteryStatus& battery) {
  if (!battery.valid) {
    return TFT_BLACK;
  }
  return percentColor(battery.percent);
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
  epaper.drawRect(x, y, w, h, TFT_BLACK);
  epaper.drawRect(x + 1, y + 1, w - 2, h - 2, TFT_BLACK);
  epaper.drawRect(x + 2, y + 2, w - 4, h - 4, TFT_BLACK);

  centered(window.title, x + w / 2, y + 34, 3, TFT_BLUE);

  char pct[8];
  snprintf(pct, sizeof(pct), "%d%%", window.remainingPercent);
  centered(pct, x + w / 2, y + 105, 8, color);

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
  text("HOLD:SUB", 280, 432, 2, TFT_BLACK);
  text("G:REFRESH", 420, 432, 2, TFT_BLACK);
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
