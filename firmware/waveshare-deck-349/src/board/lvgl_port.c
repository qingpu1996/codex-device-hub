#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdlib.h>
#include "lvgl_port.h"
#include "lvgl.h"
#include "esp_log.h"
#include "esp_err.h"
#include "esp_timer.h"
#include "user_config.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_lcd_io_spi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_io.h"
#include "axs15231b/esp_lcd_axs15231b.h"
#include "tca9554/esp_io_expander_tca9554.h"
#include "i2c_bsp.h"
#include "ui/deck_ui.h"

static const char *TAG = "lvgl_port";
static SemaphoreHandle_t lvgl_mux = NULL;

static uint16_t *trans_buf_1 = NULL;
uint8_t *lvgl_dest = NULL;                //旋转buffer
static SemaphoreHandle_t flush_done_semaphore;
static esp_io_expander_handle_t io_expander = NULL;

#define LCD_BIT_PER_PIXEL 16
#define BYTES_PER_PIXEL (LV_COLOR_FORMAT_GET_SIZE(LV_COLOR_FORMAT_RGB565))
#define BUFF_SIZE (EXAMPLE_LCD_H_RES * EXAMPLE_LCD_V_RES * BYTES_PER_PIXEL)


static const axs15231b_lcd_init_cmd_t lcd_init_cmds[] =
{
  {0x11, (uint8_t []){0x00}, 0, 100},
  {0x29, (uint8_t []){0x00}, 0, 100},
};

static bool example_notify_lvgl_flush_ready(esp_lcd_panel_io_handle_t panel_io, esp_lcd_panel_io_event_data_t *edata, void *user_ctx)
{
  BaseType_t TaskWoken;
  xSemaphoreGiveFromISR(flush_done_semaphore,&TaskWoken);
  return false;
}

static void example_increase_lvgl_tick(void *arg)
{
  lv_tick_inc(LVGL_TICK_PERIOD_MS);
}

