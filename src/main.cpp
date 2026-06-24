#include <Arduino.h>
#include <WiFi.h>
#include <string.h>
#include "esp_sleep.h"

#include "battery.h"
#include "display.h"
#include "input_manager.h"
#include "meal_image_client.h"
#include "page_manager.h"
#include "power.h"
#include "provisioning.h"
#include "quota_client.h"

static constexpr const char* FIRMWARE_VERSION = "codex-e1002-quota-0.5.1";
static constexpr int kDbgRx = 44;
static constexpr int kDbgTx = 43;
static constexpr uint32_t kWifiConnectTimeoutMs = 15000;
static constexpr uint32_t kConfigPortalHoldMs = 1200;
static constexpr uint32_t kPersistentMagic = 0xE1002C0DUL;
static constexpr uint16_t kPersistentVersion = 2;

struct PersistentUiState {
  uint32_t magic;
  uint16_t version;
  uint8_t currentPageSlot;
  uint8_t lastDisplayedPageSlot;
  uint32_t lastDisplayedContentHash;
  uint16_t cyclesSinceRender;
  uint16_t consecutiveFailures;
  bool hasRenderedValidData;
  bool hasRenderedSetupError;
  uint8_t currentMealSlot;
  uint8_t lastMealSlotCount;
};

RTC_DATA_ATTR PersistentUiState uiState;

static void resetPersistentState() {
  memset(&uiState, 0, sizeof(uiState));
  uiState.magic = kPersistentMagic;
  uiState.version = kPersistentVersion;
  uiState.currentPageSlot = PageManager::kDefaultSlot;
  uiState.currentMealSlot = 1;
  uiState.lastMealSlotCount = 4;
}

static bool connectWifi(const DeviceSettings& settings) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(settings.wifiSsid, settings.wifiPassword);
  const uint32_t start = millis();
  Serial1.print("[wifi] connecting");
  while (WiFi.status() != WL_CONNECTED && millis() - start < kWifiConnectTimeoutMs) {
    delay(500);
    Serial1.print(".");
  }
  Serial1.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial1.printf("[wifi] connected  : ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return true;
  }

  Serial1.printf("[wifi] failed     : status=%d\n", WiFi.status());
  return false;
}

static void shutdownWifi() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  Serial1.println("[wifi] off");
}

static void logPayloadSummary(const QuotaPayload& payload) {
  Serial1.printf("[json] schema    : %d\n", payload.schemaVersion);
  Serial1.printf("[json] plan      : %s\n", payload.plan);
  Serial1.printf("[json] status    : %s%s\n", payload.status, payload.hadFormatIssue ? " format-issue" : "");
  if (payload.hasUsage) {
    Serial1.printf("[usage] total    : %s\n", payload.totalTokensText);
    Serial1.printf("[usage] today    : %s\n", payload.todayTokensText);
  }
  for (size_t i = 0; i < payload.windowCount; ++i) {
    Serial1.printf("[quota] %s       : %d%% reset=%s\n",
                   payload.windows[i].title,
                   payload.windows[i].remainingPercent,
                   payload.windows[i].resetText);
  }
}

static void logMealSummary(const MealImageMeta& meta) {
  Serial1.printf("[meal] date      : %s %s\n", meta.date, meta.weekday);
  Serial1.printf("[meal] slot      : M%u/%u title=%s\n",
                 static_cast<unsigned>(meta.slot),
                 static_cast<unsigned>(meta.slotCount),
                 meta.mealTitle);
  Serial1.printf("[meal] raw bytes : %u hash=%.12s\n",
                 static_cast<unsigned>(meta.rawBytes),
                 meta.imageHash);
}

static uint32_t mixHash(uint32_t hash, uint32_t value) {
  return hash ^ (value + 0x9e3779b9UL + (hash << 6) + (hash >> 2));
}

static void logBatterySummary(const BatteryStatus& battery) {
  if (!battery.valid) {
    Serial1.printf("[battery] invalid   : %u mV\n", static_cast<unsigned>(battery.millivolts));
    return;
  }
  Serial1.printf("[battery] level     : %u mV %u%%\n",
                 static_cast<unsigned>(battery.millivolts),
                 static_cast<unsigned>(battery.percent));
}

static void handleFailure(const char* category) {
  uiState.consecutiveFailures++;
  uiState.cyclesSinceRender++;
  Serial1.printf("[error] category  : %s\n", category);
  Serial1.printf("[error] failures  : %u\n", static_cast<unsigned>(uiState.consecutiveFailures));

  if (uiState.hasRenderedValidData) {
    Serial1.println("[display] keeping previous valid ePaper image");
    return;
  }

  if (!uiState.hasRenderedSetupError) {
    renderSetupError(category);
    uiState.hasRenderedSetupError = true;
  } else {
    Serial1.println("[display] setup error already rendered; skip refresh");
  }
}

