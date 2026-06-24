#include "provisioning.h"

#include <stdio.h>
#include <string.h>

bool copyProvisioningString(char* dest, size_t destSize, const char* value) {
  if (!dest || destSize == 0) {
    return false;
  }
  dest[0] = '\0';
  if (!value) {
    return false;
  }
  const size_t len = strlen(value);
  const size_t copyLen = len < destSize - 1 ? len : destSize - 1;
  memcpy(dest, value, copyLen);
  dest[copyLen] = '\0';
  return len < destSize;
}

bool validateProvisioningFields(const char* ssid,
                                const char* password,
                                const char* apiUrl,
                                ProvisioningError* error) {
  ProvisioningError localError = ProvisioningError::None;
  const size_t ssidLen = ssid ? strlen(ssid) : 0;
  const size_t passwordLen = password ? strlen(password) : 0;
  const size_t apiLen = apiUrl ? strlen(apiUrl) : 0;

  if (ssidLen == 0) {
    localError = ProvisioningError::MissingSsid;
  } else if (ssidLen > kWifiSsidMaxLen) {
    localError = ProvisioningError::SsidTooLong;
  } else if (passwordLen > kWifiPasswordMaxLen) {
    localError = ProvisioningError::PasswordTooLong;
  } else if (apiLen == 0) {
    localError = ProvisioningError::MissingApiUrl;
  } else if (apiLen >= kQuotaApiUrlMaxLen) {
    localError = ProvisioningError::ApiUrlTooLong;
  } else if (strncmp(apiUrl, "http://", 7) != 0) {
    localError = ProvisioningError::ApiUrlScheme;
  } else if (strstr(apiUrl, "/api/device/") == nullptr) {
    localError = ProvisioningError::ApiUrlPath;
  }

  if (error) {
    *error = localError;
  }
  return localError == ProvisioningError::None;
}

const char* provisioningErrorName(ProvisioningError error) {
  switch (error) {
    case ProvisioningError::None: return "none";
    case ProvisioningError::MissingSsid: return "missing-ssid";
    case ProvisioningError::SsidTooLong: return "ssid-too-long";
    case ProvisioningError::PasswordTooLong: return "password-too-long";
    case ProvisioningError::MissingApiUrl: return "missing-api-url";
    case ProvisioningError::ApiUrlTooLong: return "api-url-too-long";
    case ProvisioningError::ApiUrlScheme: return "api-url-must-be-http";
    case ProvisioningError::ApiUrlPath: return "api-url-must-use-device-api";
  }
  return "unknown";
}

void formatApiTarget(const char* apiUrl, char* out, size_t outSize) {
  if (!out || outSize == 0) {
    return;
  }
  out[0] = '\0';
  if (!apiUrl || apiUrl[0] == '\0') {
    snprintf(out, outSize, "not-configured");
    return;
  }
  const char* host = strstr(apiUrl, "://");
  host = host ? host + 3 : apiUrl;
  const char* path = strchr(host, '/');
  const size_t hostLen = path ? static_cast<size_t>(path - host) : strlen(host);
  const size_t copyLen = hostLen < outSize - 1 ? hostLen : outSize - 1;
  memcpy(out, host, copyLen);
  out[copyLen] = '\0';
}

bool apiUrlLooksProtected(const char* apiUrl) {
  return apiUrl && strstr(apiUrl, "/api/device/") != nullptr && strlen(apiUrl) > strlen("http://x/api/device/");
}

#ifndef QUOTA_HOST_TEST
#include <Arduino.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>

#if __has_include("secrets.h")
#include "secrets.h"
#endif

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif

#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif

#ifndef QUOTA_API_URL
#define QUOTA_API_URL ""
#endif

static constexpr const char* kPrefsNamespace = "quota_cfg";
static constexpr const char* kPrefsConfigured = "configured";
static constexpr const char* kPrefsSsid = "ssid";
static constexpr const char* kPrefsPassword = "password";
static constexpr const char* kPrefsApiUrl = "api";
static constexpr uint8_t kMaxShownNetworks = 12;

static bool copyStringToSettings(char* dest, size_t destSize, const String& value) {
  return copyProvisioningString(dest, destSize, value.c_str());
}

static bool settingsAreValid(const DeviceSettings& settings) {
  return validateProvisioningFields(settings.wifiSsid, settings.wifiPassword, settings.quotaApiUrl, nullptr);
}

static bool loadStoredSettings(DeviceSettings* out) {
  Preferences prefs;
  if (!prefs.begin(kPrefsNamespace, true)) {
    return false;
  }
  const bool configured = prefs.getBool(kPrefsConfigured, false);
  if (!configured) {
    prefs.end();
    return false;
  }
  memset(out, 0, sizeof(*out));
  prefs.getString(kPrefsSsid, out->wifiSsid, sizeof(out->wifiSsid));
  prefs.getString(kPrefsPassword, out->wifiPassword, sizeof(out->wifiPassword));
  prefs.getString(kPrefsApiUrl, out->quotaApiUrl, sizeof(out->quotaApiUrl));
  prefs.end();
  out->configured = settingsAreValid(*out);
  out->fromBootstrap = false;
  return out->configured;
}