static void example_lvgl_flush_cb(lv_display_t * disp, const lv_area_t * area, uint8_t * color_p)
{
  esp_lcd_panel_handle_t panel_handle = (esp_lcd_panel_handle_t)lv_display_get_user_data(disp);
  lv_draw_sw_rgb565_swap(color_p, lv_area_get_width(area) * lv_area_get_height(area));
#if (Rotated == USER_DISP_ROT_90)
  lv_display_rotation_t rotation = lv_display_get_rotation(disp);
  lv_area_t rotated_area;
  if(rotation != LV_DISPLAY_ROTATION_0)
  {
    lv_color_format_t cf = lv_display_get_color_format(disp);
    /*Calculate the position of the rotated area*/
    rotated_area = *area;
    lv_display_rotate_area(disp, &rotated_area);
    /*Calculate the source stride (bytes in a line) from the width of the area*/
    uint32_t src_stride = lv_draw_buf_width_to_stride(lv_area_get_width(area), cf);
    /*Calculate the stride of the destination (rotated) area too*/
    uint32_t dest_stride = lv_draw_buf_width_to_stride(lv_area_get_width(&rotated_area), cf);
    /*Have a buffer to store the rotated area and perform the rotation*/

    int32_t src_w = lv_area_get_width(area);
    int32_t src_h = lv_area_get_height(area);
    lv_draw_sw_rotate(color_p, lvgl_dest, src_w, src_h, src_stride, dest_stride, rotation, cf);
    /*Use the rotated area and rotated buffer from now on*/
    area = &rotated_area;
  }

  const int flush_coun = (LVGL_SPIRAM_BUFF_LEN / LVGL_DMA_BUFF_LEN);
  const int offgap = (EXAMPLE_LCD_V_RES / flush_coun);
  const int dmalen = (LVGL_DMA_BUFF_LEN / 2);
  int offsetx1 = 0;
  int offsety1 = 0;
  int offsetx2 = EXAMPLE_LCD_H_RES;
  int offsety2 = offgap;

  uint16_t *map = (uint16_t *)lvgl_dest;
  xSemaphoreGive(flush_done_semaphore);
  for(int i = 0; i<flush_coun; i++)
  {
    xSemaphoreTake(flush_done_semaphore,portMAX_DELAY);
    memcpy(trans_buf_1,map,LVGL_DMA_BUFF_LEN);
    esp_lcd_panel_draw_bitmap(panel_handle, offsetx1, offsety1, offsetx2, offsety2, trans_buf_1);
    offsety1 += offgap;
    offsety2 += offgap;
    map += dmalen;
  }
  xSemaphoreTake(flush_done_semaphore,portMAX_DELAY);
  lv_disp_flush_ready(disp);
#else
  const int flush_coun = (LVGL_SPIRAM_BUFF_LEN / LVGL_DMA_BUFF_LEN);
  const int offgap = (EXAMPLE_LCD_V_RES / flush_coun);
  const int dmalen = (LVGL_DMA_BUFF_LEN / 2);
  int offsetx1 = 0;
  int offsety1 = 0;
  int offsetx2 = EXAMPLE_LCD_H_RES;
  int offsety2 = offgap;

  uint16_t *map = (uint16_t *)color_p;
  xSemaphoreGive(flush_done_semaphore);
  for(int i = 0; i<flush_coun; i++)
  {
    xSemaphoreTake(flush_done_semaphore,portMAX_DELAY);
    memcpy(trans_buf_1,map,LVGL_DMA_BUFF_LEN);
    esp_lcd_panel_draw_bitmap(panel_handle, offsetx1, offsety1, offsetx2, offsety2, trans_buf_1);
    offsety1 += offgap;
    offsety2 += offgap;
    map += dmalen;
  }
  xSemaphoreTake(flush_done_semaphore,portMAX_DELAY);
  lv_disp_flush_ready(disp);
#endif
}
static void TouchInputReadCallback(lv_indev_t * indev, lv_indev_data_t *indevData)
{
  uint8_t read_touchpad_cmd[11] = {0xb5, 0xab, 0xa5, 0x5a, 0x0, 0x0, 0x0, 0x0e,0x0, 0x0, 0x0};
  uint8_t buff[32] = {0};
  ESP_ERROR_CHECK_WITHOUT_ABORT(i2c_master_write_read_dev(disp_touch_dev_handle,read_touchpad_cmd,11,buff,32));
  uint16_t pointX;
  uint16_t pointY;
  static int last_logged_x = -1;
  static int last_logged_y = -1;
  pointX = (((uint16_t)buff[2] & 0x0f) << 8) | (uint16_t)buff[3];
  pointY = (((uint16_t)buff[4] & 0x0f) << 8) | (uint16_t)buff[5];
  if (buff[1]>0 && buff[1]<5)
  {
    indevData->state = LV_INDEV_STATE_PRESSED;
    if(pointX > EXAMPLE_LCD_V_RES) pointX = EXAMPLE_LCD_V_RES;
    if(pointY > EXAMPLE_LCD_H_RES) pointY = EXAMPLE_LCD_H_RES;
    indevData->point.x = pointY;
    indevData->point.y = (EXAMPLE_LCD_V_RES-pointX);
    deck_ui_update_touch(indevData->point.x, indevData->point.y);
    if (abs((int)indevData->point.x - last_logged_x) > 2 || abs((int)indevData->point.y - last_logged_y) > 2)
    {
      last_logged_x = indevData->point.x;
      last_logged_y = indevData->point.y;
      ESP_LOGI("Touch", "touch x=%d y=%d raw_x=%u raw_y=%u points=%u", indevData->point.x, indevData->point.y, pointX, pointY, buff[1]);
    }
  }
  else
  {
    indevData->state = LV_INDEV_STATE_RELEASED;
  }
}

bool lvgl_port_lock(int timeout_ms)
{
  const TickType_t timeout_ticks = (timeout_ms == -1) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
  return xSemaphoreTake(lvgl_mux, timeout_ticks) == pdTRUE;
}

void lvgl_port_unlock(void)
{
  assert(lvgl_mux && "bsp_display_start must be called first");
  xSemaphoreGive(lvgl_mux);
}

bool lvgl_port_set_ns_mode(bool enable)
{
  if (io_expander == NULL) {
    return false;
  }
  esp_err_t err = esp_io_expander_set_dir(io_expander, EXAMPLE_EXIO_PIN_NS_MODE, IO_EXPANDER_OUTPUT);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "set ns dir failed err=%d", err);
    return false;
  }
  err = esp_io_expander_set_level(io_expander, EXAMPLE_EXIO_PIN_NS_MODE, enable ? 1 : 0);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "set ns level failed err=%d", err);
    return false;
  }
  return true;
}

