#include <Arduino.h>
#include <stdio.h>
#include <string.h>
#include "app_config.h"
#include "board/board_config.h"
#include "board/i2c_bsp.h"
#include "board/lvgl_port.h"
#include "deck_audio.h"
#include "deck_client.h"
#include "deck_provisioning.h"
#include "deck_settings.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "lcd_bl_bsp/lcd_bl_pwm_bsp.h"
#include "lvgl.h"
#include "ui/deck_ui.h"
#include "user_config.h"

static const char *TAG = "codex_deck";
static DeckSnapshot g_snapshot;
static DeckJobSnapshot g_job;
static DeckJobSnapshot g_stt_job;
static DeckAudioUploadSnapshot g_audio_upload;
static DeckSettings g_settings;
static uint32_t g_last_refresh_ms = 0;
static uint32_t g_last_job_poll_ms = 0;
static uint32_t g_voice_started_ms = 0;
static bool g_network_ready = false;
static bool g_job_active = false;
static bool g_stt_active = false;
static bool g_transcript_ready = false;
static bool g_voice_codex_active = false;
static bool g_reply_ready = false;
static int g_selected_slot_index = 0;
static volatile int g_pending_slot_select = -1;
static volatile bool g_pending_record_toggle = false;
static volatile bool g_pending_confirm_send = false;
static volatile bool g_pending_retry = false;
static volatile bool g_pending_back = false;
static char g_current_audio_job_id[40] = {0};
static char g_current_transcript[1536] = {0};

static void with_ui(void (*fn)(void *ctx), void *ctx)
{
  if (lvgl_port_lock(1000)) {
    fn(ctx);
    lvgl_port_unlock();
  }
}

struct UiStatusContext {
  const char *title;
  const char *detail;
};

static void set_status_locked(void *ctx)
{
  UiStatusContext *status = static_cast<UiStatusContext *>(ctx);
  deck_ui_set_status(status->title, status->detail);
}

static void set_ui_status(const char *title, const char *detail)
{
  UiStatusContext ctx = {title, detail};
  with_ui(set_status_locked, &ctx);
}

static void set_footer_locked(void *ctx)
{
  deck_ui_set_footer(static_cast<const char *>(ctx));
}

static void set_ui_footer(const char *text)
{
  with_ui(set_footer_locked, const_cast<char *>(text));
}

static void set_recording_locked(void *ctx)
{
  bool *recording = static_cast<bool *>(ctx);
  deck_ui_set_recording(*recording);
}

static void set_ui_recording(bool recording)
{
  bool ctx = recording;
  with_ui(set_recording_locked, &ctx);
}

static void set_slots_locked(void *ctx)
{
  DeckSnapshot *snapshot = static_cast<DeckSnapshot *>(ctx);
  DeckUiSlot slots[CODEX_DECK_MAX_SLOTS];
  for (int i = 0; i < snapshot->slotCount; i++) {
    slots[i] = {
      snapshot->slots[i].title,
      snapshot->slots[i].subtitle,
      snapshot->slots[i].status,
      snapshot->slots[i].lastSummary,
    };
  }
  deck_ui_set_slots(slots, snapshot->slotCount);
}

static void set_ui_slots(DeckSnapshot *snapshot)
{
  with_ui(set_slots_locked, snapshot);
}

static void set_selected_slot_locked(void *ctx)
{
  int *slot_index = static_cast<int *>(ctx);
  deck_ui_set_selected_slot(*slot_index);
}

static void set_ui_selected_slot(int slot_index)
{
  int ctx = slot_index;
  with_ui(set_selected_slot_locked, &ctx);
}

static void deck_ui_event_handler(int slot_index, DeckUiEvent event, void *ctx)
{
  (void)ctx;
  if (event == DECK_UI_EVENT_SLOT_CLICKED) {
    g_pending_slot_select = slot_index;
  } else if (event == DECK_UI_EVENT_RECORD_TOGGLE) {
    g_pending_record_toggle = true;
  } else if (event == DECK_UI_EVENT_CONFIRM_SEND_CLICKED) {
    g_pending_confirm_send = true;
  } else if (event == DECK_UI_EVENT_RETRY_CLICKED) {
    g_pending_retry = true;
  } else if (event == DECK_UI_EVENT_BACK_CLICKED) {
    g_pending_back = true;
  }
}

