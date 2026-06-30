#include "deck_audio.h"

#include <Arduino.h>
#include <math.h>
#include <string.h>
#include "app_config.h"
#include "board/lvgl_port.h"
#include "codec_board/codec_board.h"
#include "codec_board/codec_init.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_codec_dev/include/esp_codec_dev.h"

static const char *TAG = "deck_audio";
static constexpr size_t kWavHeaderBytes = 44;
static constexpr size_t kBytesPerSample = CODEX_DECK_AUDIO_BITS_PER_SAMPLE / 8;
static constexpr size_t kBytesPerFrame = CODEX_DECK_AUDIO_CHANNELS * kBytesPerSample;
static constexpr size_t kBytesPerSecond = CODEX_DECK_AUDIO_SAMPLE_RATE * kBytesPerFrame;
static constexpr size_t kMaxPcmBytes = (kBytesPerSecond * CODEX_DECK_AUDIO_MAX_MS) / 1000;
static constexpr size_t kMaxWavBytes = kWavHeaderBytes + kMaxPcmBytes;

static DeckAudioState g_state = DeckAudioState::Disabled;
static DeckAudioStats g_stats = {};
static esp_codec_dev_handle_t g_record = nullptr;
static uint8_t *g_wav = nullptr;
static size_t g_capacity = 0;
static uint32_t g_started_ms = 0;
static uint64_t g_sum_squares = 0;
static uint32_t g_sample_count = 0;

static void copy_error(const char *value)
{
  if (!value) {
    g_stats.error[0] = '\0';
    return;
  }
  snprintf(g_stats.error, sizeof(g_stats.error), "%s", value);
}

static void reset_stats(void)
{
  memset(&g_stats, 0, sizeof(g_stats));
  g_stats.peak = 0;
  g_stats.rms = 0;
  g_stats.silenceLikely = false;
  g_stats.maxDurationReached = false;
  g_sum_squares = 0;
  g_sample_count = 0;
}

static void copy_stats(DeckAudioStats *out)
{
  if (out) {
    *out = g_stats;
  }
}

static void write_u16_le(uint8_t *dst, uint16_t value)
{
  dst[0] = static_cast<uint8_t>(value & 0xff);
  dst[1] = static_cast<uint8_t>((value >> 8) & 0xff);
}

