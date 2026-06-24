#include "input_manager.h"

#include "feature_flags.h"

#ifndef QUOTA_HOST_TEST
#include <Arduino.h>
#include "driver/gpio.h"
#include "driver/rtc_io.h"
#endif

static bool isButtonGpio(uint8_t gpio) {
  return gpio == PIN_KEY0_GREEN || gpio == PIN_KEY1_MIDDLE || gpio == PIN_KEY2_LEFT;
}

void DirectPageClickCollector::beginWithWakePress(uint32_t nowMs) {
  active_ = true;
  finalized_ = false;
  stablePressed_ = true;
  ignoredOtherButton_ = false;
  clickCount_ = 1;
  startMs_ = nowMs;
  lastEdgeMs_ = nowMs;
  lastReleaseMs_ = nowMs;
}

void DirectPageClickCollector::update(uint8_t gpio, bool pressed, uint32_t nowMs) {
  if (!active_ || finalized_) {
    return;
  }
  if (gpio != PIN_KEY2_LEFT) {
    if (isButtonGpio(gpio) && pressed) {
      ignoredOtherButton_ = true;
    }
    return;
  }
  if (pressed == stablePressed_) {
    return;
  }
  if (nowMs - lastEdgeMs_ < BUTTON_DEBOUNCE_MS) {
    return;
  }

  stablePressed_ = pressed;
  lastEdgeMs_ = nowMs;
  if (pressed) {
    if (clickCount_ < 255) {
      clickCount_++;
    }
  } else {
    lastReleaseMs_ = nowMs;
  }
}

bool DirectPageClickCollector::tick(uint32_t nowMs) {
  if (!active_ || finalized_) {
    return finalized_;
  }
  if (nowMs - startMs_ >= MULTI_CLICK_TOTAL_TIMEOUT_MS) {
    finalized_ = true;
    return true;
  }
  if (clickCount_ > 0 && !stablePressed_ && nowMs - lastReleaseMs_ >= MULTI_CLICK_GAP_MS) {
    finalized_ = true;
    return true;
  }
  return false;
}

bool DirectPageClickCollector::finalized() const {
  return finalized_;
}

uint8_t DirectPageClickCollector::clickCount() const {
  return clickCount_;
}

bool DirectPageClickCollector::ignoredOtherButton() const {
  return ignoredOtherButton_;
}

uint64_t allButtonWakeMask() {
  return (1ULL << PIN_KEY0_GREEN) | (1ULL << PIN_KEY1_MIDDLE) | (1ULL << PIN_KEY2_LEFT);
}

PhysicalButton buttonFromWakeMask(uint64_t wakeMask) {
  const uint64_t masked = wakeMask & allButtonWakeMask();
  if (masked == 0) {
    return PhysicalButton::None;
  }
  if ((masked & (masked - 1)) != 0) {
    return PhysicalButton::Multiple;
  }
  if (masked & (1ULL << PIN_KEY0_GREEN)) {
    return PhysicalButton::Key0Green;
  }
  if (masked & (1ULL << PIN_KEY1_MIDDLE)) {
    return PhysicalButton::Key1Middle;
  }
  if (masked & (1ULL << PIN_KEY2_LEFT)) {
    return PhysicalButton::Key2Left;
  }
  return PhysicalButton::None;
}

InputAction actionFromWakeMask(uint64_t wakeMask) {
  switch (buttonFromWakeMask(wakeMask)) {
    case PhysicalButton::Key0Green:
      return {InputActionType::RefreshCurrentPage, 0, 0};
    case PhysicalButton::Key1Middle:
      return {InputActionType::NextPage, 0, 0};
    case PhysicalButton::Key2Left:
      return {InputActionType::GoToPage, 1, 1};
    case PhysicalButton::Multiple:
      return {InputActionType::Ambiguous, 0, 0};
    case PhysicalButton::None:
      break;
  }
  return {InputActionType::None, 0, 0};
}

InputAction middleButtonActionFromHoldDuration(uint32_t holdMs) {
  if (holdMs >= BUTTON_LONG_PRESS_MS) {
#if FEATURE_SUBPAGES
    return {InputActionType::NextSubPage, 0, 0};
#else
    return {InputActionType::NextPage, 0, 0};
#endif
  }
  return {InputActionType::NextPage, 0, 0};
}

InputAction directPageActionFromClickCount(uint8_t clickCount, uint8_t pageCount) {
  if (clickCount >= 1 && clickCount <= pageCount) {
    return {InputActionType::GoToPage, clickCount, clickCount};
  }
  return {InputActionType::None, 0, clickCount};
}

const char* physicalButtonName(PhysicalButton button) {
  switch (button) {
    case PhysicalButton::None: return "NONE";
    case PhysicalButton::Key0Green: return "KEY0 GREEN GPIO3";
    case PhysicalButton::Key1Middle: return "KEY1 MIDDLE GPIO4";
    case PhysicalButton::Key2Left: return "KEY2 LEFT GPIO5";
    case PhysicalButton::Multiple: return "MULTIPLE";
  }
  return "UNKNOWN";
}