static void log_boot_banner()
{
  ESP_LOGI(TAG, "firmware=%s", CODEX_DECK_FIRMWARE_VERSION);
  ESP_LOGI(TAG, "device=%s", CODEX_DECK_DEVICE_NAME);
  ESP_LOGI(TAG, "hardware_variant_config=%s", DECK_HARDWARE_VARIANT_TEXT);
  ESP_LOGI(TAG, "lvgl=%d.%d.%d", lv_version_major(), lv_version_minor(), lv_version_patch());
  ESP_LOGI(TAG, "screen=%dx%d", DECK_SCREEN_WIDTH, DECK_SCREEN_HEIGHT);
  ESP_LOGI(TAG, "lcd_te_gpio=%d lcd_rst_gpio=%d", EXAMPLE_PIN_NUM_LCD_TE, EXAMPLE_PIN_NUM_LCD_RST);
  ESP_LOGI(TAG, "free_heap=%u", static_cast<unsigned>(esp_get_free_heap_size()));
  ESP_LOGI(TAG, "free_psram=%u", static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
}

static bool valid_selected_slot()
{
  return g_selected_slot_index >= 0 && g_selected_slot_index < g_snapshot.slotCount;
}

static bool is_terminal_job_status(const char *status)
{
  return status &&
         (strcmp(status, "done") == 0 ||
          strcmp(status, "failed") == 0 ||
          strcmp(status, "waiting_approval") == 0);
}

static const char *selected_slot_title()
{
  return valid_selected_slot() ? g_snapshot.slots[g_selected_slot_index].title : "--";
}

static const char *selected_slot_id()
{
  return valid_selected_slot() ? g_snapshot.slots[g_selected_slot_index].id : "";
}

static bool voice_flow_active()
{
  return g_stt_active || g_transcript_ready || g_voice_codex_active || g_reply_ready;
}

static void clear_voice_flow()
{
  g_stt_active = false;
  g_transcript_ready = false;
  g_voice_codex_active = false;
  g_reply_ready = false;
  g_voice_started_ms = 0;
  g_current_audio_job_id[0] = '\0';
  g_current_transcript[0] = '\0';
  deckJobSnapshotInit(&g_stt_job);
}

struct UiTextPageContext {
  const char *title;
  const char *body;
  const char *retry;
  const char *send;
  const char *back;
};

static void show_text_page_locked(void *ctx)
{
  UiTextPageContext *page = static_cast<UiTextPageContext *>(ctx);
  deck_ui_show_text_page(page->title, page->body, page->retry, page->send, page->back);
}

static void show_ui_text_page(const char *title, const char *body, const char *retry, const char *send, const char *back)
{
  UiTextPageContext ctx = {title, body, retry, send, back};
  with_ui(show_text_page_locked, &ctx);
}

static void show_home_locked(void *ctx)
{
  (void)ctx;
  deck_ui_show_home();
}

static void show_ui_home()
{
  with_ui(show_home_locked, nullptr);
}

static void update_idle_footer()
{
  char footer[64];
  if (valid_selected_slot()) {
    snprintf(footer, sizeof(footer), "SEL %s", selected_slot_title());
  } else if (g_snapshot.localIp[0]) {
    snprintf(footer, sizeof(footer), "IP %s", g_snapshot.localIp);
  } else {
    snprintf(footer, sizeof(footer), "SLOTS + JOBS");
  }
  set_ui_footer(footer);
}

static bool refresh_deck()
{
  DeckClientStatus status = deckFetchHealth(&g_settings, &g_snapshot);
  if (status != DeckClientStatus::Ok) {
    ESP_LOGW(TAG, "deck health failed status=%s http=%d error=%s", deckClientStatusText(status), g_snapshot.httpStatus, g_snapshot.error);
    set_ui_status(deckClientStatusText(status), g_snapshot.error);
    return false;
  }

  status = deckFetchSlots(&g_settings, &g_snapshot);
  if (status != DeckClientStatus::Ok) {
    ESP_LOGW(TAG, "deck slots failed status=%s http=%d error=%s", deckClientStatusText(status), g_snapshot.httpStatus, g_snapshot.error);
    set_ui_status(deckClientStatusText(status), g_snapshot.error);
    return false;
  }

  char detail[64];
  snprintf(detail, sizeof(detail), "%d SLOTS  RSSI %d", g_snapshot.slotCount, g_snapshot.wifiRssi);
  set_ui_status("DECK HUB OK", detail);
  if (g_selected_slot_index >= g_snapshot.slotCount) {
    g_selected_slot_index = 0;
  }
  if (!voice_flow_active()) {
    show_ui_home();
    set_ui_slots(&g_snapshot);
    set_ui_selected_slot(g_selected_slot_index);
  }

  if (!g_job_active && !voice_flow_active()) {
    update_idle_footer();
  }
  ESP_LOGI(TAG, "deck slots updated count=%d codex=%s storage=%s", g_snapshot.slotCount, g_snapshot.codexStatus, g_snapshot.storageStatus);
  return true;
}

static void select_slot(int slot_index)
{
  if (slot_index < 0 || slot_index >= g_snapshot.slotCount) {
    return;
  }
  g_selected_slot_index = slot_index;
  set_ui_selected_slot(g_selected_slot_index);
  update_idle_footer();
  ESP_LOGI(TAG, "selected slot index=%d id=%s", g_selected_slot_index, selected_slot_id());
}

static void update_recording_footer(const DeckAudioStats &stats)
{
  char footer[72];
  snprintf(footer, sizeof(footer), "REC %uMS P%d R%d",
           static_cast<unsigned>(stats.durationMs),
           stats.peak,
           stats.rms);
  set_ui_footer(footer);
}

static void start_audio_transcription()
{
  if (!g_audio_upload.jobId[0]) {
    set_ui_status("STT ERROR", "NO AUDIO JOB");
    return;
  }
  show_ui_text_page("TRANSCRIBING", "WORKING\n\nWaiting for local STT on Mac.", "", "", "BACK");
  DeckClientStatus status = deckStartAudioTranscription(&g_settings, g_audio_upload.jobId, &g_stt_job, &g_snapshot);
  if (status != DeckClientStatus::Ok) {
    ESP_LOGW(TAG, "stt start failed status=%s http=%d error=%s", deckClientStatusText(status), g_snapshot.httpStatus, g_snapshot.error);
    g_reply_ready = true;
    show_ui_text_page("STT ERROR", g_snapshot.error[0] ? g_snapshot.error : deckClientStatusText(status), "RETRY", "", "BACK");
    return;
  }
  snprintf(g_current_audio_job_id, sizeof(g_current_audio_job_id), "%s", g_audio_upload.jobId);
  g_stt_active = true;
  g_transcript_ready = false;
  g_voice_codex_active = false;
  g_reply_ready = false;
  g_voice_started_ms = millis();
  g_last_job_poll_ms = 0;
  ESP_LOGI(TAG, "stt job submitted audio=%s stt=%s status=%s", g_current_audio_job_id, g_stt_job.jobId, g_stt_job.status);
}

static void submit_captured_audio(const DeckAudioStats &stats)
{
  if (!g_network_ready || !valid_selected_slot()) {
    set_ui_status("NOT READY", "NO SLOT");
    deckAudioReset();
    return;
  }

  const uint8_t *wav = deckAudioWavData();
  const size_t wav_len = deckAudioWavSize();
  if (!wav || wav_len == 0) {
    set_ui_status("AUDIO ERROR", "NO WAV");
    deckAudioReset();
    return;
  }

  set_ui_status("UPLOADING", selected_slot_title());
  char footer[72];
  snprintf(footer, sizeof(footer), "%uMS %uB",
           static_cast<unsigned>(stats.durationMs),
           static_cast<unsigned>(wav_len));
  set_ui_footer(footer);
  ESP_LOGI(TAG, "audio upload start slot=%s wav=%u duration_ms=%u peak=%d rms=%d clipped=%u silence=%d",
           selected_slot_id(),
           static_cast<unsigned>(wav_len),
           static_cast<unsigned>(stats.durationMs),
           stats.peak,
           stats.rms,
           static_cast<unsigned>(stats.clippedSamples),
           stats.silenceLikely ? 1 : 0);

  DeckClientStatus status = deckSubmitAudioUtterance(&g_settings, selected_slot_id(), wav, wav_len, &g_audio_upload, &g_snapshot);
  if (status != DeckClientStatus::Ok) {
    ESP_LOGW(TAG, "audio upload failed status=%s http=%d error=%s", deckClientStatusText(status), g_snapshot.httpStatus, g_audio_upload.error);
    set_ui_status("AUDIO FAILED", deckClientStatusText(status));
    set_ui_footer(g_audio_upload.error[0] ? g_audio_upload.error : g_snapshot.error);
    deckAudioReset();
    return;
  }

  ESP_LOGI(TAG, "audio upload ok job=%s bytes=%d duration_ms=%d sample_rate=%d channels=%d bits=%d",
           g_audio_upload.jobId,
           g_audio_upload.bytes,
           g_audio_upload.durationMs,
           g_audio_upload.sampleRate,
           g_audio_upload.channels,
           g_audio_upload.bitsPerSample);
  char detail[72];
  snprintf(detail, sizeof(detail), "%dMS %dHZ %dCH",
           g_audio_upload.durationMs,
           g_audio_upload.sampleRate,
           g_audio_upload.channels);
  set_ui_status("AUDIO RECEIVED", detail);
  set_ui_footer(g_audio_upload.jobId);
  deckAudioReset();
  start_audio_transcription();
}

static void start_selected_recording()
{
  if (!g_network_ready || !valid_selected_slot()) {
    set_ui_status("NOT READY", "NO SLOT");
    return;
  }
  if (g_job_active) {
    set_ui_status("JOB RUNNING", g_job.status);
    return;
  }
  if (deckAudioState() == DeckAudioState::Recording) {
    return;
  }

  DeckAudioStats stats;
  if (!deckAudioStart(&stats)) {
    ESP_LOGW(TAG, "audio start failed error=%s", stats.error);
    set_ui_status("AUDIO ERROR", stats.error[0] ? stats.error : "START FAILED");
    set_ui_footer("TAP TO RETRY");
    set_ui_recording(false);
    deckAudioReset();
    return;
  }
  set_ui_status("RECORDING", selected_slot_title());
  set_ui_footer("TAP TO STOP");
  set_ui_recording(true);
}

static void stop_selected_recording()
{
  if (deckAudioState() != DeckAudioState::Recording) {
    return;
  }

  DeckAudioStats stats;
  if (!deckAudioStop(&stats)) {
    ESP_LOGW(TAG, "audio stop failed error=%s duration_ms=%u", stats.error, static_cast<unsigned>(stats.durationMs));
    set_ui_status("AUDIO ERROR", stats.error[0] ? stats.error : "STOP FAILED");
    set_ui_footer("TAP TO RETRY");
    set_ui_recording(false);
    deckAudioReset();
    return;
  }
  set_ui_recording(false);
  submit_captured_audio(stats);
}

static void poll_audio_recording()
{
  if (deckAudioState() != DeckAudioState::Recording) {
    return;
  }
  DeckAudioStats stats;
  if (!deckAudioPoll(&stats)) {
    if (deckAudioState() == DeckAudioState::Captured && stats.maxDurationReached) {
      set_ui_status("MAX TIME", selected_slot_title());
      set_ui_recording(false);
      submit_captured_audio(stats);
      return;
    }
    ESP_LOGW(TAG, "audio poll failed error=%s", stats.error);
    set_ui_status("AUDIO ERROR", stats.error[0] ? stats.error : "READ FAILED");
    set_ui_footer("TAP TO RETRY");
    set_ui_recording(false);
    deckAudioReset();
    return;
  }
  if (deckAudioState() == DeckAudioState::Captured && stats.maxDurationReached) {
    set_ui_status("MAX TIME", selected_slot_title());
    submit_captured_audio(stats);
    return;
  }
  update_recording_footer(stats);
}

static void poll_active_job()
{
  if (!g_job_active || g_job.jobId[0] == '\0') {
    return;
  }
  const DeckClientStatus status = deckFetchJob(&g_settings, g_job.jobId, &g_job, &g_snapshot);
  if (status != DeckClientStatus::Ok) {
    ESP_LOGW(TAG, "deck job poll failed status=%s http=%d error=%s", deckClientStatusText(status), g_snapshot.httpStatus, g_snapshot.error);
    set_ui_status("JOB POLL", g_snapshot.error);
    return;
  }

  ESP_LOGI(TAG, "deck job poll job=%s status=%s", g_job.jobId, g_job.status);
  if (is_terminal_job_status(g_job.status)) {
    g_job_active = false;
    refresh_deck();
    if (strcmp(g_job.status, "done") == 0) {
      set_ui_status("JOB DONE", selected_slot_title());
      set_ui_footer(g_job.screenReply[0] ? g_job.screenReply : "DONE");
    } else if (strcmp(g_job.status, "waiting_approval") == 0) {
      set_ui_status("APPROVAL", selected_slot_title());
      set_ui_footer(g_job.screenReply[0] ? g_job.screenReply : "OPEN CODEX");
    } else {
      set_ui_status("JOB FAILED", selected_slot_title());
      set_ui_footer(g_job.errorMessage[0] ? g_job.errorMessage : "FAILED");
    }
    return;
  }

  set_ui_status("JOB RUNNING", g_job.status);
  set_ui_footer(g_job.jobId);
}

static void poll_stt_job()
{
  if (!g_stt_active || !g_stt_job.jobId[0]) {
    return;
  }
  if (millis() - g_voice_started_ms > 180000) {
    g_stt_active = false;
    g_reply_ready = true;
    show_ui_text_page("STT ERROR", "NETWORK TIMEOUT", "RETRY", "", "BACK");
    return;
  }

  const DeckClientStatus status = deckFetchJob(&g_settings, g_stt_job.jobId, &g_stt_job, &g_snapshot);
  if (status != DeckClientStatus::Ok) {
    ESP_LOGW(TAG, "stt poll failed status=%s http=%d error=%s", deckClientStatusText(status), g_snapshot.httpStatus, g_snapshot.error);
    show_ui_text_page("TRANSCRIBING", "WORKING\n\nSTT poll retrying.", "", "", "BACK");
    return;
  }

  ESP_LOGI(TAG, "stt poll job=%s status=%s transcript_len=%u",
           g_stt_job.jobId,
           g_stt_job.status,
           static_cast<unsigned>(strlen(g_stt_job.screenTranscript[0] ? g_stt_job.screenTranscript : g_stt_job.transcript)));

  if (strcmp(g_stt_job.status, "done") == 0) {
    g_stt_active = false;
    g_transcript_ready = true;
    const char *text = g_stt_job.screenTranscript[0] ? g_stt_job.screenTranscript : g_stt_job.transcript;
    snprintf(g_current_transcript, sizeof(g_current_transcript), "%s", text && text[0] ? text : "(empty transcript)");
    show_ui_text_page("TRANSCRIPT", g_current_transcript, "RETRY", "SEND", "BACK");
    return;
  }

  if (strcmp(g_stt_job.status, "failed") == 0) {
    g_stt_active = false;
    g_reply_ready = true;
    const char *message = g_stt_job.errorMessage[0] ? g_stt_job.errorMessage : "STT ERROR";
    show_ui_text_page(strstr(message, "UNAVAILABLE") ? "STT UNAVAILABLE" : "STT ERROR", message, "RETRY", "", "BACK");
    return;
  }

  char body[128];
  snprintf(body, sizeof(body), "WORKING\n\n%s", g_stt_job.status[0] ? g_stt_job.status : "running");
  show_ui_text_page("TRANSCRIBING", body, "", "", "BACK");
}

static void send_confirmed_transcript()
{
  if (!g_transcript_ready || !g_current_transcript[0]) {
    return;
  }
  show_ui_text_page("CODEX RUNNING", "QUEUED\n\nSending transcript to Codex.", "", "", "BACK");
  const DeckClientStatus status = deckSubmitCodexSend(
    &g_settings,
    selected_slot_id(),
    g_current_transcript,
    g_current_audio_job_id,
    g_stt_job.jobId,
    &g_job,
    &g_snapshot
  );
  if (status != DeckClientStatus::Ok) {
    ESP_LOGW(TAG, "codex send failed status=%s http=%d error=%s", deckClientStatusText(status), g_snapshot.httpStatus, g_snapshot.error);
    g_transcript_ready = false;
    g_reply_ready = true;
    show_ui_text_page("CODEX ERROR", g_snapshot.error[0] ? g_snapshot.error : deckClientStatusText(status), "RETRY", "", "BACK");
    return;
  }
  g_transcript_ready = false;
  g_voice_codex_active = true;
  g_voice_started_ms = millis();
  g_last_job_poll_ms = 0;
  ESP_LOGI(TAG, "codex job submitted slot=%s job=%s source_audio=%s source_stt=%s",
           selected_slot_id(), g_job.jobId, g_current_audio_job_id, g_stt_job.jobId);
}

static void poll_voice_codex_job()
{
  if (!g_voice_codex_active || !g_job.jobId[0]) {
    return;
  }
  if (millis() - g_voice_started_ms > 180000) {
    g_voice_codex_active = false;
    g_reply_ready = true;
    show_ui_text_page("CODEX ERROR", "NETWORK TIMEOUT", "NEW VOICE", "", "BACK");
    return;
  }

  const DeckClientStatus status = deckFetchJob(&g_settings, g_job.jobId, &g_job, &g_snapshot);
  if (status != DeckClientStatus::Ok) {
    ESP_LOGW(TAG, "codex poll failed status=%s http=%d error=%s", deckClientStatusText(status), g_snapshot.httpStatus, g_snapshot.error);
    show_ui_text_page("CODEX RUNNING", "RUNNING\n\nPoll retrying.", "", "", "BACK");
    return;
  }

  ESP_LOGI(TAG, "codex poll job=%s status=%s reply_len=%u",
           g_job.jobId,
           g_job.status,
           static_cast<unsigned>(strlen(g_job.screenReply)));

  if (strcmp(g_job.status, "done") == 0) {
    g_voice_codex_active = false;
    g_reply_ready = true;
    show_ui_text_page("CODEX REPLY", g_job.screenReply[0] ? g_job.screenReply : "DONE", "NEW VOICE", "", "BACK");
    refresh_deck();
    return;
  }
  if (strcmp(g_job.status, "waiting_approval") == 0) {
    g_voice_codex_active = false;
    g_reply_ready = true;
    show_ui_text_page("APPROVAL NEEDED", g_job.screenReply[0] ? g_job.screenReply : "Open Codex on Mac.", "NEW VOICE", "", "BACK");
    refresh_deck();
    return;
  }
  if (strcmp(g_job.status, "failed") == 0) {
    g_voice_codex_active = false;
    g_reply_ready = true;
    show_ui_text_page("CODEX ERROR", g_job.errorMessage[0] ? g_job.errorMessage : "FAILED", "NEW VOICE", "", "BACK");
    refresh_deck();
    return;
  }

  char body[128];
  snprintf(body, sizeof(body), "RUNNING\n\n%s", g_job.status[0] ? g_job.status : "running");
  show_ui_text_page("CODEX RUNNING", body, "", "", "BACK");
}

static void reset_to_slot_detail()
{
  clear_voice_flow();
  show_ui_home();
  set_ui_recording(false);
  set_ui_slots(&g_snapshot);
  set_ui_selected_slot(g_selected_slot_index);
  set_ui_status("DECK HUB OK", selected_slot_title());
  update_idle_footer();
}

static void handle_pending_ui_actions()
{
  const int slot_index = g_pending_slot_select;
  if (slot_index >= 0) {
    g_pending_slot_select = -1;
    select_slot(slot_index);
  }
  if (g_pending_record_toggle) {
    g_pending_record_toggle = false;
    if (deckAudioState() == DeckAudioState::Recording) {
      stop_selected_recording();
    } else {
      start_selected_recording();
    }
  }
  if (g_pending_confirm_send) {
    g_pending_confirm_send = false;
    send_confirmed_transcript();
  }
  if (g_pending_retry) {
    g_pending_retry = false;
    reset_to_slot_detail();
  }
  if (g_pending_back) {
    g_pending_back = false;
    if (deckAudioState() == DeckAudioState::Recording) {
      DeckAudioStats stats;
      deckAudioStop(&stats);
      deckAudioReset();
      set_ui_recording(false);
    }
    reset_to_slot_detail();
  }
}

static void start_setup_portal(const char *reason)
{
  ESP_LOGW(TAG, "starting setup portal reason=%s", reason ? reason : "setup");
  set_ui_status("SETUP AP", kDeckProvisioningApSsid);
  set_ui_footer(kDeckProvisioningApUrl);
  if (runDeckProvisioningPortal(&g_settings, reason)) {
    set_ui_status("SAVED", "REBOOTING");
    delay(800);
    ESP.restart();
  }
}

void setup()
{
  Serial.begin(115200);
  delay(300);
  deckSnapshotInit(&g_snapshot);
  deckJobSnapshotInit(&g_job);
  deckJobSnapshotInit(&g_stt_job);
  deckAudioUploadSnapshotInit(&g_audio_upload);
  log_boot_banner();

  i2c_master_Init();
  lvgl_port_init();
  deck_ui_set_event_handler(deck_ui_event_handler, nullptr);
  lcd_bl_pwm_bsp_init(LCD_PWM_MODE_255);
  show_ui_home();
  set_ui_status("AUDIO INIT", "PLEASE WAIT");
  DeckAudioStats audio_stats;
  if (!deckAudioInit(&audio_stats)) {
    ESP_LOGW(TAG, "audio init failed error=%s", audio_stats.error);
    set_ui_status("AUDIO ERROR", audio_stats.error[0] ? audio_stats.error : "INIT FAILED");
  }
  ESP_LOGI(TAG, "stage=F stt_codex_ready");
  ESP_LOGI(TAG, "free_heap_after_init=%u", static_cast<unsigned>(esp_get_free_heap_size()));
  ESP_LOGI(TAG, "free_psram_after_init=%u", static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));

  if (!loadDeckSettings(&g_settings)) {
    start_setup_portal("missing config");
    return;
  }

  set_ui_status("WIFI", "CONNECTING");
  const DeckClientStatus wifiStatus = deckConnectWifi(&g_settings, &g_snapshot);
  if (wifiStatus != DeckClientStatus::Ok) {
    ESP_LOGW(TAG, "wifi failed status=%s error=%s", deckClientStatusText(wifiStatus), g_snapshot.error);
    start_setup_portal("wifi failed");
    return;
  }

  g_network_ready = true;
  ESP_LOGI(TAG, "wifi connected ip=%s rssi=%d", g_snapshot.localIp, g_snapshot.wifiRssi);
  set_ui_status("WIFI OK", g_snapshot.localIp);
  if (!refresh_deck()) {
    start_setup_portal("deck hub failed");
    return;
  }
  g_last_refresh_ms = millis();
}

void loop()
{
  handle_pending_ui_actions();
  poll_audio_recording();
  if (g_network_ready && g_job_active && millis() - g_last_job_poll_ms >= CODEX_DECK_JOB_POLL_MS) {
    poll_active_job();
    g_last_job_poll_ms = millis();
  }
  if (g_network_ready && g_stt_active && millis() - g_last_job_poll_ms >= CODEX_DECK_JOB_POLL_MS) {
    poll_stt_job();
    g_last_job_poll_ms = millis();
  }
  if (g_network_ready && g_voice_codex_active && millis() - g_last_job_poll_ms >= CODEX_DECK_JOB_POLL_MS) {
    poll_voice_codex_job();
    g_last_job_poll_ms = millis();
  }
  if (g_network_ready && !voice_flow_active() && millis() - g_last_refresh_ms >= CODEX_DECK_SLOT_REFRESH_MS) {
    refresh_deck();
    g_last_refresh_ms = millis();
  }
  delay(20);
}