static bool restorePersistentState(PageManager* pages, esp_sleep_wakeup_cause_t wakeCause) {
  bool reset = wakeCause == ESP_SLEEP_WAKEUP_UNDEFINED ||
               uiState.magic != kPersistentMagic ||
               uiState.version != kPersistentVersion;
  if (reset) {
    resetPersistentState();
  }
  if (!pages->isValidSlot(uiState.currentPageSlot)) {
    Serial1.printf("[state] invalid current page slot=%u; reset to P1\n", static_cast<unsigned>(uiState.currentPageSlot));
    uiState.currentPageSlot = PageManager::kDefaultSlot;
    reset = true;
  }
  if (uiState.currentMealSlot == 0) {
    uiState.currentMealSlot = 1;
  }
  if (uiState.lastMealSlotCount == 0) {
    uiState.lastMealSlotCount = 4;
  }
  pages->goToSlot(uiState.currentPageSlot);
  return reset;
}

static void logPageRegistry() {
  Serial1.printf("[PAGE] registry count=%u\n", static_cast<unsigned>(PageManager::registryCount()));
  for (size_t i = 0; i < PageManager::registryCount(); ++i) {
    const PageDescriptor& page = PageManager::registry()[i];
    Serial1.printf("[PAGE] slot=%u id=%s policy=%s\n",
                   static_cast<unsigned>(page.slot),
                   pageIdName(page.id),
                   refreshPolicyName(page.refreshPolicy));
  }
}

static bool shouldUseWifi(const PageManager& pages,
                          RefreshReason reason,
                          InputActionType actionType,
                          bool pageChanged,
                          bool coldBootLike,
                          bool ambiguousInput) {
  if (ambiguousInput || pages.currentPage().refreshPolicy != RefreshPolicy::PeriodicData) {
    return false;
  }
  if (reason == RefreshReason::DirectNavigation && !pageChanged) {
    return false;
  }
  if (coldBootLike || reason == RefreshReason::Timer || reason == RefreshReason::ManualRefresh || pageChanged) {
    return true;
  }
  return actionType != InputActionType::GoToPage;
}

static RefreshDecision decidePageRefresh(const PageManager& pages,
                                         uint32_t pageHash,
                                         RefreshReason reason,
                                         bool pageChanged,
                                         bool coldBootLike,
                                         InputActionType actionType) {
  if (coldBootLike) {
    return {true, "cold boot"};
  }
  if (pageChanged) {
    return {true, "page changed"};
  }
  if (reason == RefreshReason::ManualRefresh) {
    return {true, "manual refresh"};
  }
  if (reason == RefreshReason::DirectNavigation && !pageChanged) {
    return {false, "direct target unchanged or invalid"};
  }
  if (pages.currentPage().refreshPolicy == RefreshPolicy::Static) {
    return {false, "static page timer skip"};
  }
  if (reason == RefreshReason::SubPageNavigation) {
    return {true, "subpage navigation"};
  }
  if (!uiState.hasRenderedValidData) {
    return {true, "first valid page"};
  }
  if (pageHash != uiState.lastDisplayedContentHash) {
    return {true, "display hash changed"};
  }
  if (uiState.cyclesSinceRender >= 12) {
    return {true, "hourly forced refresh"};
  }
  return {false, "display hash unchanged"};
}

static uint8_t nextMealSlot(uint8_t current, uint8_t count) {
  const uint8_t safeCount = count == 0 ? 1 : count;
  const uint8_t safeCurrent = current == 0 ? 1 : current;
  return safeCurrent >= safeCount ? 1 : static_cast<uint8_t>(safeCurrent + 1);
}

static void formatMealIndicator(char* out, size_t outSize) {
  if (!out || outSize == 0) {
    return;
  }
  snprintf(out, outSize, "M%u/%u",
           static_cast<unsigned>(uiState.currentMealSlot == 0 ? 1 : uiState.currentMealSlot),
           static_cast<unsigned>(uiState.lastMealSlotCount == 0 ? 1 : uiState.lastMealSlotCount));
}

