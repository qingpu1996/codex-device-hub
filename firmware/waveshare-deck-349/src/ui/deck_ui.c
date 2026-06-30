#include "ui/deck_ui.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include "app_config.h"
#include "board/board_config.h"
#include "lvgl.h"

static lv_obj_t *status_title_label = NULL;
static lv_obj_t *status_detail_label = NULL;
static lv_obj_t *footer_label = NULL;
static lv_obj_t *touch_label = NULL;
static lv_obj_t *record_button = NULL;
static lv_obj_t *record_label = NULL;
static lv_obj_t *text_panel = NULL;
static lv_obj_t *text_title_label = NULL;
static lv_obj_t *text_body_label = NULL;
static lv_obj_t *retry_button = NULL;
static lv_obj_t *confirm_button = NULL;
static lv_obj_t *back_button = NULL;
static lv_obj_t *retry_label = NULL;
static lv_obj_t *confirm_label = NULL;
static lv_obj_t *back_label = NULL;
static lv_obj_t *slot_panels[CODEX_DECK_MAX_SLOTS] = {0};
static lv_obj_t *slot_title_labels[CODEX_DECK_MAX_SLOTS] = {0};
static lv_obj_t *slot_meta_labels[CODEX_DECK_MAX_SLOTS] = {0};
static DeckUiEventHandler event_handler = NULL;
static void *event_handler_ctx = NULL;
static int selected_slot_index = 0;

static const lv_font_t *cjk_font(void)
{
  return &codex_deck_cjk_16;
}

static lv_color_t slot_color(int index)
{
  static const lv_color_t colors[] = {
    LV_COLOR_MAKE(0x24, 0x71, 0x8d),
    LV_COLOR_MAKE(0xc2, 0x7a, 0x35),
    LV_COLOR_MAKE(0x5e, 0x55, 0x76),
    LV_COLOR_MAKE(0x34, 0x73, 0x4d),
    LV_COLOR_MAKE(0xa3, 0x45, 0x52),
  };
  return colors[index % CODEX_DECK_MAX_SLOTS];
}

static void set_label_text(lv_obj_t *label, const char *text)
{
  if (!label) {
    return;
  }
  lv_label_set_text(label, text && text[0] ? text : "--");
}

static void emit_event(int slot_index, DeckUiEvent event)
{
  if (event_handler) {
    event_handler(slot_index, event, event_handler_ctx);
  }
}

static void slot_event_cb(lv_event_t *event)
{
  intptr_t index = (intptr_t)lv_event_get_user_data(event);
  emit_event((int)index, DECK_UI_EVENT_SLOT_CLICKED);
}

static void record_event_cb(lv_event_t *event)
{
  (void)event;
  emit_event(selected_slot_index, DECK_UI_EVENT_RECORD_TOGGLE);
}

static void retry_event_cb(lv_event_t *event)
{
  (void)event;
  emit_event(selected_slot_index, DECK_UI_EVENT_RETRY_CLICKED);
}

static void confirm_event_cb(lv_event_t *event)
{
  (void)event;
  emit_event(selected_slot_index, DECK_UI_EVENT_CONFIRM_SEND_CLICKED);
}

static void back_event_cb(lv_event_t *event)
{
  (void)event;
  emit_event(selected_slot_index, DECK_UI_EVENT_BACK_CLICKED);
}

