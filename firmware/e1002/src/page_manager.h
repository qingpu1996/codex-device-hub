#pragma once

#include <stddef.h>
#include <stdint.h>

#include "battery.h"
#include "feature_flags.h"
#if FEATURE_MEAL
#include "meal_image_client.h"
#endif
#include "quota_client.h"
#if FEATURE_WEATHER
#include "weather_client.h"
#endif

enum class PageId : uint8_t {
  CodexQuota = 1,
  TodayMeal = 2,
  Weather = 3,
};

enum class RefreshReason : uint8_t {
  ColdBoot,
  Timer,
  DirectNavigation,
  NextNavigation,
  SubPageNavigation,
  ManualRefresh,
};

enum class RefreshPolicy : uint8_t {
  PeriodicData,
  Static,
};

struct PageDescriptor {
  PageId id;
  uint8_t slot;
  const char* name;
  RefreshPolicy refreshPolicy;
};

struct PageRenderData {
  const QuotaPayload* quotaPayload;
#if FEATURE_MEAL
  const uint8_t* mealImage4bpp;
  size_t mealImageBytes;
  const char* mealError;
#endif
#if FEATURE_WEATHER
  const WeatherPayload* weatherPayload;
  const char* weatherError;
#endif
#if FEATURE_SUBPAGES
  const char* subPageIndicator;
#endif
};

class PageManager {
 public:
  static constexpr uint8_t kDefaultSlot = 1;

  explicit PageManager(uint8_t slot = kDefaultSlot);

  size_t pageCount() const;
  const PageDescriptor& currentPage() const;
  uint8_t currentSlot() const;
  bool goToSlot(uint8_t slot);
  bool nextPage();
  bool isValidSlot(uint8_t slot) const;
  const PageDescriptor* pageForSlot(uint8_t slot) const;
  void formatPageIndicator(char* out, size_t outSize) const;
  void formatPageIndicatorForSlot(uint8_t slot, char* out, size_t outSize) const;
  uint32_t currentPageContentHash(uint32_t pagePayloadHash, const char* indicator) const;
  uint32_t pageContentHash(uint8_t slot, uint32_t pagePayloadHash, const char* indicator) const;

#ifndef QUOTA_HOST_TEST
  void renderCurrentPage(const PageRenderData& data, const BatteryStatus& battery) const;
  void refreshCurrentPage(const PageRenderData& data, const BatteryStatus& battery) const;
#endif

  static const PageDescriptor* registry();
  static size_t registryCount();

 private:
  uint8_t currentSlot_;
};

const char* pageIdName(PageId id);
const char* refreshPolicyName(RefreshPolicy policy);
const char* refreshReasonName(RefreshReason reason);
uint32_t mealPlaceholderHash();
uint32_t weatherPlaceholderHash();
uint32_t composePagePayloadHash(PageId pageId, uint32_t contentHash, uint32_t batteryHash);
uint32_t pageDisplayHash(PageId pageId, uint32_t pagePayloadHash, const char* indicator);