const char* inputActionName(InputActionType action) {
  switch (action) {
    case InputActionType::None: return "NONE";
    case InputActionType::GoToPage: return "GO_TO_PAGE";
    case InputActionType::NextPage: return "NEXT_PAGE";
    case InputActionType::NextSubPage: return "NEXT_SUBPAGE";
    case InputActionType::RefreshCurrentPage: return "REFRESH_CURRENT_PAGE";
    case InputActionType::Ambiguous: return "AMBIGUOUS";
  }
  return "UNKNOWN";
}

const char* gpioButtonName(uint8_t gpio) {
  switch (gpio) {
    case PIN_KEY0_GREEN: return "KEY0 GREEN GPIO3";
    case PIN_KEY1_MIDDLE: return "KEY1 MIDDLE GPIO4";
    case PIN_KEY2_LEFT: return "KEY2 LEFT GPIO5";
  }
  return "UNKNOWN GPIO";
}

#ifndef QUOTA_HOST_TEST
void initButtons() {
  pinMode(PIN_KEY0_GREEN, INPUT_PULLUP);
  pinMode(PIN_KEY1_MIDDLE, INPUT_PULLUP);
  pinMode(PIN_KEY2_LEFT, INPUT_PULLUP);
}

bool areAllButtonsReleased() {
  return digitalRead(PIN_KEY0_GREEN) == HIGH &&
         digitalRead(PIN_KEY1_MIDDLE) == HIGH &&
         digitalRead(PIN_KEY2_LEFT) == HIGH;
}

bool waitForAllButtonsReleased(uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (!areAllButtonsReleased() && millis() - start < timeoutMs) {
    delay(20);
  }
  return areAllButtonsReleased();
}

void configureButtonRtcPullups() {
  const uint8_t pins[] = {PIN_KEY0_GREEN, PIN_KEY1_MIDDLE, PIN_KEY2_LEFT};
  for (uint8_t pin : pins) {
    rtc_gpio_pullup_en(static_cast<gpio_num_t>(pin));
    rtc_gpio_pulldown_dis(static_cast<gpio_num_t>(pin));
    gpio_sleep_sel_en(static_cast<gpio_num_t>(pin));
    gpio_sleep_set_pull_mode(static_cast<gpio_num_t>(pin), GPIO_PULLUP_ONLY);
  }
}

static void feedbackClick() {
  Serial1.println("[FEEDBACK] click");
}

static void feedbackInvalid() {
  Serial1.println("[FEEDBACK] invalid direct page");
}

InputAction collectDirectPageClicksFromWake(uint8_t pageCount) {
  DirectPageClickCollector collector;
  uint32_t now = millis();
  collector.beginWithWakePress(now);
  Serial1.println("[INPUT] KEY2 LEFT wake press counted as click 1");
  feedbackClick();

  bool loggedOtherKey = false;
  uint8_t lastCount = collector.clickCount();
  while (!collector.finalized()) {
    now = millis();
    const bool leftPressed = digitalRead(PIN_KEY2_LEFT) == LOW;
    const bool middlePressed = digitalRead(PIN_KEY1_MIDDLE) == LOW;
    const bool greenPressed = digitalRead(PIN_KEY0_GREEN) == LOW;

    collector.update(PIN_KEY2_LEFT, leftPressed, now);
    collector.update(PIN_KEY1_MIDDLE, middlePressed, now);
    collector.update(PIN_KEY0_GREEN, greenPressed, now);

    if (!loggedOtherKey && (middlePressed || greenPressed)) {
      Serial1.println("[INPUT] ignoring non-left key during direct page click session");
      loggedOtherKey = true;
    }
    if (collector.clickCount() != lastCount) {
      lastCount = collector.clickCount();
      Serial1.printf("[INPUT] KEY2 LEFT click count=%u\n", static_cast<unsigned>(lastCount));
      feedbackClick();
    }
    collector.tick(now);
    delay(10);
  }

  InputAction action = directPageActionFromClickCount(collector.clickCount(), pageCount);
  Serial1.printf("[INPUT] direct click count=%u\n", static_cast<unsigned>(collector.clickCount()));
  if (action.type == InputActionType::None) {
    Serial1.println("[INPUT] INVALID DIRECT PAGE");
    feedbackInvalid();
  }
  return action;
}

InputAction collectMiddleButtonActionFromWake() {
  const uint32_t start = millis();
  while (digitalRead(PIN_KEY1_MIDDLE) == LOW && millis() - start < BUTTON_LONG_PRESS_MS) {
    delay(10);
  }
  const uint32_t held = millis() - start;
  const bool longPress = digitalRead(PIN_KEY1_MIDDLE) == LOW;
  if (longPress) {
#if FEATURE_SUBPAGES
    Serial1.printf("[INPUT] KEY1 MIDDLE long press hold=%lu ms; trigger before release\n", static_cast<unsigned long>(held));
#else
    Serial1.printf("[INPUT] KEY1 MIDDLE long press hold=%lu ms; no subpage feature, trigger next page\n", static_cast<unsigned long>(held));
#endif
    return middleButtonActionFromHoldDuration(BUTTON_LONG_PRESS_MS);
  }
  Serial1.printf("[INPUT] KEY1 MIDDLE short press hold=%lu ms\n", static_cast<unsigned long>(held));
  delay(BUTTON_DEBOUNCE_MS);
  return {InputActionType::NextPage, 0, 0};
}
#endif
