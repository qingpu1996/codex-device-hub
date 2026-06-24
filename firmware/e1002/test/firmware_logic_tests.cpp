#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "battery.h"
#include "input_manager.h"
#include "meal_image_client.h"
#include "page_manager.h"
#include "provisioning.h"
#include "quota_client.h"

static const char* normalJson =
  "{\"schemaVersion\":1,\"generatedAt\":1780000000,\"plan\":\"PRO\",\"status\":\"fresh\","
  "\"windows\":[{\"key\":\"five_hour\",\"title\":\"5 HOUR\",\"remainingPercent\":73,"
  "\"resetsAt\":1780003600,\"resetText\":\"Jun 23 21:40\"},"
  "{\"key\":\"weekly\",\"title\":\"WEEK\",\"remainingPercent\":48,"
  "\"resetsAt\":1780520000,\"resetText\":\"Jun 29 08:00\"}]}";

static QuotaPayload parseOk(const char* json) {
  QuotaPayload payload{};
  ParseResult result = parseQuotaJson(json, strlen(json), &payload);
  assert(result.ok);
  return payload;
}

static void test_normal_json() {
  QuotaPayload payload = parseOk(normalJson);
  assert(payload.schemaVersion == 1);
  assert(strcmp(payload.plan, "PRO") == 0);
  assert(strcmp(payload.status, "fresh") == 0);
  assert(!payload.hasUsage);
  assert(payload.windowCount == 2);
  assert(payload.windows[0].remainingPercent == 73);
}

static void test_usage_json() {
  const char* json =
    "{\"schemaVersion\":1,\"generatedAt\":1780000000,\"plan\":\"PRO\",\"status\":\"fresh\","
    "\"usage\":{\"totalTokensText\":\"1.4B\",\"todayTokensText\":\"3.62M\"},"
    "\"windows\":[{\"key\":\"five_hour\",\"title\":\"5 HOUR\",\"remainingPercent\":73,"
    "\"resetsAt\":1780003600,\"resetText\":\"Jun 23 21:40\"}]}";
  QuotaPayload payload = parseOk(json);
  assert(payload.hasUsage);
  assert(strcmp(payload.totalTokensText, "1.4B") == 0);
  assert(strcmp(payload.todayTokensText, "3.62M") == 0);
}

static void test_schema_wrong() {
  const char* json = "{\"schemaVersion\":2,\"generatedAt\":1,\"plan\":\"PRO\",\"status\":\"fresh\",\"windows\":[{}]}";
  QuotaPayload payload{};
  ParseResult result = parseQuotaJson(json, strlen(json), &payload);
  assert(!result.ok);
  assert(result.error == QuotaError::Schema);
}

static void test_missing_windows() {
  const char* json = "{\"schemaVersion\":1,\"generatedAt\":1,\"plan\":\"PRO\",\"status\":\"fresh\"}";
  QuotaPayload payload{};
  ParseResult result = parseQuotaJson(json, strlen(json), &payload);
  assert(!result.ok);
  assert(result.error == QuotaError::NoWindows);
}

static void test_percentage_out_of_range() {
  const char* json =
    "{\"schemaVersion\":1,\"generatedAt\":1,\"plan\":\"PRO\",\"status\":\"fresh\","
    "\"windows\":[{\"key\":\"five_hour\",\"title\":\"5 HOUR\",\"remainingPercent\":173,"
    "\"resetsAt\":2,\"resetText\":\"Jun 23 21:40\"}]}";
  QuotaPayload payload = parseOk(json);
  assert(payload.windows[0].remainingPercent == 100);
  assert(payload.windows[0].percentWasClamped);
  assert(payload.hadFormatIssue);
}

static void test_more_than_two_windows() {
  const char* json =
    "{\"schemaVersion\":1,\"generatedAt\":1,\"plan\":\"PRO\",\"status\":\"fresh\",\"windows\":["
    "{\"key\":\"a\",\"title\":\"A\",\"remainingPercent\":1,\"resetsAt\":2,\"resetText\":\"A\"},"
    "{\"key\":\"b\",\"title\":\"B\",\"remainingPercent\":2,\"resetsAt\":3,\"resetText\":\"B\"},"
    "{\"key\":\"c\",\"title\":\"C\",\"remainingPercent\":3,\"resetsAt\":4,\"resetText\":\"C\"}]}";
  QuotaPayload payload = parseOk(json);
  assert(payload.windowCount == 2);
  assert(strcmp(payload.windows[0].title, "A") == 0);
  assert(strcmp(payload.windows[1].title, "B") == 0);
  assert(payload.hadFormatIssue);
}

