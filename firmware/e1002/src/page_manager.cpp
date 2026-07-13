#include "page_manager.h"

#include <stdio.h>
#include <string.h>

#include "feature_flags.h"

#ifndef QUOTA_HOST_TEST
#include "display.h"
#endif

static constexpr PageDescriptor kPages[] = {
  {PageId::CodexQuota, 1, "CodexQuota", RefreshPolicy::PeriodicData},
#if FEATURE_MEAL
  {PageId::TodayMeal, 2, "TodayMeal", RefreshPolicy::PeriodicData},
#endif
#if FEATURE_WEATHER
  {PageId::Weather, static_cast<uint8_t>(2 + (FEATURE_MEAL ? 1 : 0)), "Weather", RefreshPolicy::PeriodicData},
#endif
};

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

PageManager::PageManager(uint8_t slot) : currentSlot_(kDefaultSlot) {
  goToSlot(slot);
}

size_t PageManager::pageCount() const {
  return registryCount();
}

const PageDescriptor& PageManager::currentPage() const {
  const PageDescriptor* page = pageForSlot(currentSlot_);
  return page ? *page : kPages[0];
}

uint8_t PageManager::currentSlot() const {
  return currentSlot_;
}

bool PageManager::goToSlot(uint8_t slot) {
  if (!isValidSlot(slot)) {
    currentSlot_ = kDefaultSlot;
    return false;
  }
  currentSlot_ = slot;
  return true;
}

bool PageManager::nextPage() {
  const size_t count = pageCount();
  if (count == 0) {
    return false;
  }
  const uint8_t nextSlot = currentSlot_ >= count ? 1 : static_cast<uint8_t>(currentSlot_ + 1);
  return goToSlot(nextSlot);
}

bool PageManager::isValidSlot(uint8_t slot) const {
  return pageForSlot(slot) != nullptr;
}

const PageDescriptor* PageManager::pageForSlot(uint8_t slot) const {
  for (size_t i = 0; i < registryCount(); ++i) {
    if (kPages[i].slot == slot) {
      return &kPages[i];
    }
  }
  return nullptr;
}

void PageManager::formatPageIndicator(char* out, size_t outSize) const {
  formatPageIndicatorForSlot(currentSlot_, out, outSize);
}

void PageManager::formatPageIndicatorForSlot(uint8_t slot, char* out, size_t outSize) const {
  if (!out || outSize == 0) {
    return;
  }
  snprintf(out, outSize, "P%u/%u", static_cast<unsigned>(slot), static_cast<unsigned>(pageCount()));
}

uint32_t PageManager::currentPageContentHash(uint32_t pagePayloadHash, const char* indicator) const {
  return pageContentHash(currentSlot_, pagePayloadHash, indicator);
}

uint32_t PageManager::pageContentHash(uint8_t slot, uint32_t pagePayloadHash, const char* indicator) const {
  const PageDescriptor* page = pageForSlot(slot);
  return pageDisplayHash(page ? page->id : PageId::CodexQuota, pagePayloadHash, indicator);
}