static void renderMealFailureAndSleep(const PageManager& pages,
                                      const BatteryStatus& battery,
                                      const char* category) {
  if (uiState.hasRenderedValidData && uiState.lastDisplayedPageSlot == pages.currentSlot()) {
    Serial1.printf("[meal] failure   : %s; keeping current meal image\n", category);
    uiState.currentPageSlot = pages.currentSlot();
    uiState.cyclesSinceRender++;
    enterDeepSleep();
  }

  char subIndicator[12];
  formatMealIndicator(subIndicator, sizeof(subIndicator));
  PageRenderData renderData{nullptr, nullptr, 0, category, subIndicator};
  pages.refreshCurrentPage(renderData, battery);
  uiState.currentPageSlot = pages.currentSlot();
  uiState.lastDisplayedPageSlot = pages.currentSlot();
  uiState.lastDisplayedContentHash = 0;
  uiState.cyclesSinceRender = 0;
  uiState.hasRenderedValidData = true;
  enterDeepSleep();
}

static void logAction(const InputAction& action) {
  Serial1.printf("[INPUT] action=%s target=%u clicks=%u\n",
                 inputActionName(action.type),
                 static_cast<unsigned>(action.targetPageSlot),
                 static_cast<unsigned>(action.clickCount));
}

static void startProvisioningAndSleep(const DeviceSettings& current, const char* reason) {
  Serial1.printf("[setup] portal reason=%s\n", reason ? reason : "setup");
  renderWifiSetupPage(kProvisioningApSsid, kProvisioningApPassword, kProvisioningApUrl, reason);
  const bool saved = runProvisioningPortal(current, reason);
  if (saved) {
    renderProvisioningSavedPage();
    Serial1.println("[setup] saved; restarting");
    Serial1.flush();
    delay(1000);
    ESP.restart();
  }
  Serial1.println("[setup] portal timeout; sleeping");
  enterDeepSleep();
}