static void test_string_too_long() {
  const char* json =
    "{\"schemaVersion\":1,\"generatedAt\":1,\"plan\":\"PRO_PLAN_NAME_THAT_IS_TOO_LONG\",\"status\":\"fresh\","
    "\"windows\":[{\"key\":\"five_hour\",\"title\":\"TITLE_THAT_IS_TOO_LONG\",\"remainingPercent\":73,"
    "\"resetsAt\":2,\"resetText\":\"RESET_TEXT_THAT_IS_DEFINITELY_TOO_LONG\"}]}";
  QuotaPayload payload = parseOk(json);
  assert(strlen(payload.plan) == kPlanLen - 1);
  assert(strlen(payload.windows[0].title) == kTitleLen - 1);
  assert(strlen(payload.windows[0].resetText) == kResetTextLen - 1);
  assert(payload.hadFormatIssue);
}

static void test_hash_ignores_generated_at() {
  QuotaPayload a = parseOk(normalJson);
  const char* changed =
    "{\"schemaVersion\":1,\"generatedAt\":1780009999,\"plan\":\"PRO\",\"status\":\"fresh\","
    "\"windows\":[{\"key\":\"five_hour\",\"title\":\"5 HOUR\",\"remainingPercent\":73,"
    "\"resetsAt\":1780003600,\"resetText\":\"Jun 23 21:40\"},"
    "{\"key\":\"weekly\",\"title\":\"WEEK\",\"remainingPercent\":48,"
    "\"resetsAt\":1780520000,\"resetText\":\"Jun 29 08:00\"}]}";
  QuotaPayload b = parseOk(changed);
  assert(quotaRenderHash(a) == quotaRenderHash(b));
}

static void test_hash_percent_changes() {
  QuotaPayload a = parseOk(normalJson);
  const char* changed =
    "{\"schemaVersion\":1,\"generatedAt\":1780000000,\"plan\":\"PRO\",\"status\":\"fresh\","
    "\"windows\":[{\"key\":\"five_hour\",\"title\":\"5 HOUR\",\"remainingPercent\":72,"
    "\"resetsAt\":1780003600,\"resetText\":\"Jun 23 21:40\"}]}";
  QuotaPayload b = parseOk(changed);
  assert(quotaRenderHash(a) != quotaRenderHash(b));
}

static void test_hash_status_changes() {
  QuotaPayload a = parseOk(normalJson);
  const char* changed =
    "{\"schemaVersion\":1,\"generatedAt\":1780000000,\"plan\":\"PRO\",\"status\":\"stale\","
    "\"windows\":[{\"key\":\"five_hour\",\"title\":\"5 HOUR\",\"remainingPercent\":73,"
    "\"resetsAt\":1780003600,\"resetText\":\"Jun 23 21:40\"}]}";
  QuotaPayload b = parseOk(changed);
  assert(quotaRenderHash(a) != quotaRenderHash(b));
}

static void test_hash_usage_changes() {
  const char* a =
    "{\"schemaVersion\":1,\"generatedAt\":1780000000,\"plan\":\"PRO\",\"status\":\"fresh\","
    "\"usage\":{\"totalTokensText\":\"1.4B\",\"todayTokensText\":\"3.62M\"},"
    "\"windows\":[{\"key\":\"five_hour\",\"title\":\"5 HOUR\",\"remainingPercent\":73,"
    "\"resetsAt\":1780003600,\"resetText\":\"Jun 23 21:40\"}]}";
  const char* b =
    "{\"schemaVersion\":1,\"generatedAt\":1780000000,\"plan\":\"PRO\",\"status\":\"fresh\","
    "\"usage\":{\"totalTokensText\":\"1.4B\",\"todayTokensText\":\"4.1M\"},"
    "\"windows\":[{\"key\":\"five_hour\",\"title\":\"5 HOUR\",\"remainingPercent\":73,"
    "\"resetsAt\":1780003600,\"resetText\":\"Jun 23 21:40\"}]}";
  QuotaPayload pa = parseOk(a);
  QuotaPayload pb = parseOk(b);
  assert(quotaRenderHash(pa) != quotaRenderHash(pb));
}