void example_lvgl_port_task(void *arg)
{
  uint32_t task_delay_ms = LVGL_TASK_MAX_DELAY_MS;
  for(;;)
  {
    if (lvgl_port_lock(-1))
    {
      task_delay_ms = lv_timer_handler();
      //Release the mutex
      lvgl_port_unlock();
    }
    if (task_delay_ms > LVGL_TASK_MAX_DELAY_MS)
    {
      task_delay_ms = LVGL_TASK_MAX_DELAY_MS;
    } else if (task_delay_ms < LVGL_TASK_MIN_DELAY_MS)
    {
      task_delay_ms = LVGL_TASK_MIN_DELAY_MS;
    }
    vTaskDelay(pdMS_TO_TICKS(task_delay_ms));
  }
}

static void example_lcd_pwm_off_early(void)
{
  gpio_config_t gpio_conf = {};
  gpio_conf.intr_type = GPIO_INTR_DISABLE;
  gpio_conf.mode = GPIO_MODE_OUTPUT;
  gpio_conf.pin_bit_mask = ((uint64_t)1 << EXAMPLE_PIN_NUM_BK_LIGHT);
  gpio_conf.pull_down_en = GPIO_PULLDOWN_ENABLE;
  gpio_conf.pull_up_en = GPIO_PULLUP_DISABLE;
  ESP_ERROR_CHECK(gpio_config(&gpio_conf));
  ESP_ERROR_CHECK(gpio_set_level(EXAMPLE_PIN_NUM_BK_LIGHT, 0));
}

static void example_lcd_exio_init(void)
{
  if (io_expander == NULL) {
    i2c_master_bus_handle_t tca9554_i2c_bus = NULL;
    ESP_ERROR_CHECK(i2c_master_get_bus_handle(0, &tca9554_i2c_bus));
    ESP_ERROR_CHECK(esp_io_expander_new_i2c_tca9554(tca9554_i2c_bus, ESP_IO_EXPANDER_I2C_TCA9554_ADDRESS_000, &io_expander));
  }

  ESP_ERROR_CHECK(esp_io_expander_set_dir(io_expander, EXAMPLE_EXIO_PIN_TOUCH_INT, IO_EXPANDER_INPUT));
  ESP_ERROR_CHECK(esp_io_expander_set_dir(io_expander, EXAMPLE_EXIO_PIN_BL_EN | EXAMPLE_EXIO_PIN_LCD_RST, IO_EXPANDER_OUTPUT));
  ESP_ERROR_CHECK(esp_io_expander_set_level(io_expander, EXAMPLE_EXIO_PIN_BL_EN, 0));
  ESP_ERROR_CHECK(esp_io_expander_set_level(io_expander, EXAMPLE_EXIO_PIN_LCD_RST, 1));
}

static void example_lcd_reset(void)
{
  ESP_ERROR_CHECK(esp_io_expander_set_level(io_expander, EXAMPLE_EXIO_PIN_LCD_RST, 1));
  vTaskDelay(pdMS_TO_TICKS(30));
  ESP_ERROR_CHECK(esp_io_expander_set_level(io_expander, EXAMPLE_EXIO_PIN_LCD_RST, 0));
  vTaskDelay(pdMS_TO_TICKS(250));
  ESP_ERROR_CHECK(esp_io_expander_set_level(io_expander, EXAMPLE_EXIO_PIN_LCD_RST, 1));
  vTaskDelay(pdMS_TO_TICKS(30));
}

static void example_lcd_backlight_set(bool enable)
{
  ESP_ERROR_CHECK(gpio_set_level(EXAMPLE_PIN_NUM_BK_LIGHT, enable ? 1 : 0));
  ESP_ERROR_CHECK(esp_io_expander_set_level(io_expander, EXAMPLE_EXIO_PIN_BL_EN, enable ? 1 : 0));
}

