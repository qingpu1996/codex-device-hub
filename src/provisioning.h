#pragma once

#include <stddef.h>
#include <stdint.h>

static constexpr size_t kWifiSsidMaxLen = 32;
static constexpr size_t kWifiPasswordMaxLen = 64;
static constexpr size_t kQuotaApiUrlMaxLen = 256;
static constexpr const char* kProvisioningApSsid = "Codex-E1002-Setup";
static constexpr const char* kProvisioningApPassword = "codex-e1002";
static constexpr const char* kProvisioningApUrl = "http://192.168.4.1";
static constexpr uint32_t kProvisioningPortalTimeoutMs = 10UL * 60UL * 1000UL;

struct DeviceSettings {
  char wifiSsid[kWifiSsidMaxLen + 1];
  char wifiPassword[kWifiPasswordMaxLen + 1];
  char quotaApiUrl[kQuotaApiUrlMaxLen];
  bool configured;
  bool fromBootstrap;
};

enum class ProvisioningError : uint8_t {
  None,
  MissingSsid,
  SsidTooLong,
  PasswordTooLong,
  MissingApiUrl,
  ApiUrlTooLong,
  ApiUrlScheme,
  ApiUrlPath,
};

bool validateProvisioningFields(const char* ssid,
                                const char* password,
                                const char* apiUrl,
                                ProvisioningError* error);
bool copyProvisioningString(char* dest, size_t destSize, const char* value);
const char* provisioningErrorName(ProvisioningError error);
void formatApiTarget(const char* apiUrl, char* out, size_t outSize);
bool apiUrlLooksProtected(const char* apiUrl);

#ifndef QUOTA_HOST_TEST
bool loadDeviceSettings(DeviceSettings* out);
bool saveDeviceSettings(const DeviceSettings& settings);
bool clearDeviceSettings();
bool runProvisioningPortal(const DeviceSettings& current, const char* reason);
#endif