static void test_network_failure_existing_valid_no_error_refresh() {
  RenderState state{123, 0, 0, true};
  assert(!shouldRenderSetupError(state));
}

static void test_manual_wake_forces_refresh() {
  QuotaPayload payload = parseOk(normalJson);
  RenderState state{quotaRenderHash(payload), 0, 0, true};
  RefreshDecision decision = decideRefresh(payload, state, true);
  assert(decision.shouldRefresh);
}

static void test_twelve_cycles_force_refresh() {
  QuotaPayload payload = parseOk(normalJson);
  RenderState state{quotaRenderHash(payload), 12, 0, true};
  RefreshDecision decision = decideRefresh(payload, state, false);
  assert(decision.shouldRefresh);
}

static void test_page_count_returns_two() {
  PageManager pages;
  assert(pages.pageCount() == 2);
}

static void test_page_one_next_is_page_two() {
  PageManager pages(1);
  assert(pages.nextPage());
  assert(pages.currentSlot() == 2);
  assert(pages.currentPage().id == PageId::TodayMeal);
}

static void test_page_two_next_wraps_to_page_one() {
  PageManager pages(2);
  assert(pages.nextPage());
  assert(pages.currentSlot() == 1);
  assert(pages.currentPage().id == PageId::CodexQuota);
}

static void test_direct_click_one_goes_page_one() {
  InputAction action = directPageActionFromClickCount(1, 2);
  assert(action.type == InputActionType::GoToPage);
  assert(action.targetPageSlot == 1);
}

static void test_direct_click_two_goes_page_two() {
  InputAction action = directPageActionFromClickCount(2, 2);
  assert(action.type == InputActionType::GoToPage);
  assert(action.targetPageSlot == 2);
}

static void test_direct_click_three_invalid_with_two_pages() {
  InputAction action = directPageActionFromClickCount(3, 2);
  assert(action.type == InputActionType::None);
  assert(action.clickCount == 3);
}

static void test_direct_current_page_has_no_page_change() {
  PageManager pages(1);
  const uint8_t before = pages.currentSlot();
  InputAction action = directPageActionFromClickCount(1, 2);
  assert(pages.goToSlot(action.targetPageSlot));
  assert(pages.currentSlot() == before);
}

static void test_middle_action_advances_one_page() {
  PageManager pages(1);
  InputAction action = actionFromWakeMask(1ULL << PIN_KEY1_MIDDLE);
  assert(action.type == InputActionType::NextPage);
  assert(pages.nextPage());
  assert(pages.currentSlot() == 2);
}

static void test_middle_long_press_is_next_subpage() {
  InputAction shortPress = middleButtonActionFromHoldDuration(BUTTON_LONG_PRESS_MS - 1);
  InputAction longPress = middleButtonActionFromHoldDuration(BUTTON_LONG_PRESS_MS);
  assert(shortPress.type == InputActionType::NextPage);
  assert(longPress.type == InputActionType::NextSubPage);
}

static void test_green_action_does_not_change_page() {
  PageManager pages(2);
  InputAction action = actionFromWakeMask(1ULL << PIN_KEY0_GREEN);
  assert(action.type == InputActionType::RefreshCurrentPage);
  assert(pages.currentSlot() == 2);
}

static void test_timer_wake_does_not_change_page() {
  PageManager pages(2);
  assert(pages.currentSlot() == 2);
}

static void test_left_wake_press_counts_as_first_click() {
  InputAction action = actionFromWakeMask(1ULL << PIN_KEY2_LEFT);
  assert(action.type == InputActionType::GoToPage);
  assert(action.targetPageSlot == 1);
  assert(action.clickCount == 1);
  DirectPageClickCollector collector;
  collector.beginWithWakePress(0);
  assert(collector.clickCount() == 1);
}