void lvgl_port_init(void)
{
  flush_done_semaphore = xSemaphoreCreateBinary();
  assert(flush_done_semaphore);
  ESP_LOGI(TAG, "Initialize LCD reset and backlight");
  example_lcd_pwm_off_early();
  example_lcd_exio_init();

  ESP_LOGI(TAG, "Initialize QSPI bus");
  spi_bus_config_t buscfg = {};
    buscfg.data0_io_num = EXAMPLE_PIN_NUM_LCD_DATA0;
    buscfg.data1_io_num = EXAMPLE_PIN_NUM_LCD_DATA1;
    buscfg.sclk_io_num = EXAMPLE_PIN_NUM_LCD_PCLK;
    buscfg.data2_io_num = EXAMPLE_PIN_NUM_LCD_DATA2;
    buscfg.data3_io_num = EXAMPLE_PIN_NUM_LCD_DATA3;
    buscfg.max_transfer_sz = LVGL_DMA_BUFF_LEN;
  ESP_ERROR_CHECK(spi_bus_initialize(LCD_HOST, &buscfg, SPI_DMA_CH_AUTO));

  ESP_LOGI(TAG, "Install panel IO");
	  esp_lcd_panel_io_handle_t panel_io = NULL;
    esp_lcd_panel_handle_t panel = NULL;

  esp_lcd_panel_io_spi_config_t io_config = {};
	io_config.cs_gpio_num = EXAMPLE_PIN_NUM_LCD_CS;
    io_config.dc_gpio_num = -1;
    io_config.spi_mode = 3;
    io_config.pclk_hz = 40 * 1000 * 1000;
    io_config.trans_queue_depth = 10;
    io_config.on_color_trans_done = example_notify_lvgl_flush_ready;
    //io_config.user_ctx = &disp_drv,
    io_config.lcd_cmd_bits = 32;
    io_config.lcd_param_bits = 8;
    io_config.flags.quad_mode = true;
	ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(LCD_HOST, &io_config, &panel_io));

  axs15231b_vendor_config_t vendor_config = {};
    vendor_config.flags.use_qspi_interface = 1;
    vendor_config.init_cmds = lcd_init_cmds;
    vendor_config.init_cmds_size = sizeof(lcd_init_cmds) / sizeof(lcd_init_cmds[0]);

  esp_lcd_panel_dev_config_t panel_config = {};
    panel_config.reset_gpio_num = -1;
    panel_config.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
    panel_config.bits_per_pixel = LCD_BIT_PER_PIXEL;
    panel_config.vendor_config = &vendor_config;

  ESP_LOGI(TAG, "Install panel driver");
  ESP_ERROR_CHECK(esp_lcd_new_panel_axs15231b(panel_io, &panel_config, &panel));

  example_lcd_reset();
  ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
  example_lcd_backlight_set(true);

  lv_init();

  lv_display_t * disp = lv_display_create(EXAMPLE_LCD_H_RES, EXAMPLE_LCD_V_RES);  /* 以水平和垂直分辨率（像素）进行基本初始化 */
  lv_display_set_flush_cb(disp, example_lvgl_flush_cb);                           /* 设置刷新回调函数以绘制到显示屏 */

  uint8_t *buffer_1 = NULL;
  uint8_t *buffer_2 = NULL;
  buffer_1 = (uint8_t *)heap_caps_malloc(BUFF_SIZE, MALLOC_CAP_SPIRAM);
  buffer_2 = (uint8_t *)heap_caps_malloc(BUFF_SIZE, MALLOC_CAP_SPIRAM);
  assert(buffer_1);
  assert(buffer_2);
	trans_buf_1 = (uint16_t *)heap_caps_malloc(LVGL_DMA_BUFF_LEN, MALLOC_CAP_DMA);
	assert(trans_buf_1);
  lv_display_set_buffers(disp, buffer_1, buffer_2, BUFF_SIZE, LV_DISPLAY_RENDER_MODE_FULL);
  lv_display_set_user_data(disp, panel);
#if (Rotated == USER_DISP_ROT_90)
    lvgl_dest = (uint8_t *)heap_caps_malloc(BUFF_SIZE, MALLOC_CAP_SPIRAM); //旋转buf
    lv_display_set_rotation(disp, LV_DISPLAY_ROTATION_270);
#endif
  /*port indev*/
  lv_indev_t *touch_indev = NULL;
  touch_indev = lv_indev_create();
  lv_indev_set_type(touch_indev, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(touch_indev, TouchInputReadCallback);

  ESP_LOGI(TAG, "Install LVGL tick timer");
  esp_timer_create_args_t lvgl_tick_timer_args = {};
    lvgl_tick_timer_args.callback = &example_increase_lvgl_tick;
    lvgl_tick_timer_args.name = "lvgl_tick";
  esp_timer_handle_t lvgl_tick_timer = NULL;
  ESP_ERROR_CHECK(esp_timer_create(&lvgl_tick_timer_args, &lvgl_tick_timer));
  ESP_ERROR_CHECK(esp_timer_start_periodic(lvgl_tick_timer,LVGL_TICK_PERIOD_MS * 1000));

  lvgl_mux = xSemaphoreCreateMutex();
  assert(lvgl_mux);
  xTaskCreatePinnedToCore(example_lvgl_port_task, "LVGL", LVGL_TASK_STACK_SIZE, NULL, LVGL_TASK_PRIORITY, NULL,0);
  if (lvgl_port_lock(-1))
  {
    deck_ui_create();
    lvgl_port_unlock();
  }
}
