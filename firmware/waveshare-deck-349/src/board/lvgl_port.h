#ifndef LVGL_PORT_H
#define LVGL_PORT_H

#include <stdbool.h>


#ifdef __cplusplus
extern "C" {
#endif


void lvgl_port_init(void);
bool lvgl_port_lock(int timeout_ms);
void lvgl_port_unlock(void);
bool lvgl_port_set_ns_mode(bool enable);


#ifdef __cplusplus
}
#endif



#endif
