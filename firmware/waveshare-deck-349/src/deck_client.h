#pragma once

#include <stddef.h>
#include <stdint.h>
#include "app_config.h"
#include "deck_settings.h"

enum class DeckClientStatus {
  Ok,
  ConfigMissing,
  WifiFailed,
  HttpBeginFailed,
  HttpError,
  JsonError,
  NoSlots,
  MissingJob,
};

struct DeckSlotSnapshot {
  char id[32];
  char title[32];
  char subtitle[48];
  char status[24];
  char lastSummary[96];
};

struct DeckSnapshot {
  DeckClientStatus status;
  int httpStatus;
  int slotCount;
  int wifiRssi;
  char error[72];
  char localIp[24];
  char codexStatus[24];
  char storageStatus[24];
  DeckSlotSnapshot slots[CODEX_DECK_MAX_SLOTS];
};

struct DeckJobSnapshot {
  char jobId[40];
  char type[16];
  char status[24];
  char slotId[32];
  char transcript[1536];
  char screenTranscript[1536];
  char screenReply[1024];
  char errorMessage[96];
  char audioJobId[40];
  char sourceAudioJobId[40];
  char sourceSttJobId[40];
  bool fullReplyAvailable;
};

struct DeckAudioUploadSnapshot {
  char jobId[40];
  char status[24];
  char slotId[32];
  char error[72];
  int httpStatus;
  int bytes;
  int durationMs;
  int sampleRate;
  int channels;
  int bitsPerSample;
};

void deckSnapshotInit(DeckSnapshot *snapshot);
void deckJobSnapshotInit(DeckJobSnapshot *job);
void deckAudioUploadSnapshotInit(DeckAudioUploadSnapshot *audio);
bool deckClientConfigReady(const DeckSettings *settings);
const char *deckClientStatusText(DeckClientStatus status);
DeckClientStatus deckConnectWifi(const DeckSettings *settings, DeckSnapshot *snapshot);
DeckClientStatus deckFetchHealth(const DeckSettings *settings, DeckSnapshot *snapshot);
DeckClientStatus deckFetchSlots(const DeckSettings *settings, DeckSnapshot *snapshot);
DeckClientStatus deckSubmitTextJob(const DeckSettings *settings, const char *slotId, const char *text, DeckJobSnapshot *job, DeckSnapshot *snapshot);
DeckClientStatus deckFetchJob(const DeckSettings *settings, const char *jobId, DeckJobSnapshot *job, DeckSnapshot *snapshot);
DeckClientStatus deckStartAudioTranscription(const DeckSettings *settings, const char *audioJobId, DeckJobSnapshot *job, DeckSnapshot *snapshot);
DeckClientStatus deckSubmitCodexSend(
  const DeckSettings *settings,
  const char *slotId,
  const char *transcript,
  const char *audioJobId,
  const char *sttJobId,
  DeckJobSnapshot *job,
  DeckSnapshot *snapshot
);
DeckClientStatus deckSubmitAudioUtterance(
  const DeckSettings *settings,
  const char *slotId,
  const uint8_t *wav,
  size_t wavLen,
  DeckAudioUploadSnapshot *audio,
  DeckSnapshot *snapshot
);
