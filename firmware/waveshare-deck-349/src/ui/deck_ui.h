#pragma once

#ifndef __cplusplus
#include <stdbool.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  const char *title;
  const char *subtitle;
  const char *status;
  const char *summary;
} DeckUiSlot;

typedef enum {
  DECK_UI_EVENT_SLOT_CLICKED,
  DECK_UI_EVENT_RECORD_TOGGLE,
  DECK_UI_EVENT_CONFIRM_SEND_CLICKED,
  DECK_UI_EVENT_RETRY_CLICKED,
  DECK_UI_EVENT_BACK_CLICKED,
} DeckUiEvent;

typedef void (*DeckUiEventHandler)(int slot_index, DeckUiEvent event, void *ctx);

void deck_ui_create(void);
void deck_ui_set_event_handler(DeckUiEventHandler handler, void *ctx);
void deck_ui_set_status(const char *title, const char *detail);
void deck_ui_set_footer(const char *text);
void deck_ui_set_recording(bool recording);
void deck_ui_set_slots(const DeckUiSlot *slots, int slot_count);
void deck_ui_set_selected_slot(int slot_index);
void deck_ui_update_touch(int x, int y);
void deck_ui_show_home(void);
void deck_ui_show_text_page(const char *title, const char *body, const char *retry_label, const char *send_label, const char *back_label);

#ifdef __cplusplus
}
#endif
