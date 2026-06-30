#pragma once

#include <stddef.h>
#include <stdint.h>

static constexpr size_t kDeckWifiSsidMaxLen = 32;
static constexpr size_t kDeckWifiPasswordMaxLen = 64;
static constexpr size_t kDeckHubBaseUrlMaxLen = 128;
static constexpr size_t kDeckTokenMaxLen = 64;
static constexpr const char *kDeckProvisioningApSsid = "CodexDeck-Setup";
static constexpr const char *kDeckProvisioningApPassword = "codex-deck";
static constexpr const char *kDeckProvisioningApUrl = "http://192.168.4.1";

struct DeckSettings {
  char wifiSsid[kDeckWifiSsidMaxLen + 1];
  char wifiPassword[kDeckWifiPasswordMaxLen + 1];
  char hubBaseUrl[kDeckHubBaseUrlMaxLen];
  char deckToken[kDeckTokenMaxLen + 1];
  bool configured;
};