void setup() {
  Serial1.begin(115200, SERIAL_8N1, kDbgRx, kDbgTx);
  delay(20);
  initButtons();

  const esp_sleep_wakeup_cause_t wakeCause = esp_sleep_get_wakeup_cause();
  const uint64_t wakeMask = wakeCause == ESP_SLEEP_WAKEUP_EXT1 ? ext1WakeStatus() : 0;
  PageManager pages;
  const bool stateReset = restorePersistentState(&pages, wakeCause);
  const bool coldBootLike = wakeCause == ESP_SLEEP_WAKEUP_UNDEFINED || stateReset;
  if (coldBootLike) {
    pages.goToSlot(PageManager::kDefaultSlot);
    uiState.currentPageSlot = PageManager::kDefaultSlot;
  }

  const uint8_t fromSlot = pages.currentSlot();
  InputAction action{InputActionType::None, 0, 0};
  RefreshReason reason = coldBootLike ? RefreshReason::ColdBoot : RefreshReason::Timer;
  PhysicalButton physicalButton = PhysicalButton::None;
  DeviceSettings settings{};
  const bool hasSettings = loadDeviceSettings(&settings);
  bool forcePortal = false;
  if (coldBootLike && digitalRead(PIN_KEY2_LEFT) == LOW) {
    const uint32_t holdStart = millis();
    while (digitalRead(PIN_KEY2_LEFT) == LOW && millis() - holdStart < kConfigPortalHoldMs) {
      delay(10);
    }
    forcePortal = digitalRead(PIN_KEY2_LEFT) == LOW;
  }

  if (!coldBootLike && wakeCause == ESP_SLEEP_WAKEUP_EXT1) {
    physicalButton = buttonFromWakeMask(wakeMask);
    if (physicalButton == PhysicalButton::Key2Left) {
      const uint32_t holdStart = millis();
      while (digitalRead(PIN_KEY2_LEFT) == LOW && millis() - holdStart < kConfigPortalHoldMs) {
        delay(10);
      }
      if (digitalRead(PIN_KEY2_LEFT) == LOW) {
        forcePortal = true;
        reason = RefreshReason::DirectNavigation;
      } else {
        action = collectDirectPageClicksFromWake(static_cast<uint8_t>(pages.pageCount()));
        reason = RefreshReason::DirectNavigation;
      }
    } else {
      action = physicalButton == PhysicalButton::Key1Middle ? collectMiddleButtonActionFromWake() : actionFromWakeMask(wakeMask);
      if (physicalButton == PhysicalButton::Key0Green) {
        reason = RefreshReason::ManualRefresh;
      } else if (physicalButton == PhysicalButton::Key1Middle && action.type == InputActionType::NextPage) {
        reason = RefreshReason::NextNavigation;
      } else if (physicalButton == PhysicalButton::Key1Middle && action.type == InputActionType::NextSubPage) {
        reason = RefreshReason::SubPageNavigation;
      }
      if (action.type != InputActionType::NextSubPage) {
        waitForAllButtonsReleased(BUTTON_RELEASE_TIMEOUT_MS);
        delay(BUTTON_DEBOUNCE_MS);
      }
    }
  } else if (!coldBootLike && wakeCause == ESP_SLEEP_WAKEUP_TIMER) {
    reason = RefreshReason::Timer;
  }

  Serial1.println();
  Serial1.println("==============================================");
  Serial1.println("  CODEX E1002 multi-page firmware");
  Serial1.println("==============================================");
  Serial1.printf("[fw] version     : %s\n", FIRMWARE_VERSION);
  Serial1.printf("[WAKE] cause=%s mask=0x%llx\n", wakeReasonName(), static_cast<unsigned long long>(wakeMask));
  Serial1.printf("[sys] psram      : %lu/%lu kB free/total\n",
                 static_cast<unsigned long>(ESP.getFreePsram() / 1024),
                 static_cast<unsigned long>(ESP.getPsramSize() / 1024));
  Serial1.printf("[setup] config    : %s%s\n",
                 hasSettings ? "present" : "missing",
                 settings.fromBootstrap ? " bootstrap" : "");
  logQuotaApiTarget(settings.quotaApiUrl);
  logPageRegistry();

  if (forcePortal) {
    startProvisioningAndSleep(settings, "button");
  }

  if (!coldBootLike && wakeCause == ESP_SLEEP_WAKEUP_EXT1) {
    Serial1.printf("[INPUT] physical=%s\n", physicalButtonName(physicalButton));
  }

  logAction(action);

  bool pageChanged = false;
  bool ambiguousInput = action.type == InputActionType::Ambiguous;
  if (action.type == InputActionType::Ambiguous) {
    Serial1.printf("[INPUT] ambiguous wake bitmask=0x%llx; keeping current page\n",
                   static_cast<unsigned long long>(wakeMask));
  } else if (action.type == InputActionType::NextPage) {
    const uint8_t before = pages.currentSlot();
    pages.nextPage();
    pageChanged = pages.currentSlot() != before;
  } else if (action.type == InputActionType::NextSubPage) {
    if (pages.currentPage().id == PageId::TodayMeal) {
      uiState.currentMealSlot = nextMealSlot(uiState.currentMealSlot, uiState.lastMealSlotCount);
    } else {
      Serial1.println("[INPUT] subpage action ignored on page without subpages");
      reason = RefreshReason::Timer;
    }
  } else if (action.type == InputActionType::GoToPage && action.targetPageSlot > 0) {
    const uint8_t before = pages.currentSlot();
    if (pages.isValidSlot(action.targetPageSlot)) {
      pages.goToSlot(action.targetPageSlot);
      pageChanged = pages.currentSlot() != before;
    } else {
      Serial1.printf("[INPUT] invalid direct page slot=%u\n", static_cast<unsigned>(action.targetPageSlot));
    }
  }

  char indicator[12];
  pages.formatPageIndicator(indicator, sizeof(indicator));
  char subIndicator[12] = "";
  if (pages.currentPage().id == PageId::TodayMeal) {
    formatMealIndicator(subIndicator, sizeof(subIndicator));
  }
  Serial1.printf("[NAV] P%u -> P%u reason=%s\n",
                 static_cast<unsigned>(fromSlot),
                 static_cast<unsigned>(pages.currentSlot()),
                 refreshReasonName(reason));
  Serial1.printf("[PAGE] id=%s policy=%s indicator=%s\n",
                 pageIdName(pages.currentPage().id),
                 refreshPolicyName(pages.currentPage().refreshPolicy),
                 indicator);
  if (subIndicator[0] != '\0') {
    Serial1.printf("[PAGE] sub       : %s\n", subIndicator);
  }

  const BatteryStatus battery = readBatteryStatus();
  logBatterySummary(battery);

  const bool needsWifi = shouldUseWifi(pages, reason, action.type, pageChanged, coldBootLike, ambiguousInput);
  Serial1.printf("[NET] connect Wi-Fi=%s\n", needsWifi ? "yes" : "no");

  QuotaPayload payload{};
  QuotaPayload* payloadPtr = nullptr;
  MealImageMeta mealMeta{};
  MealImageMeta* mealMetaPtr = nullptr;
  bool wifiStillOn = false;
  if (needsWifi) {
    if (!hasSettings) {
      startProvisioningAndSleep(settings, "missing-config");
    }
    bool wifiConnected = connectWifi(settings);
    if (!wifiConnected) {
      if (pages.currentPage().id == PageId::TodayMeal) {
        renderMealFailureAndSleep(pages, battery, "wifi");
      }
      if (!uiState.hasRenderedValidData) {
        shutdownWifi();
        startProvisioningAndSleep(settings, "wifi-failed");
      }
      handleFailure("wifi");
      shutdownWifi();
      enterDeepSleep();
    }

    if (pages.currentPage().id == PageId::CodexQuota) {
      FetchResult fetched = fetchQuotaPayload(settings.quotaApiUrl);
      shutdownWifi();

      if (!fetched.ok) {
        const char* category = fetched.httpStatus == 0 ? quotaErrorName(fetched.error) : "api";
        if (!uiState.hasRenderedValidData && fetched.error == QuotaError::MissingField) {
          startProvisioningAndSleep(settings, "api-config");
        }
        handleFailure(category);
        enterDeepSleep();
      }

      uiState.consecutiveFailures = 0;
      uiState.hasRenderedSetupError = false;
      payload = fetched.payload;
      payloadPtr = &payload;
      logPayloadSummary(payload);
    } else if (pages.currentPage().id == PageId::TodayMeal) {
      FetchMealMetaResult fetched = fetchMealImageMeta(settings.quotaApiUrl, uiState.currentMealSlot);
      if (!fetched.ok) {
        shutdownWifi();
        renderMealFailureAndSleep(pages, battery, mealImageErrorName(fetched.error));
      }
      wifiStillOn = true;
      uiState.currentMealSlot = fetched.meta.slot;
      uiState.lastMealSlotCount = fetched.meta.slotCount;
      formatMealIndicator(subIndicator, sizeof(subIndicator));
      mealMeta = fetched.meta;
      mealMetaPtr = &mealMeta;
      logMealSummary(mealMeta);
    }
  }

  uint32_t pagePayloadHash = 0;
  if (pages.currentPage().id == PageId::CodexQuota && payloadPtr) {
    pagePayloadHash = quotaRenderHash(*payloadPtr);
  } else if (pages.currentPage().id == PageId::TodayMeal && mealMetaPtr) {
    pagePayloadHash = mealImageMetaHash(*mealMetaPtr);
  } else if (pages.currentPage().id == PageId::TodayMeal) {
    pagePayloadHash = mealPlaceholderHash();
  }
  pagePayloadHash = mixHash(pagePayloadHash, batteryRenderHash(battery));
  const uint32_t pageHash = pages.currentPageContentHash(pagePayloadHash, indicator);
  RefreshDecision decision = ambiguousInput ?
    RefreshDecision{false, "ambiguous input"} :
    decidePageRefresh(pages, pageHash, reason, pageChanged, coldBootLike, action.type);

  Serial1.printf("[render] hash     : 0x%08lx\n", static_cast<unsigned long>(pageHash));
  Serial1.printf("[render] decision : %s (%s)\n", decision.shouldRefresh ? "refresh" : "skip", decision.reason);

  if (decision.shouldRefresh) {
    uint8_t* mealImage = nullptr;
    const char* mealError = nullptr;
    if (pages.currentPage().id == PageId::TodayMeal) {
      mealImage = static_cast<uint8_t*>(ps_malloc(kMealImageBytes));
      if (!mealImage) {
        if (wifiStillOn) {
          shutdownWifi();
          wifiStillOn = false;
        }
        renderMealFailureAndSleep(pages, battery, "no-psram");
      }
      FetchMealRawResult raw = fetchMealImageRaw4bpp(settings.quotaApiUrl, uiState.currentMealSlot, mealImage, kMealImageBytes);
      if (wifiStillOn) {
        shutdownWifi();
        wifiStillOn = false;
      }
      if (!raw.ok) {
        free(mealImage);
        renderMealFailureAndSleep(pages, battery, mealImageErrorName(raw.error));
      }
      Serial1.printf("[meal] raw bytes : %u\n", static_cast<unsigned>(raw.bytesRead));
    }
    PageRenderData renderData{payloadPtr, mealImage, mealImage ? kMealImageBytes : 0, mealError, subIndicator};
    pages.refreshCurrentPage(renderData, battery);
    if (mealImage) {
      free(mealImage);
    }
    uiState.currentPageSlot = pages.currentSlot();
    uiState.lastDisplayedContentHash = pageHash;
    uiState.lastDisplayedPageSlot = pages.currentSlot();
    uiState.cyclesSinceRender = 0;
    uiState.hasRenderedValidData = true;
  } else {
    if (wifiStillOn) {
      shutdownWifi();
      wifiStillOn = false;
    }
    uiState.currentPageSlot = pageChanged ? fromSlot : pages.currentSlot();
    uiState.cyclesSinceRender++;
  }

  Serial1.printf("[render] cycles   : %u\n", static_cast<unsigned>(uiState.cyclesSinceRender));
  enterDeepSleep();
}

void loop() {
}