#ifndef QUOTA_HOST_TEST
void PageManager::renderCurrentPage(const PageRenderData& data, const BatteryStatus& battery) const {
  char indicator[12];
  formatPageIndicator(indicator, sizeof(indicator));
  switch (currentPage().id) {
    case PageId::CodexQuota:
      if (data.quotaPayload) {
        renderQuotaPage(*data.quotaPayload, indicator, battery);
      }
      break;
#if FEATURE_MEAL
    case PageId::TodayMeal:
      if (data.mealImage4bpp && data.mealImageBytes == kMealImageBytes) {
#if FEATURE_SUBPAGES
        renderMealImagePage(data.mealImage4bpp, data.mealImageBytes, indicator, data.subPageIndicator, battery);
#else
        renderMealImagePage(data.mealImage4bpp, data.mealImageBytes, indicator, "", battery);
#endif
      } else if (data.mealError) {
#if FEATURE_SUBPAGES
        renderMealErrorPage(data.mealError, indicator, data.subPageIndicator, battery);
#else
        renderMealErrorPage(data.mealError, indicator, "", battery);
#endif
      } else {
        renderTodayMealPage(indicator, battery);
      }
      break;
#endif
#if FEATURE_WEATHER
    case PageId::Weather:
      if (data.weatherPayload) {
#if FEATURE_SUBPAGES
        renderWeatherPage(*data.weatherPayload, indicator, data.subPageIndicator, battery);
#else
        renderWeatherPage(*data.weatherPayload, indicator, "", battery);
#endif
      } else {
#if FEATURE_SUBPAGES
        renderWeatherErrorPage(data.weatherError ? data.weatherError : "no-data", indicator, data.subPageIndicator, battery);
#else
        renderWeatherErrorPage(data.weatherError ? data.weatherError : "no-data", indicator, "", battery);
#endif
      }
      break;
#endif
  }
}

void PageManager::refreshCurrentPage(const PageRenderData& data, const BatteryStatus& battery) const {
  renderCurrentPage(data, battery);
}
#endif

const PageDescriptor* PageManager::registry() {
  return kPages;
}

size_t PageManager::registryCount() {
  return sizeof(kPages) / sizeof(kPages[0]);
}

const char* pageIdName(PageId id) {
  switch (id) {
    case PageId::CodexQuota: return "CodexQuota";
    case PageId::TodayMeal: return "TodayMeal";
    case PageId::Weather: return "Weather";
  }
  return "Unknown";
}

const char* refreshPolicyName(RefreshPolicy policy) {
  switch (policy) {
    case RefreshPolicy::PeriodicData: return "PERIODIC_DATA";
    case RefreshPolicy::Static: return "STATIC";
  }
  return "UNKNOWN";
}

const char* refreshReasonName(RefreshReason reason) {
  switch (reason) {
    case RefreshReason::ColdBoot: return "COLD_BOOT";
    case RefreshReason::Timer: return "TIMER";
    case RefreshReason::DirectNavigation: return "DIRECT";
    case RefreshReason::NextNavigation: return "NEXT";
    case RefreshReason::SubPageNavigation: return "SUBPAGE";
    case RefreshReason::ManualRefresh: return "MANUAL";
  }
  return "UNKNOWN";
}

uint32_t mealPlaceholderHash() {
  uint32_t hash = 2166136261UL;
  hash = hashCString(hash, "MEAL PLAN");
  hash = hashCString(hash, "TODAY'S MENU");
  hash = hashCString(hash, "NOT CONFIGURED");
  hash = hashCString(hash, "MEAL DATA WILL BE ADDED NEXT");
  return hash;
}

uint32_t weatherPlaceholderHash() {
  uint32_t hash = 2166136261UL;
  hash = hashCString(hash, "WEATHER");
  hash = hashCString(hash, "NO DATA");
  return hash;
}

uint32_t composePagePayloadHash(PageId pageId, uint32_t contentHash, uint32_t batteryHash) {
  // Periodic quota checks should only refresh the ePaper when quota content
  // changes. ADC noise can move the battery label by 1% between wake cycles;
  // the latest battery value is still drawn on manual/page-change refreshes.
  if (pageId == PageId::CodexQuota) {
    return contentHash;
  }
  return contentHash ^ (batteryHash + 0x9e3779b9UL + (contentHash << 6) + (contentHash >> 2));
}

uint32_t pageDisplayHash(PageId pageId, uint32_t pagePayloadHash, const char* indicator) {
  uint32_t hash = 2166136261UL;
  const uint8_t id = static_cast<uint8_t>(pageId);
  hash = fnv1a(hash, &id, sizeof(id));
  hash = fnv1a(hash, &pagePayloadHash, sizeof(pagePayloadHash));
  hash = hashCString(hash, indicator ? indicator : "");
  return hash;
}