static lv_obj_t *create_action_button(lv_obj_t *screen, int y, lv_color_t bg, lv_event_cb_t cb, lv_obj_t **label_out)
{
  lv_obj_t *button = lv_button_create(screen);
  lv_obj_set_size(button, 156, 44);
  lv_obj_set_style_radius(button, 0, 0);
  lv_obj_set_style_bg_color(button, bg, 0);
  lv_obj_set_style_bg_opa(button, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(button, 1, 0);
  lv_obj_set_style_border_color(button, lv_color_hex(0x1e2529), 0);
  lv_obj_add_event_cb(button, cb, LV_EVENT_CLICKED, NULL);
  lv_obj_align(button, LV_ALIGN_TOP_MID, 0, y);

  lv_obj_t *label = lv_label_create(button);
  lv_obj_set_style_text_color(label, lv_color_hex(0x081315), 0);
  lv_obj_set_style_text_font(label, &lv_font_montserrat_14, 0);
  lv_label_set_long_mode(label, LV_LABEL_LONG_CLIP);
  lv_obj_set_width(label, 140);
  lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_center(label);
  *label_out = label;
  return button;
}

void deck_ui_create(void)
{
  lv_obj_t *screen = lv_screen_active();
  lv_obj_set_style_bg_color(screen, lv_color_hex(0x0f1417), 0);
  lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);

  lv_obj_t *title = lv_label_create(screen);
  lv_label_set_text(title, "CODEX\nDECK");
  lv_obj_set_style_text_color(title, lv_color_hex(0xf7f2df), 0);
  lv_obj_set_style_text_align(title, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(title, &lv_font_montserrat_14, 0);
  lv_obj_set_width(title, DECK_SCREEN_WIDTH);
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 12);

  status_title_label = lv_label_create(screen);
  lv_obj_set_style_text_color(status_title_label, lv_color_hex(0x9ec7d4), 0);
  lv_obj_set_style_text_align(status_title_label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(status_title_label, &lv_font_montserrat_14, 0);
  lv_obj_set_width(status_title_label, DECK_SCREEN_WIDTH);
  lv_obj_align(status_title_label, LV_ALIGN_TOP_MID, 0, 70);

  status_detail_label = lv_label_create(screen);
  lv_obj_set_style_text_color(status_detail_label, lv_color_hex(0xd7e3ea), 0);
  lv_obj_set_style_text_align(status_detail_label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_width(status_detail_label, DECK_SCREEN_WIDTH);
  lv_obj_align(status_detail_label, LV_ALIGN_TOP_MID, 0, 92);

  const int panel_w = 156;
  const int panel_h = 64;
  for (int i = 0; i < CODEX_DECK_MAX_SLOTS; i++) {
    lv_obj_t *panel = lv_obj_create(screen);
    slot_panels[i] = panel;
    lv_obj_set_size(panel, panel_w, panel_h);
    lv_obj_set_style_radius(panel, 0, 0);
    lv_obj_set_style_border_width(panel, 1, 0);
    lv_obj_set_style_border_color(panel, lv_color_hex(0xe5edf0), 0);
    lv_obj_set_style_outline_width(panel, 0, 0);
    lv_obj_set_style_bg_color(panel, slot_color(i), 0);
    lv_obj_set_style_bg_opa(panel, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(panel, 6, 0);
    lv_obj_clear_flag(panel, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(panel, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(panel, slot_event_cb, LV_EVENT_CLICKED, (void *)(intptr_t)i);
    lv_obj_align(panel, LV_ALIGN_TOP_MID, 0, 126 + i * 74);

    slot_title_labels[i] = lv_label_create(panel);
    lv_label_set_text(slot_title_labels[i], "--");
    lv_obj_set_style_text_color(slot_title_labels[i], lv_color_hex(0xffffff), 0);
    lv_obj_set_style_text_font(slot_title_labels[i], &lv_font_montserrat_14, 0);
    lv_label_set_long_mode(slot_title_labels[i], LV_LABEL_LONG_CLIP);
    lv_obj_set_width(slot_title_labels[i], panel_w - 12);
    lv_obj_add_flag(slot_title_labels[i], LV_OBJ_FLAG_EVENT_BUBBLE);
    lv_obj_align(slot_title_labels[i], LV_ALIGN_TOP_LEFT, 0, 0);

    slot_meta_labels[i] = lv_label_create(panel);
    lv_label_set_text(slot_meta_labels[i], "waiting");
    lv_obj_set_style_text_color(slot_meta_labels[i], lv_color_hex(0xf2f6f8), 0);
    lv_label_set_long_mode(slot_meta_labels[i], LV_LABEL_LONG_CLIP);
    lv_obj_set_width(slot_meta_labels[i], panel_w - 12);
    lv_obj_add_flag(slot_meta_labels[i], LV_OBJ_FLAG_EVENT_BUBBLE);
    lv_obj_align(slot_meta_labels[i], LV_ALIGN_TOP_LEFT, 0, 24);
  }

  record_button = lv_button_create(screen);
  lv_obj_set_size(record_button, 156, 72);
  lv_obj_set_style_radius(record_button, 0, 0);
  lv_obj_set_style_bg_color(record_button, lv_color_hex(0x66b5a7), 0);
  lv_obj_set_style_bg_opa(record_button, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(record_button, 1, 0);
  lv_obj_set_style_border_color(record_button, lv_color_hex(0x1e2529), 0);
  lv_obj_add_event_cb(record_button, record_event_cb, LV_EVENT_CLICKED, NULL);
  lv_obj_align(record_button, LV_ALIGN_TOP_MID, 0, 494);

  record_label = lv_label_create(record_button);
  lv_label_set_text(record_label, "TAP TO RECORD");
  lv_obj_set_style_text_color(record_label, lv_color_hex(0x081315), 0);
  lv_obj_set_style_text_font(record_label, &lv_font_montserrat_14, 0);
  lv_label_set_long_mode(record_label, LV_LABEL_LONG_CLIP);
  lv_obj_set_width(record_label, 140);
  lv_obj_set_style_text_align(record_label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_center(record_label);

  footer_label = lv_label_create(screen);
  lv_obj_set_style_text_color(footer_label, lv_color_hex(0xaebcc4), 0);
  lv_obj_set_style_text_align(footer_label, LV_TEXT_ALIGN_CENTER, 0);
  lv_label_set_long_mode(footer_label, LV_LABEL_LONG_CLIP);
  lv_obj_set_width(footer_label, DECK_SCREEN_WIDTH);
  lv_obj_align(footer_label, LV_ALIGN_TOP_MID, 0, 574);

  touch_label = lv_label_create(screen);
  lv_obj_set_style_text_color(touch_label, lv_color_hex(0xf7f2df), 0);
  lv_obj_set_style_text_align(touch_label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_width(touch_label, DECK_SCREEN_WIDTH);
  lv_obj_align(touch_label, LV_ALIGN_BOTTOM_MID, 0, -10);

  text_panel = lv_obj_create(screen);
  lv_obj_set_size(text_panel, 160, 430);
  lv_obj_set_style_radius(text_panel, 0, 0);
  lv_obj_set_style_border_width(text_panel, 1, 0);
  lv_obj_set_style_border_color(text_panel, lv_color_hex(0x40515a), 0);
  lv_obj_set_style_bg_color(text_panel, lv_color_hex(0x151d21), 0);
  lv_obj_set_style_bg_opa(text_panel, LV_OPA_COVER, 0);
  lv_obj_set_style_pad_all(text_panel, 7, 0);
  lv_obj_add_flag(text_panel, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_scroll_dir(text_panel, LV_DIR_VER);
  lv_obj_align(text_panel, LV_ALIGN_TOP_MID, 0, 42);

  text_title_label = lv_label_create(text_panel);
  lv_obj_set_style_text_color(text_title_label, lv_color_hex(0x9ec7d4), 0);
  lv_obj_set_style_text_font(text_title_label, &lv_font_montserrat_14, 0);
  lv_label_set_long_mode(text_title_label, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(text_title_label, 142);
  lv_obj_align(text_title_label, LV_ALIGN_TOP_LEFT, 0, 0);

  text_body_label = lv_label_create(text_panel);
  lv_obj_set_style_text_color(text_body_label, lv_color_hex(0xf7f2df), 0);
  lv_obj_set_style_text_font(text_body_label, cjk_font(), 0);
  lv_obj_set_style_text_line_space(text_body_label, 4, 0);
  lv_label_set_long_mode(text_body_label, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(text_body_label, 142);
  lv_obj_align(text_body_label, LV_ALIGN_TOP_LEFT, 0, 28);

  retry_button = create_action_button(screen, 484, lv_color_hex(0x66b5a7), retry_event_cb, &retry_label);
  confirm_button = create_action_button(screen, 532, lv_color_hex(0xf0c05a), confirm_event_cb, &confirm_label);
  back_button = create_action_button(screen, 580, lv_color_hex(0xd7e3ea), back_event_cb, &back_label);

  deck_ui_set_selected_slot(0);
  deck_ui_set_status("STAGE E", "BOOTING");
  deck_ui_set_footer("SLOTS + JOBS");
  deck_ui_update_touch(-1, -1);
  deck_ui_show_home();
}

void deck_ui_set_event_handler(DeckUiEventHandler handler, void *ctx)
{
  event_handler = handler;
  event_handler_ctx = ctx;
}

void deck_ui_set_status(const char *title, const char *detail)
{
  set_label_text(status_title_label, title);
  set_label_text(status_detail_label, detail);
}

void deck_ui_set_footer(const char *text)
{
  set_label_text(footer_label, text);
}

void deck_ui_set_recording(bool recording)
{
  set_label_text(record_label, recording ? "TAP TO STOP" : "TAP TO RECORD");
  if (record_button) {
    lv_obj_set_style_bg_color(record_button, lv_color_hex(recording ? 0xf0c05a : 0x66b5a7), 0);
  }
}

void deck_ui_set_slots(const DeckUiSlot *slots, int slot_count)
{
  for (int i = 0; i < CODEX_DECK_MAX_SLOTS; i++) {
    if (i < slot_count && slots) {
      set_label_text(slot_title_labels[i], slots[i].title);
      char meta[128];
      const char *summary = slots[i].summary && slots[i].summary[0] ? slots[i].summary : slots[i].subtitle;
      snprintf(meta, sizeof(meta), "%s\n%s", slots[i].status && slots[i].status[0] ? slots[i].status : "idle", summary && summary[0] ? summary : "--");
      set_label_text(slot_meta_labels[i], meta);
      lv_obj_clear_flag(slot_panels[i], LV_OBJ_FLAG_HIDDEN);
    } else {
      set_label_text(slot_title_labels[i], "--");
      set_label_text(slot_meta_labels[i], "not loaded");
    }
  }
}

void deck_ui_set_selected_slot(int slot_index)
{
  if (slot_index < 0 || slot_index >= CODEX_DECK_MAX_SLOTS) {
    return;
  }
  selected_slot_index = slot_index;
  for (int i = 0; i < CODEX_DECK_MAX_SLOTS; i++) {
    if (!slot_panels[i]) {
      continue;
    }
    if (i == selected_slot_index) {
      lv_obj_set_style_border_width(slot_panels[i], 3, 0);
      lv_obj_set_style_border_color(slot_panels[i], lv_color_hex(0xffdf74), 0);
      lv_obj_set_style_outline_width(slot_panels[i], 2, 0);
      lv_obj_set_style_outline_color(slot_panels[i], lv_color_hex(0x11181b), 0);
    } else {
      lv_obj_set_style_border_width(slot_panels[i], 1, 0);
      lv_obj_set_style_border_color(slot_panels[i], lv_color_hex(0xe5edf0), 0);
      lv_obj_set_style_outline_width(slot_panels[i], 0, 0);
    }
  }
}

void deck_ui_update_touch(int x, int y)
{
  if (!touch_label) {
    return;
  }
  char text[32];
  if (x < 0 || y < 0) {
    snprintf(text, sizeof(text), "X: --  Y: --");
  } else {
    snprintf(text, sizeof(text), "X:%d Y:%d", x, y);
  }
  lv_label_set_text(touch_label, text);
}

void deck_ui_show_home(void)
{
  for (int i = 0; i < CODEX_DECK_MAX_SLOTS; i++) {
    if (slot_panels[i]) {
      lv_obj_clear_flag(slot_panels[i], LV_OBJ_FLAG_HIDDEN);
    }
  }
  lv_obj_clear_flag(record_button, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(status_title_label, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(status_detail_label, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(footer_label, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(touch_label, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(text_panel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(retry_button, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(confirm_button, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(back_button, LV_OBJ_FLAG_HIDDEN);
}

void deck_ui_show_text_page(const char *title, const char *body, const char *retry, const char *send, const char *back)
{
  for (int i = 0; i < CODEX_DECK_MAX_SLOTS; i++) {
    if (slot_panels[i]) {
      lv_obj_add_flag(slot_panels[i], LV_OBJ_FLAG_HIDDEN);
    }
  }
  lv_obj_add_flag(record_button, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(status_title_label, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(status_detail_label, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(footer_label, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(touch_label, LV_OBJ_FLAG_HIDDEN);

  set_label_text(text_title_label, title);
  set_label_text(text_body_label, body);
  lv_obj_scroll_to_y(text_panel, 0, LV_ANIM_OFF);
  lv_obj_clear_flag(text_panel, LV_OBJ_FLAG_HIDDEN);

  set_label_text(retry_label, retry);
  set_label_text(confirm_label, send);
  set_label_text(back_label, back);
  if (retry && retry[0]) {
    lv_obj_clear_flag(retry_button, LV_OBJ_FLAG_HIDDEN);
  } else {
    lv_obj_add_flag(retry_button, LV_OBJ_FLAG_HIDDEN);
  }
  if (send && send[0]) {
    lv_obj_clear_flag(confirm_button, LV_OBJ_FLAG_HIDDEN);
  } else {
    lv_obj_add_flag(confirm_button, LV_OBJ_FLAG_HIDDEN);
  }
  if (back && back[0]) {
    lv_obj_clear_flag(back_button, LV_OBJ_FLAG_HIDDEN);
  } else {
    lv_obj_add_flag(back_button, LV_OBJ_FLAG_HIDDEN);
  }
}