static void write_u32_le(uint8_t *dst, uint32_t value)
{
  dst[0] = static_cast<uint8_t>(value & 0xff);
  dst[1] = static_cast<uint8_t>((value >> 8) & 0xff);
  dst[2] = static_cast<uint8_t>((value >> 16) & 0xff);
  dst[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

static void write_wav_header(void)
{
  const uint32_t data_bytes = static_cast<uint32_t>(g_stats.pcmBytes);
  memcpy(g_wav + 0, "RIFF", 4);
  write_u32_le(g_wav + 4, 36 + data_bytes);
  memcpy(g_wav + 8, "WAVE", 4);
  memcpy(g_wav + 12, "fmt ", 4);
  write_u32_le(g_wav + 16, 16);
  write_u16_le(g_wav + 20, 1);
  write_u16_le(g_wav + 22, CODEX_DECK_AUDIO_CHANNELS);
  write_u32_le(g_wav + 24, CODEX_DECK_AUDIO_SAMPLE_RATE);
  write_u32_le(g_wav + 28, CODEX_DECK_AUDIO_SAMPLE_RATE * kBytesPerFrame);
  write_u16_le(g_wav + 32, kBytesPerFrame);
  write_u16_le(g_wav + 34, CODEX_DECK_AUDIO_BITS_PER_SAMPLE);
  memcpy(g_wav + 36, "data", 4);
  write_u32_le(g_wav + 40, data_bytes);
}

static void update_duration(void)
{
  if (g_stats.pcmBytes == 0) {
    g_stats.durationMs = 0;
    return;
  }
  g_stats.durationMs = static_cast<uint32_t>((static_cast<uint64_t>(g_stats.pcmBytes) * 1000ULL) / kBytesPerSecond);
}

static void update_audio_stats(const uint8_t *data, size_t bytes)
{
  const int16_t *samples = reinterpret_cast<const int16_t *>(data);
  const size_t count = bytes / sizeof(int16_t);
  for (size_t i = 0; i < count; i++) {
    const int sample = samples[i];
    const int magnitude = sample == INT16_MIN ? 32768 : abs(sample);
    if (magnitude > g_stats.peak) {
      g_stats.peak = magnitude;
    }
    if (magnitude >= 32760) {
      g_stats.clippedSamples++;
    }
    const int64_t signed_sample = sample;
    g_sum_squares += static_cast<uint64_t>(signed_sample * signed_sample);
  }
  g_sample_count += static_cast<uint32_t>(count);
  if (g_sample_count > 0) {
    g_stats.rms = static_cast<int>(sqrt(static_cast<double>(g_sum_squares) / g_sample_count));
  }
}

static bool allocate_wav_buffer(void)
{
  if (g_wav && g_capacity >= kMaxWavBytes) {
    return true;
  }
  if (g_wav) {
    heap_caps_free(g_wav);
    g_wav = nullptr;
    g_capacity = 0;
  }
  g_wav = static_cast<uint8_t *>(heap_caps_malloc(kMaxWavBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!g_wav) {
    g_wav = static_cast<uint8_t *>(heap_caps_malloc(kMaxWavBytes, MALLOC_CAP_8BIT));
  }
  if (!g_wav) {
    copy_error("audio memory failed");
    return false;
  }
  g_capacity = kMaxWavBytes;
  return true;
}

static bool open_record_codec(void)
{
  if (g_record) {
    return true;
  }

  if (!lvgl_port_set_ns_mode(true)) {
    copy_error("ns mode failed");
    return false;
  }

  set_codec_board_type("S3_LCD_3_49");
  codec_init_cfg_t codec_cfg = {
    .in_mode = CODEC_I2S_MODE_TDM,
    .out_mode = CODEC_I2S_MODE_NONE,
    .in_use_tdm = false,
    .reuse_dev = false,
  };
  if (init_codec(&codec_cfg) != 0) {
    copy_error("codec init failed");
    return false;
  }

  g_record = get_record_handle();
  if (!g_record) {
    copy_error("record handle failed");
    return false;
  }

  esp_codec_dev_set_in_gain(g_record, 35.0f);
  esp_codec_dev_sample_info_t fs = {};
  fs.sample_rate = CODEX_DECK_AUDIO_SAMPLE_RATE;
  fs.channel = CODEX_DECK_AUDIO_CHANNELS;
  fs.bits_per_sample = CODEX_DECK_AUDIO_BITS_PER_SAMPLE;
  const int err = esp_codec_dev_open(g_record, &fs);
  if (err != 0) {
    ESP_LOGW(TAG, "record open failed err=%d", err);
    copy_error("record open failed");
    g_record = nullptr;
    return false;
  }

  DECK_LOGI(TAG, "audio ready sample_rate=%d bits=%d channels=%d max_ms=%d",
           CODEX_DECK_AUDIO_SAMPLE_RATE,
           CODEX_DECK_AUDIO_BITS_PER_SAMPLE,
           CODEX_DECK_AUDIO_CHANNELS,
           CODEX_DECK_AUDIO_MAX_MS);
  return true;
}

bool deckAudioInit(DeckAudioStats *stats)
{
  reset_stats();
  if (!open_record_codec()) {
    g_state = DeckAudioState::Error;
    copy_stats(stats);
    return false;
  }
  g_state = DeckAudioState::Ready;
  copy_stats(stats);
  return true;
}

bool deckAudioStart(DeckAudioStats *stats)
{
  reset_stats();
  if (g_state == DeckAudioState::Disabled || g_state == DeckAudioState::Error) {
    if (!deckAudioInit(nullptr)) {
      copy_stats(stats);
      return false;
    }
  }
  if (!allocate_wav_buffer()) {
    g_state = DeckAudioState::Error;
    copy_stats(stats);
    return false;
  }
  memset(g_wav, 0, kWavHeaderBytes);
  g_stats.wavBytes = kWavHeaderBytes;
  g_started_ms = millis();
  g_state = DeckAudioState::Recording;
  DECK_LOGI(TAG, "record start free_heap=%u free_psram=%u",
           static_cast<unsigned>(esp_get_free_heap_size()),
           static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
  copy_stats(stats);
  return true;
}

bool deckAudioPoll(DeckAudioStats *stats)
{
  if (g_state != DeckAudioState::Recording) {
    copy_stats(stats);
    return false;
  }

  const size_t remaining = kMaxPcmBytes - g_stats.pcmBytes;
  if (remaining == 0) {
    g_stats.maxDurationReached = true;
    return deckAudioStop(stats);
  }

  size_t chunk = remaining < CODEX_DECK_AUDIO_CHUNK_BYTES ? remaining : CODEX_DECK_AUDIO_CHUNK_BYTES;
  chunk -= chunk % kBytesPerFrame;
  if (chunk == 0) {
    g_stats.maxDurationReached = true;
    return deckAudioStop(stats);
  }

  uint8_t *write_ptr = g_wav + kWavHeaderBytes + g_stats.pcmBytes;
  const int err = esp_codec_dev_read(g_record, write_ptr, static_cast<int>(chunk));
  if (err != 0) {
    ESP_LOGW(TAG, "record read failed err=%d", err);
    copy_error("record read failed");
    g_state = DeckAudioState::Error;
    copy_stats(stats);
    return false;
  }

  update_audio_stats(write_ptr, chunk);
  g_stats.pcmBytes += chunk;
  g_stats.wavBytes = kWavHeaderBytes + g_stats.pcmBytes;
  update_duration();

  if (g_stats.durationMs >= CODEX_DECK_AUDIO_MAX_MS) {
    g_stats.maxDurationReached = true;
    return deckAudioStop(stats);
  }

  copy_stats(stats);
  return true;
}

bool deckAudioStop(DeckAudioStats *stats)
{
  if (g_state != DeckAudioState::Recording) {
    copy_stats(stats);
    return g_state == DeckAudioState::Captured;
  }

  update_duration();
  if (g_stats.durationMs < CODEX_DECK_AUDIO_MIN_MS) {
    copy_error("too short");
    g_state = DeckAudioState::Error;
    copy_stats(stats);
    ESP_LOGW(TAG, "record too short duration_ms=%u bytes=%u",
             static_cast<unsigned>(g_stats.durationMs),
             static_cast<unsigned>(g_stats.pcmBytes));
    return false;
  }

  g_stats.silenceLikely = g_stats.rms < 150 && g_stats.peak < 800;
  write_wav_header();
  g_state = DeckAudioState::Captured;
  DECK_LOGI(TAG, "record stop duration_ms=%u pcm=%u wav=%u peak=%d rms=%d clipped=%u silence=%d max=%d",
           static_cast<unsigned>(g_stats.durationMs),
           static_cast<unsigned>(g_stats.pcmBytes),
           static_cast<unsigned>(g_stats.wavBytes),
           g_stats.peak,
           g_stats.rms,
           static_cast<unsigned>(g_stats.clippedSamples),
           g_stats.silenceLikely ? 1 : 0,
           g_stats.maxDurationReached ? 1 : 0);
  copy_stats(stats);
  return true;
}

void deckAudioReset(void)
{
  if (g_wav) {
    heap_caps_free(g_wav);
    g_wav = nullptr;
  }
  g_capacity = 0;
  reset_stats();
  g_state = g_record ? DeckAudioState::Ready : DeckAudioState::Disabled;
}

DeckAudioState deckAudioState(void)
{
  return g_state;
}

const uint8_t *deckAudioWavData(void)
{
  return g_state == DeckAudioState::Captured ? g_wav : nullptr;
}

size_t deckAudioWavSize(void)
{
  return g_state == DeckAudioState::Captured ? g_stats.wavBytes : 0;
}

const DeckAudioStats *deckAudioStats(void)
{
  return &g_stats;
}