static void test_multiclick_gap_under_threshold_accumulates() {
  DirectPageClickCollector collector;
  collector.beginWithWakePress(0);
  collector.update(PIN_KEY2_LEFT, false, 50);
  collector.update(PIN_KEY2_LEFT, true, 100);
  collector.update(PIN_KEY2_LEFT, false, 150);
  assert(collector.clickCount() == 2);
  assert(!collector.tick(150 + MULTI_CLICK_GAP_MS - 1));
  assert(collector.tick(150 + MULTI_CLICK_GAP_MS));
}

static void test_multiclick_gap_over_threshold_finishes_sequence() {
  DirectPageClickCollector collector;
  collector.beginWithWakePress(0);
  collector.update(PIN_KEY2_LEFT, false, 50);
  assert(!collector.tick(50 + MULTI_CLICK_GAP_MS - 1));
  assert(collector.tick(50 + MULTI_CLICK_GAP_MS));
  assert(collector.finalized());
  assert(collector.clickCount() == 1);
}

static void test_debounce_bounce_does_not_add_click() {
  DirectPageClickCollector collector;
  collector.beginWithWakePress(0);
  collector.update(PIN_KEY2_LEFT, false, 10);
  collector.update(PIN_KEY2_LEFT, true, 20);
  collector.update(PIN_KEY2_LEFT, false, 45);
  collector.update(PIN_KEY2_LEFT, true, 70);
  assert(collector.clickCount() == 1);
}

static void test_multiple_wake_bits_is_ambiguous() {
  InputAction action = actionFromWakeMask((1ULL << PIN_KEY0_GREEN) | (1ULL << PIN_KEY1_MIDDLE));
  assert(action.type == InputActionType::Ambiguous);
}

static void test_page_indicator_formats() {
  PageManager pageOne(1);
  PageManager pageTwo(2);
  char value[12];
  pageOne.formatPageIndicator(value, sizeof(value));
  assert(strcmp(value, "P1/2") == 0);
  pageTwo.formatPageIndicator(value, sizeof(value));
  assert(strcmp(value, "P2/2") == 0);
}

static void test_hash_includes_page_id() {
  const uint32_t samePayloadHash = 12345;
  assert(pageDisplayHash(PageId::CodexQuota, samePayloadHash, "P1/2") !=
         pageDisplayHash(PageId::TodayMeal, samePayloadHash, "P1/2"));
}

static void test_page_one_and_two_hash_differ_with_same_content() {
  PageManager pages(1);
  assert(pages.pageContentHash(1, 777, "P1/2") != pages.pageContentHash(2, 777, "P1/2"));
}

static void test_static_page_timer_does_not_require_network_policy() {
  PageManager pages(2);
  assert(pages.currentPage().refreshPolicy == RefreshPolicy::PeriodicData);
}

static void test_page_switch_requires_refresh_by_page_change() {
  PageManager pages(1);
  const uint8_t before = pages.currentSlot();
  pages.nextPage();
  assert(pages.currentSlot() != before);
}

static void test_provisioning_accepts_valid_fields() {
  ProvisioningError error = ProvisioningError::None;
  assert(validateProvisioningFields("Home24", "password123",
                                    "http://192.0.2.10:19527/api/device/abc123",
                                    &error));
  assert(error == ProvisioningError::None);
}

static void test_provisioning_rejects_missing_ssid() {
  ProvisioningError error = ProvisioningError::None;
  assert(!validateProvisioningFields("", "password123",
                                     "http://192.0.2.10:19527/api/device/abc123",
                                     &error));
  assert(error == ProvisioningError::MissingSsid);
}

static void test_provisioning_rejects_https_api() {
  ProvisioningError error = ProvisioningError::None;
  assert(!validateProvisioningFields("Home24", "password123",
                                     "https://example.com/api/device/abc123",
                                     &error));
  assert(error == ProvisioningError::ApiUrlScheme);
}

static void test_provisioning_rejects_non_device_api() {
  ProvisioningError error = ProvisioningError::None;
  assert(!validateProvisioningFields("Home24", "password123",
                                     "http://192.0.2.10:19527/",
                                     &error));
  assert(error == ProvisioningError::ApiUrlPath);
}

