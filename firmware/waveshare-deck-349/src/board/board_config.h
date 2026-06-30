#pragma once

#include "driver/gpio.h"
#include "app_config.h"

// Waveshare V2 official examples use LCD_TE on GPIO21 and LCD_RESET through
// the TCA9554 IO expander. V1 swaps the TE/reset wiring; choose with
// DECK_HARDWARE_VARIANT and do not mix V1/V2 official example packages.
#if DECK_HARDWARE_VARIANT == 2
#define DECK_LCD_TE_GPIO GPIO_NUM_21
#define DECK_LCD_RST_GPIO (-1)
#else
#define DECK_LCD_TE_GPIO (-1)
#define DECK_LCD_RST_GPIO GPIO_NUM_21
#endif

#define DECK_SCREEN_WIDTH 172
#define DECK_SCREEN_HEIGHT 640