static bool loadBootstrapSettings(DeviceSettings* out) {
  memset(out, 0, sizeof(*out));
  copyProvisioningString(out->wifiSsid, sizeof(out->wifiSsid), WIFI_SSID);
  copyProvisioningString(out->wifiPassword, sizeof(out->wifiPassword), WIFI_PASSWORD);
  copyProvisioningString(out->quotaApiUrl, sizeof(out->quotaApiUrl), QUOTA_API_URL);
  out->configured = settingsAreValid(*out);
  out->fromBootstrap = out->configured;
  return out->configured;
}

bool loadDeviceSettings(DeviceSettings* out) {
  if (!out) {
    return false;
  }
  if (loadStoredSettings(out)) {
    return true;
  }
  return loadBootstrapSettings(out);
}

bool saveDeviceSettings(const DeviceSettings& settings) {
  if (!settingsAreValid(settings)) {
    return false;
  }
  Preferences prefs;
  if (!prefs.begin(kPrefsNamespace, false)) {
    return false;
  }
  const size_t a = prefs.putString(kPrefsSsid, settings.wifiSsid);
  const size_t b = prefs.putString(kPrefsPassword, settings.wifiPassword);
  const size_t c = prefs.putString(kPrefsApiUrl, settings.quotaApiUrl);
  const size_t d = prefs.putBool(kPrefsConfigured, true);
  prefs.end();
  return a > 0 && c > 0 && d > 0 && b <= kWifiPasswordMaxLen;
}

bool clearDeviceSettings() {
  Preferences prefs;
  if (!prefs.begin(kPrefsNamespace, false)) {
    return false;
  }
  const bool ok = prefs.clear();
  prefs.end();
  return ok;
}

static String htmlEscape(const char* value) {
  String escaped;
  if (!value) {
    return escaped;
  }
  for (const char* p = value; *p; ++p) {
    switch (*p) {
      case '&': escaped += F("&amp;"); break;
      case '<': escaped += F("&lt;"); break;
      case '>': escaped += F("&gt;"); break;
      case '"': escaped += F("&quot;"); break;
      case '\'': escaped += F("&#39;"); break;
      default: escaped += *p; break;
    }
  }
  return escaped;
}

static String scanNetworkOptions() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false);
  const int count = WiFi.scanNetworks();
  String options;
  const int shown = count < kMaxShownNetworks ? count : kMaxShownNetworks;
  for (int i = 0; i < shown; ++i) {
    const String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) {
      continue;
    }
    options += F("<option value=\"");
    options += htmlEscape(ssid.c_str());
    options += F("\">");
  }
  WiFi.scanDelete();
  return options;
}