static void test_provisioning_rejects_long_password() {
  char password[80];
  memset(password, 'x', sizeof(password));
  password[sizeof(password) - 1] = '\0';
  ProvisioningError error = ProvisioningError::None;
  assert(!validateProvisioningFields("Home24", password,
                                     "http://192.0.2.10:19527/api/device/abc123",
                                     &error));
  assert(error == ProvisioningError::PasswordTooLong);
}

static void test_format_api_target_hides_path_and_token() {
  char target[80];
  formatApiTarget("http://192.0.2.10:19527/api/device/example-device-token", target, sizeof(target));
  assert(strcmp(target, "192.0.2.10:19527") == 0);
}

static void test_copy_provisioning_string_rejects_truncation() {
  char dest[4];
  assert(!copyProvisioningString(dest, sizeof(dest), "abcdef"));
  assert(strcmp(dest, "abc") == 0);
}

static void test_battery_percent_curve_points() {
  assert(batteryPercentFromMillivolts(4150) == 100);
  assert(batteryPercentFromMillivolts(3750) == 50);
  assert(batteryPercentFromMillivolts(3270) == 0);
}

static void test_battery_percent_clamps() {
  assert(batteryPercentFromMillivolts(4300) == 100);
  assert(batteryPercentFromMillivolts(3000) == 0);
}

static void test_battery_percent_interpolates() {
  assert(batteryPercentFromMillivolts(3775) == 55);
  assert(batteryPercentFromMillivolts(3290) == 3);
}

static void test_battery_label_formats() {
  char label[16];
  BatteryStatus ok{true, 3900, 78};
  formatBatteryLabel(ok, label, sizeof(label));
  assert(strcmp(label, "BAT 78%") == 0);

  BatteryStatus invalid{false, 0, 0};
  formatBatteryLabel(invalid, label, sizeof(label));
  assert(strcmp(label, "BAT --%") == 0);
}

static void test_battery_hash_uses_displayed_label() {
  BatteryStatus a{true, 3900, 78};
  BatteryStatus b{true, 3890, 78};
  BatteryStatus c{true, 3890, 77};
  assert(batteryRenderHash(a) == batteryRenderHash(b));
  assert(batteryRenderHash(a) != batteryRenderHash(c));
}

static void test_meal_endpoint_url_builder() {
  char url[288];
  assert(buildMealEndpointUrl("http://192.0.2.10:19527/api/device/example-device-token", "meal/today", url, sizeof(url)));
  assert(strcmp(url, "http://192.0.2.10:19527/api/device/example-device-token/meal/today") == 0);
  assert(!buildMealEndpointUrl("http://192.0.2.10:19527/legacy/token", "meal/today", url, sizeof(url)));
}

static void test_meal_meta_parses_valid_json() {
  const char* json =
    "{\"schemaVersion\":1,\"generatedAt\":1780000000,\"date\":\"2026-06-24\",\"weekday\":\"周三\","
    "\"status\":\"fresh\",\"updatedText\":\"更新 06-19 23:34\",\"slot\":2,\"slotCount\":4,"
    "\"mealTitle\":\"测试午餐\",\"mealCount\":4,"
    "\"summary\":{\"calories\":1894},"
    "\"image\":{\"format\":\"e1002-4bpp\",\"width\":800,\"height\":480,\"rawBytes\":192000,"
    "\"hash\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}}";
  MealImageMeta meta{};
  MealMetaParseResult result = parseMealMetaJson(json, strlen(json), &meta);
  assert(result.ok);
  assert(strcmp(meta.status, "fresh") == 0);
  assert(strcmp(meta.date, "2026-06-24") == 0);
  assert(meta.slot == 2);
  assert(meta.slotCount == 4);
  assert(strcmp(meta.mealTitle, "测试午餐") == 0);
  assert(meta.rawBytes == kMealImageBytes);
}

static void test_meal_meta_rejects_bad_shape() {
  const char* json =
    "{\"schemaVersion\":1,\"date\":\"2026-06-24\",\"weekday\":\"周三\",\"status\":\"fresh\","
    "\"slot\":1,\"slotCount\":4,\"mealTitle\":\"测试\","
    "\"image\":{\"format\":\"png\",\"width\":800,\"height\":480,\"rawBytes\":192000,"
    "\"hash\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}}";
  MealImageMeta meta{};
  MealMetaParseResult result = parseMealMetaJson(json, strlen(json), &meta);
  assert(!result.ok);
  assert(result.error == MealImageError::ImageShape);
}

