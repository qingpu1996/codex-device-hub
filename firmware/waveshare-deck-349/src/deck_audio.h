#pragma once

#include <stddef.h>
#include <stdint.h>

enum class DeckAudioState {
  Disabled,
  Ready,
  Recording,
  Captured,
  Error,
};

struct DeckAudioStats {
  uint32_t durationMs;
  size_t pcmBytes;
  size_t wavBytes;
  int peak;
  int rms;
  uint32_t clippedSamples;
  bool silenceLikely;
  bool maxDurationReached;
  char error[72];
};

bool deckAudioInit(DeckAudioStats *stats);
bool deckAudioStart(DeckAudioStats *stats);
bool deckAudioPoll(DeckAudioStats *stats);
bool deckAudioStop(DeckAudioStats *stats);
void deckAudioReset(void);
DeckAudioState deckAudioState(void);
const uint8_t *deckAudioWavData(void);
size_t deckAudioWavSize(void);
const DeckAudioStats *deckAudioStats(void);