static String buildPortalPage(const DeviceSettings& current, const char* reason, const char* errorText, const String& ssidOptions) {
  char target[80];
  formatApiTarget(current.quotaApiUrl, target, sizeof(target));
  String html;
  html.reserve(3600);
  html += F("<!doctype html><html><head><meta charset=\"utf-8\">");
  html += F("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
  html += F("<title>Codex E1002 Setup</title>");
  html += F("<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#f7f7f2;color:#111}");
  html += F("main{max-width:520px;margin:0 auto;padding:24px}h1{font-size:24px;margin:0 0 8px}");
  html += F("label{display:block;font-weight:700;margin:18px 0 6px}input{box-sizing:border-box;width:100%;font-size:16px;padding:12px;border:2px solid #222;border-radius:6px;background:#fff}");
  html += F("button{margin-top:22px;width:100%;font-size:18px;font-weight:700;padding:13px;border:0;border-radius:6px;background:#1a7f37;color:#fff}");
  html += F(".hint{font-size:14px;line-height:1.45;color:#333}.err{padding:10px 12px;background:#ffe1dd;border:2px solid #b42318;border-radius:6px;margin:16px 0}");
  html += F(".box{padding:12px;border:2px solid #222;border-radius:6px;background:#fff;margin:14px 0}</style></head><body><main>");
  html += F("<h1>Codex E1002 Setup</h1>");
  html += F("<p class=\"hint\">Connect the device to your 2.4GHz Wi-Fi and Mac quota API. Secrets are stored only on this E1002.</p>");
  html += F("<div class=\"box\"><b>Reason:</b> ");
  html += htmlEscape(reason ? reason : "setup");
  html += F("<br><b>Current API target:</b> ");
  html += htmlEscape(target);
  html += F("</div>");
  if (errorText && errorText[0] != '\0') {
    html += F("<div class=\"err\">");
    html += htmlEscape(errorText);
    html += F("</div>");
  }
  html += F("<form method=\"post\" action=\"/save\">");
  html += F("<label for=\"ssid\">Wi-Fi SSID</label>");
  html += F("<input id=\"ssid\" name=\"ssid\" maxlength=\"32\" required list=\"ssids\" value=\"");
  html += htmlEscape(current.wifiSsid);
  html += F("\"><datalist id=\"ssids\">");
  html += ssidOptions;
  html += F("</datalist>");
  html += F("<label for=\"password\">Wi-Fi Password</label>");
  html += F("<input id=\"password\" name=\"password\" maxlength=\"64\" type=\"password\" placeholder=\"Leave empty for open Wi-Fi\">");
  html += F("<label for=\"api\">Mac API URL</label>");
  html += F("<input id=\"api\" name=\"api\" maxlength=\"255\" placeholder=\"http://192.168.x.x:19527/api/device/...\">");
  html += F("<p class=\"hint\">Leave API URL blank to keep the current target. The full token is never pre-filled.</p>");
  html += F("<button type=\"submit\">Save and Reboot</button></form>");
  html += F("<form method=\"post\" action=\"/clear\"><button style=\"background:#b42318\" type=\"submit\">Clear Saved Settings</button></form>");
  html += F("</main></body></html>");
  return html;
}

static void sendNoStore(WebServer& server, int code, const char* contentType, const String& body) {
  server.sendHeader(F("Cache-Control"), F("no-store"));
  server.send(code, contentType, body);
}

bool runProvisioningPortal(const DeviceSettings& current, const char* reason) {
  DeviceSettings working = current;
  DNSServer dns;
  WebServer server(80);
  bool saved = false;
  String lastError;

  const String ssidOptions = scanNetworkOptions();
  IPAddress apIp(192, 168, 4, 1);
  IPAddress gateway(192, 168, 4, 1);
  IPAddress subnet(255, 255, 255, 0);
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(apIp, gateway, subnet);
  const bool apStarted = WiFi.softAP(kProvisioningApSsid, kProvisioningApPassword);
  Serial1.printf("[setup] ap ssid=%s started=%s ip=%s\n",
                 kProvisioningApSsid,
                 apStarted ? "yes" : "no",
                 WiFi.softAPIP().toString().c_str());

  dns.start(53, "*", apIp);

  server.on("/", HTTP_GET, [&]() {
    sendNoStore(server, 200, "text/html", buildPortalPage(working, reason, lastError.c_str(), ssidOptions));
  });

  server.on("/save", HTTP_POST, [&]() {
    DeviceSettings candidate = working;
    const String ssid = server.arg("ssid");
    const String password = server.arg("password");
    const String api = server.arg("api");
    copyStringToSettings(candidate.wifiSsid, sizeof(candidate.wifiSsid), ssid);
    copyStringToSettings(candidate.wifiPassword, sizeof(candidate.wifiPassword), password);
    if (api.length() > 0) {
      copyStringToSettings(candidate.quotaApiUrl, sizeof(candidate.quotaApiUrl), api);
    }
    candidate.configured = true;
    candidate.fromBootstrap = false;

    ProvisioningError error = ProvisioningError::None;
    if (!validateProvisioningFields(candidate.wifiSsid, candidate.wifiPassword, candidate.quotaApiUrl, &error)) {
      lastError = provisioningErrorName(error);
      sendNoStore(server, 400, "text/html", buildPortalPage(working, reason, lastError.c_str(), ssidOptions));
      Serial1.printf("[setup] save rejected: %s\n", provisioningErrorName(error));
      return;
    }
    if (!saveDeviceSettings(candidate)) {
      lastError = "save-failed";
      sendNoStore(server, 500, "text/html", buildPortalPage(working, reason, lastError.c_str(), ssidOptions));
      Serial1.println("[setup] save failed");
      return;
    }

    working = candidate;
    saved = true;
    sendNoStore(server, 200, "text/html",
                F("<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                  "<title>Saved</title></head><body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px\">"
                  "<h1>Saved</h1><p>The E1002 will reboot and use the new settings.</p></body></html>"));
    Serial1.println("[setup] settings saved; reboot pending");
  });

  server.on("/clear", HTTP_POST, [&]() {
    clearDeviceSettings();
    memset(&working, 0, sizeof(working));
    lastError = "saved-settings-cleared";
    sendNoStore(server, 200, "text/html", buildPortalPage(working, reason, lastError.c_str(), ssidOptions));
    Serial1.println("[setup] saved settings cleared");
  });

  server.on("/generate_204", HTTP_GET, [&]() {
    server.sendHeader(F("Location"), F("/"));
    server.send(302, "text/plain", "");
  });
  server.on("/hotspot-detect.html", HTTP_GET, [&]() {
    server.sendHeader(F("Location"), F("/"));
    server.send(302, "text/plain", "");
  });
  server.on("/fwlink", HTTP_GET, [&]() {
    server.sendHeader(F("Location"), F("/"));
    server.send(302, "text/plain", "");
  });
  server.onNotFound([&]() {
    server.sendHeader(F("Location"), F("/"));
    server.send(302, "text/plain", "");
  });

  server.begin();
  const uint32_t start = millis();
  while (!saved && millis() - start < kProvisioningPortalTimeoutMs) {
    server.handleClient();
    delay(5);
  }

  server.stop();
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);
  return saved;
}
#endif
