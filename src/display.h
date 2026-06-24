#pragma once

#include "quota_client.h"

void renderQuotaPage(const QuotaPayload& payload, const char* pageIndicator);
void renderTodayMealPage(const char* pageIndicator);
void renderSetupError(const char* category);
void renderWifiSetupPage(const char* apSsid, const char* apPassword, const char* setupUrl, const char* reason);
void renderProvisioningSavedPage();