static void test_meal_meta_hash_uses_image_hash_not_generated_at() {
  const char* a =
    "{\"schemaVersion\":1,\"generatedAt\":1,\"date\":\"2026-06-24\",\"weekday\":\"周三\","
    "\"status\":\"fresh\",\"slot\":1,\"slotCount\":4,\"mealTitle\":\"测试\","
    "\"image\":{\"format\":\"e1002-4bpp\",\"width\":800,\"height\":480,\"rawBytes\":192000,"
    "\"hash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}";
  const char* b =
    "{\"schemaVersion\":1,\"generatedAt\":2,\"date\":\"2026-06-24\",\"weekday\":\"周三\","
    "\"status\":\"fresh\",\"slot\":1,\"slotCount\":4,\"mealTitle\":\"测试\","
    "\"image\":{\"format\":\"e1002-4bpp\",\"width\":800,\"height\":480,\"rawBytes\":192000,"
    "\"hash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}";
  const char* c =
    "{\"schemaVersion\":1,\"generatedAt\":2,\"date\":\"2026-06-24\",\"weekday\":\"周三\","
    "\"status\":\"fresh\",\"slot\":2,\"slotCount\":4,\"mealTitle\":\"测试\","
    "\"image\":{\"format\":\"e1002-4bpp\",\"width\":800,\"height\":480,\"rawBytes\":192000,"
    "\"hash\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}}";
  MealImageMeta ma{}, mb{}, mc{};
  assert(parseMealMetaJson(a, strlen(a), &ma).ok);
  assert(parseMealMetaJson(b, strlen(b), &mb).ok);
  assert(parseMealMetaJson(c, strlen(c), &mc).ok);
  assert(mealImageMetaHash(ma) == mealImageMetaHash(mb));
  assert(mealImageMetaHash(ma) != mealImageMetaHash(mc));
}

int main() {
  test_normal_json();
  test_usage_json();
  test_schema_wrong();
  test_missing_windows();
  test_percentage_out_of_range();
  test_more_than_two_windows();
  test_string_too_long();
  test_hash_ignores_generated_at();
  test_hash_percent_changes();
  test_hash_status_changes();
  test_hash_usage_changes();
  test_network_failure_existing_valid_no_error_refresh();
  test_manual_wake_forces_refresh();
  test_twelve_cycles_force_refresh();
  test_page_count_returns_two();
  test_page_one_next_is_page_two();
  test_page_two_next_wraps_to_page_one();
  test_direct_click_one_goes_page_one();
  test_direct_click_two_goes_page_two();
  test_direct_click_three_invalid_with_two_pages();
  test_direct_current_page_has_no_page_change();
  test_middle_action_advances_one_page();
  test_middle_long_press_is_next_subpage();
  test_green_action_does_not_change_page();
  test_timer_wake_does_not_change_page();
  test_left_wake_press_counts_as_first_click();
  test_multiclick_gap_under_threshold_accumulates();
  test_multiclick_gap_over_threshold_finishes_sequence();
  test_debounce_bounce_does_not_add_click();
  test_multiple_wake_bits_is_ambiguous();
  test_page_indicator_formats();
  test_hash_includes_page_id();
  test_page_one_and_two_hash_differ_with_same_content();
  test_static_page_timer_does_not_require_network_policy();
  test_page_switch_requires_refresh_by_page_change();
  test_provisioning_accepts_valid_fields();
  test_provisioning_rejects_missing_ssid();
  test_provisioning_rejects_https_api();
  test_provisioning_rejects_non_device_api();
  test_provisioning_rejects_long_password();
  test_format_api_target_hides_path_and_token();
  test_copy_provisioning_string_rejects_truncation();
  test_battery_percent_curve_points();
  test_battery_percent_clamps();
  test_battery_percent_interpolates();
  test_battery_label_formats();
  test_battery_hash_uses_displayed_label();
  test_meal_endpoint_url_builder();
  test_meal_meta_parses_valid_json();
  test_meal_meta_rejects_bad_shape();
  test_meal_meta_hash_uses_image_hash_not_generated_at();
  puts("firmware logic tests passed");
  return 0;
}
