#include "deck_provisioning.h"

#include <Arduino.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <ctype.h>
#include <string.h>
#include "esp_log.h"

static const char *TAG = "deck_setup";
static constexpr const char *kPrefsNamespace = "deck_cfg";
static constexpr const char *kPrefsConfigured = "configured";
static constexpr const char *kPrefsSsid = "ssid";
static constexpr const char *kPrefsPassword = "password";
static constexpr const char *kPrefsHubBaseUrl = "hub";
static constexpr const char *kPrefsDeckToken = "token";
static constexpr uint8_t kMaxShownNetworks = 12;

bool deckCopyString(char *dest, size_t destSize, const char *value)
{
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

static bool tokenLooksValid(const char *token)
{
  if (!token || strlen(token) != kDeckTokenMaxLen) {
    return false;
  }
  for (const char *p = token; *p; ++p) {
    if (!isxdigit(static_cast<unsigned char>(*p))) {
      return false;
    }
  }
  return true;
}

bool validateDeckSettings(const DeckSettings &settings, DeckProvisioningError *error)
{
  DeckProvisioningError localError = DeckProvisioningError::None;
  const size_t ssidLen = strlen(settings.wifiSsid);
  const size_t passwordLen = strlen(settings.wifiPassword);
  const size_t hubLen = strlen(settings.hubBaseUrl);

  if (ssidLen == 0) {
    localError = DeckProvisioningError::MissingSsid;
  } else if (ssidLen > kDeckWifiSsidMaxLen) {
    localError = DeckProvisioningError::SsidTooLong;
  } else if (passwordLen > kDeckWifiPasswordMaxLen) {
    localError = DeckProvisioningError::PasswordTooLong;
  } else if (hubLen == 0) {
    localError = DeckProvisioningError::MissingHubUrl;
  } else if (hubLen >= kDeckHubBaseUrlMaxLen) {
    localError = DeckProvisioningError::HubUrlTooLong;
  } else if (strncmp(settings.hubBaseUrl, "http://", 7) != 0) {
    localError = DeckProvisioningError::HubUrlScheme;
  } else if (strstr(settings.hubBaseUrl, "/api/deck/") != nullptr) {
    localError = DeckProvisioningError::HubUrlPath;
  } else if (settings.deckToken[0] == '\0') {
    localError = DeckProvisioningError::MissingToken;
  } else if (!tokenLooksValid(settings.deckToken)) {
    localError = DeckProvisioningError::TokenInvalid;
  }

  if (error) {
    *error = localError;
  }
  return localError == DeckProvisioningError::None;
}

const char *deckProvisioningErrorName(DeckProvisioningError error)
{
  switch (error) {
    case DeckProvisioningError::None:
      return "none";
    case DeckProvisioningError::MissingSsid:
      return "missing-ssid";
    case DeckProvisioningError::SsidTooLong:
      return "ssid-too-long";
    case DeckProvisioningError::PasswordTooLong:
      return "password-too-long";
    case DeckProvisioningError::MissingHubUrl:
      return "missing-hub-url";
    case DeckProvisioningError::HubUrlTooLong:
      return "hub-url-too-long";
    case DeckProvisioningError::HubUrlScheme:
      return "hub-url-must-be-http";
    case DeckProvisioningError::HubUrlPath:
      return "hub-url-must-be-base-url";
    case DeckProvisioningError::MissingToken:
      return "missing-deck-token";
    case DeckProvisioningError::TokenInvalid:
      return "deck-token-must-be-64-hex";
  }
  return "unknown";
}

bool loadDeckSettings(DeckSettings *out)
{
  if (!out) {
    return false;
  }
  memset(out, 0, sizeof(*out));

  Preferences prefs;
  if (!prefs.begin(kPrefsNamespace, true)) {
    return false;
  }
  const bool configured = prefs.getBool(kPrefsConfigured, false);
  if (configured) {
    prefs.getString(kPrefsSsid, out->wifiSsid, sizeof(out->wifiSsid));
    prefs.getString(kPrefsPassword, out->wifiPassword, sizeof(out->wifiPassword));
    prefs.getString(kPrefsHubBaseUrl, out->hubBaseUrl, sizeof(out->hubBaseUrl));
    prefs.getString(kPrefsDeckToken, out->deckToken, sizeof(out->deckToken));
  }
  prefs.end();

  out->configured = configured && validateDeckSettings(*out, nullptr);
  return out->configured;
}

bool saveDeckSettings(const DeckSettings &settings)
{
  if (!validateDeckSettings(settings, nullptr)) {
    return false;
  }
  Preferences prefs;
  if (!prefs.begin(kPrefsNamespace, false)) {
    return false;
  }
  const size_t ssidWritten = prefs.putString(kPrefsSsid, settings.wifiSsid);
  const size_t passwordWritten = prefs.putString(kPrefsPassword, settings.wifiPassword);
  const size_t hubWritten = prefs.putString(kPrefsHubBaseUrl, settings.hubBaseUrl);
  const size_t tokenWritten = prefs.putString(kPrefsDeckToken, settings.deckToken);
  const size_t configuredWritten = prefs.putBool(kPrefsConfigured, true);
  prefs.end();
  return ssidWritten > 0 && hubWritten > 0 && tokenWritten > 0 && configuredWritten > 0 && passwordWritten <= kDeckWifiPasswordMaxLen;
}

bool clearDeckSettings()
{
  Preferences prefs;
  if (!prefs.begin(kPrefsNamespace, false)) {
    return false;
  }
  const bool ok = prefs.clear();
  prefs.end();
  return ok;
}

static String htmlEscape(const char *value)
{
  String escaped;
  if (!value) {
    return escaped;
  }
  for (const char *p = value; *p; ++p) {
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

static String scanNetworkOptions()
{
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

static String buildPortalPage(const DeckSettings &current, const char *reason, const char *errorText, const String &ssidOptions)
{
  String html;
  html.reserve(4200);
  html += F("<!doctype html><html><head><meta charset=\"utf-8\">");
  html += F("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
  html += F("<title>Codex Deck Setup</title>");
  html += F("<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#f6f7f1;color:#111}");
  html += F("main{max-width:540px;margin:0 auto;padding:24px}h1{font-size:24px;margin:0 0 8px}");
  html += F("label{display:block;font-weight:700;margin:18px 0 6px}input{box-sizing:border-box;width:100%;font-size:16px;padding:12px;border:2px solid #222;border-radius:6px;background:#fff}");
  html += F("button{margin-top:22px;width:100%;font-size:18px;font-weight:700;padding:13px;border:0;border-radius:6px;background:#1a7f37;color:#fff}");
  html += F(".hint{font-size:14px;line-height:1.45;color:#333}.box{padding:12px;border:2px solid #222;border-radius:6px;background:#fff;margin:14px 0}");
  html += F(".err{padding:10px 12px;background:#ffe1dd;border:2px solid #b42318;border-radius:6px;margin:16px 0}</style></head><body><main>");
  html += F("<h1>Codex Deck Setup</h1>");
  html += F("<p class=\"hint\">Configure Wi-Fi and the Mac Deck Hub. Secrets are stored only on this device.</p>");
  html += F("<div class=\"box\"><b>Reason:</b> ");
  html += htmlEscape(reason ? reason : "setup");
  html += F("<br><b>Setup AP:</b> ");
  html += kDeckProvisioningApSsid;
  html += F("<br><b>URL:</b> ");
  html += kDeckProvisioningApUrl;
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
  html += F("<input id=\"password\" name=\"password\" maxlength=\"64\" type=\"password\" placeholder=\"Leave blank to keep existing/open Wi-Fi\">");
  html += F("<label for=\"hub\">Deck Hub Base URL</label>");
  html += F("<input id=\"hub\" name=\"hub\" maxlength=\"127\" required placeholder=\"http://192.168.5.156:19600\" value=\"");
  html += htmlEscape(current.hubBaseUrl);
  html += F("\">");
  html += F("<label for=\"token\">Deck Token</label>");
  html += F("<input id=\"token\" name=\"token\" maxlength=\"64\" ");
  html += current.deckToken[0] ? F("placeholder=\"Leave blank to keep existing token\"") : F("required placeholder=\"64 hex chars\"");
  html += F(">");
  html += F("<p class=\"hint\">Use the base URL only, not a full /api/deck/... path. The token is never shown back.</p>");
  html += F("<button type=\"submit\">Save and Reboot</button></form>");
  html += F("<form method=\"post\" action=\"/clear\"><button style=\"background:#b42318\" type=\"submit\">Clear Saved Settings</button></form>");
  html += F("</main></body></html>");
  return html;
}

static void sendNoStore(WebServer &server, int code, const char *contentType, const String &body)
{
  server.sendHeader(F("Cache-Control"), F("no-store"));
  server.send(code, contentType, body);
}

bool runDeckProvisioningPortal(DeckSettings *current, const char *reason)
{
  DeckSettings working = {};
  if (current) {
    working = *current;
  }

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
  const bool apStarted = WiFi.softAP(kDeckProvisioningApSsid, kDeckProvisioningApPassword);
  ESP_LOGI(TAG, "setup ap ssid=%s started=%s ip=%s", kDeckProvisioningApSsid, apStarted ? "yes" : "no", WiFi.softAPIP().toString().c_str());

  dns.start(53, "*", apIp);

  server.on("/", HTTP_GET, [&]() {
    sendNoStore(server, 200, "text/html", buildPortalPage(working, reason, lastError.c_str(), ssidOptions));
  });

  server.on("/save", HTTP_POST, [&]() {
    DeckSettings candidate = working;
    const String ssid = server.arg("ssid");
    const String password = server.arg("password");
    const String hub = server.arg("hub");
    const String token = server.arg("token");
    deckCopyString(candidate.wifiSsid, sizeof(candidate.wifiSsid), ssid.c_str());
    if (password.length() > 0 || candidate.wifiPassword[0] == '\0') {
      deckCopyString(candidate.wifiPassword, sizeof(candidate.wifiPassword), password.c_str());
    }
    deckCopyString(candidate.hubBaseUrl, sizeof(candidate.hubBaseUrl), hub.c_str());
    if (token.length() > 0 || candidate.deckToken[0] == '\0') {
      deckCopyString(candidate.deckToken, sizeof(candidate.deckToken), token.c_str());
    }
    candidate.configured = true;

    DeckProvisioningError error = DeckProvisioningError::None;
    if (!validateDeckSettings(candidate, &error)) {
      lastError = deckProvisioningErrorName(error);
      sendNoStore(server, 400, "text/html", buildPortalPage(working, reason, lastError.c_str(), ssidOptions));
      ESP_LOGW(TAG, "setup save rejected: %s", deckProvisioningErrorName(error));
      return;
    }
    if (!saveDeckSettings(candidate)) {
      lastError = "save-failed";
      sendNoStore(server, 500, "text/html", buildPortalPage(working, reason, lastError.c_str(), ssidOptions));
      ESP_LOGW(TAG, "setup save failed");
      return;
    }

    working = candidate;
    if (current) {
      *current = candidate;
    }
    saved = true;
    sendNoStore(server, 200, "text/html",
                F("<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                  "<title>Saved</title></head><body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px\">"
                  "<h1>Saved</h1><p>The Codex Deck will reboot and use the new settings.</p></body></html>"));
    ESP_LOGI(TAG, "setup settings saved; reboot pending");
  });

  server.on("/clear", HTTP_POST, [&]() {
    clearDeckSettings();
    memset(&working, 0, sizeof(working));
    lastError = "saved-settings-cleared";
    sendNoStore(server, 200, "text/html", buildPortalPage(working, reason, lastError.c_str(), ssidOptions));
    ESP_LOGI(TAG, "setup saved settings cleared");
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
  while (!saved) {
    dns.processNextRequest();
    server.handleClient();
    delay(5);
  }

  server.stop();
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);
  return saved;
}
