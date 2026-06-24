#pragma once

#include <stddef.h>
#include <stdint.h>

static constexpr size_t kMaxQuotaResponseBytes = 8192;
static constexpr size_t kMaxQuotaWindows = 2;
static constexpr size_t kPlanLen = 16;
static constexpr size_t kStatusLen = 8;
static constexpr size_t kTitleLen = 16;
static constexpr size_t kResetTextLen = 24;

struct QuotaWindow {
  char key[16];
  char title[kTitleLen];
  int remainingPercent;
  int64_t resetsAt;
  char resetText[kResetTextLen];
  bool percentWasClamped;
};

struct QuotaPayload {
  int schemaVersion;
  int64_t generatedAt;
  char plan[kPlanLen];
  char status[kStatusLen];
  QuotaWindow windows[kMaxQuotaWindows];
  size_t windowCount;
  bool hadFormatIssue;
};

enum class QuotaError {
  None,
  ResponseTooLarge,
  JsonParse,
  Schema,
  MissingField,
  InvalidStatus,
  NoWindows,
};

struct ParseResult {
  bool ok;
  QuotaError error;
};

struct RenderState {
  uint32_t lastRenderHash;
  uint32_t cyclesSinceRender;
  uint32_t consecutiveFailures;
  bool hasRenderedValidData;
};

struct RefreshDecision {
  bool shouldRefresh;
  const char* reason;
};

ParseResult parseQuotaJson(const char* json, size_t length, QuotaPayload* out);
uint32_t quotaRenderHash(const QuotaPayload& payload);
RefreshDecision decideRefresh(const QuotaPayload& payload, const RenderState& state, bool manualWake);
bool shouldRenderSetupError(const RenderState& state);
const char* quotaErrorName(QuotaError error);

#ifndef QUOTA_HOST_TEST
struct FetchResult {
  bool ok;
  QuotaError error;
  int httpStatus;
  char contentType[48];
  QuotaPayload payload;
};

FetchResult fetchQuotaPayload(const char* apiUrl);
void logQuotaApiTarget(const char* apiUrl);
#endif
