# codex-quota-e1002-firmware

Custom Arduino/PlatformIO firmware for Seeed Studio reTerminal E1002. The device wakes every 5 minutes, fetches a small LAN JSON payload from the Mac mini `codex-quota-dashboard` service when the current page needs it, renders directly to the 800 x 480 six-color ePaper panel with Seeed_GFX, then enters deep sleep.

## Architecture

```text
Codex CLI
  -> Mac codex-quota-dashboard service
  -> LAN JSON API
  -> E1002 Wi-Fi client
  -> Seeed_GFX native drawing
  -> six-color ePaper
  -> deep sleep
```

The E1002 does not run HTML, CSS, JavaScript, iframe content, or a browser for the dashboard itself. Native JSON rendering is smaller, avoids SenseCraft HTML runtime limits, lets the ESP32-S3 control Wi-Fi lifetime, and makes deep sleep predictable.

The only HTML in this firmware is a temporary local setup portal served by the E1002 SoftAP for entering Wi-Fi and Mac API settings.

The existing Mac SSR browser page is separate and is not removed by this firmware.

## Pages

Current fixed page registry:

| Slot | PageId | Policy | Description |
| --- | --- | --- | --- |
| 1 | `CodexQuota` | `PeriodicData` | Codex quota dashboard from the Mac JSON API. |
| 2 | `TodayMeal` | `Static` | Placeholder only. It does not load recipe data, SD files, images, calories, ingredients, or any network resource. |

Every page shows a dynamic page indicator in the bottom-right corner:

```text
P1/2
P2/2
```

The first number is the current page slot and the second number is the registered page count. If the registry grows to 6 pages, the same code will format `P1/6`, `P2/6`, and so on.

## Built-in Buttons

The three built-in physical buttons are active LOW and can wake the ESP32-S3 from deep sleep:

| Physical button | Seeed name | GPIO | Action |
| --- | --- | --- | --- |
| Right green | KEY0 | GPIO3 | Refresh current page. |
| Middle | KEY1 | GPIO4 | Next page, looping after the last page. |
| Left | KEY2 | GPIO5 | Press N times to go directly to page N. |

Left-button direct page selection uses a `1400 ms` multi-click window and `40 ms` debounce. The first press that wakes the device from deep sleep is counted as click 1. The wider window accounts for ESP32-S3 deep-sleep wake latency. With the current two-page registry:

```text
Left x1 -> Page 1
Left x2 -> Page 2
Left x3 -> invalid, keep the current page
```

The bottom footer uses:

```text
LEFT:N=PAGE    MID:NEXT    GREEN:REFRESH    Pn/total
```

## Refresh Policies

`PeriodicData` pages may connect to Wi-Fi. The Codex page uses this policy and fetches the Mac JSON API on timer wake, page switch, cold boot, and green-button refresh.

`Static` pages do not connect to Wi-Fi for timer wake. The current Meal page uses this policy. Timer wake while parked on Page 2 returns to sleep without a full ePaper refresh. Green-button refresh on Page 2 redraws the same static placeholder without calling the quota API.

Page switches always require a full ePaper refresh because the panel is still showing the previous page. Direct-left navigation to the page already being shown does not refresh.

## Mac Device API

The firmware calls:

```text
GET http://<Mac-IP>:19527/api/device/<deviceToken>
```

Response schema:

```json
{
  "schemaVersion": 1,
  "generatedAt": 1780000000,
  "plan": "PRO",
  "status": "fresh",
  "windows": [
    {
      "key": "five_hour",
      "title": "5 HOUR",
      "remainingPercent": 73,
      "resetsAt": 1780003600,
      "resetText": "Jun 23 21:40"
    }
  ]
}
```

The endpoint uses an independent device token, sends `Cache-Control: no-store`, and does not return email, account ID, OAuth token, cookies, or raw RPC data. The Mac formats `resetText`; the E1002 does not do timezone conversion.

## Install PlatformIO

```bash
brew install platformio
pio --version
```

## Wi-Fi Setup Portal

The firmware stores Wi-Fi and API settings in ESP32 NVS. If no usable settings exist, or the first Wi-Fi connection fails before any valid page has been rendered, the device starts a local setup portal.

Manual setup portal entry from deep sleep:

1. Hold the left button `KEY2 / GPIO5` for about 1.2 seconds.
2. Release the left button after the `WIFI SETUP` page appears.
3. Connect a computer or phone to:

```text
SSID: Codex-E1002-Setup
Password: codex-e1002
```

Open:

```text
http://192.168.4.1
```

If the device is not sleeping, hold the left button and press `RESET`, then keep holding left until the `WIFI SETUP` page appears.

The page lets you enter:

- 2.4GHz Wi-Fi SSID.
- Wi-Fi password.
- Mac device API URL, for example `http://192.168.x.x:19527/api/device/...`.

The full API URL is never pre-filled into the HTML page. If the device already has a stored API URL, the page shows only the current host and port; leave the API URL field blank to keep the existing target. After saving, the device reboots and uses the saved NVS settings.

The setup portal is local to the E1002 AP. It is not a cloud service and does not expose the dashboard publicly. Do not use the setup portal on an untrusted public radio environment because the form is local HTTP.

## Optional Bootstrap Secrets

`include/secrets.h` is now optional. It can be used as a local bootstrap fallback while developing, but production setup should use the portal above.

Copy the example only if you want local compile-time defaults:

```bash
cp include/secrets.example.h include/secrets.h
```

`include/secrets.h` may contain:

```cpp
#pragma once

#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define QUOTA_API_URL ""
```

Do not commit `include/secrets.h`. The firmware logs only the API host and port, not the full URL or token. It never prints the Wi-Fi password.

The E1002 needs 2.4 GHz Wi-Fi. If the SSID is 5 GHz only, guest-only, or isolated from the Mac, the device will not reach the API.

## Build

```bash
scripts/build.sh
```

Host-only logic tests:

```bash
test/run_host_tests.sh
```

## Flash

Use a USB-C data cable, set the E1002 power switch to ON, and remove the MicroSD card while debugging.

```bash
scripts/flash.sh
```

The script auto-detects one USB serial port. If multiple ports are present it stops and prints the list. Upload speed is fixed at 115200 baud. If upload fails, first confirm 115200 baud, wake the device with RESET or the green button, and avoid changing the board model or display pins.

## Serial Log

```bash
scripts/monitor.sh
```

Serial runs at 115200 baud over the reTerminal carrier UART:

```cpp
Serial1.begin(115200, SERIAL_8N1, 44, 43);
```

Logs include firmware version, wake reason, setup source, Wi-Fi result, Mac API host and port, HTTP status, schemaVersion, quota percentages, refresh decision, deep sleep entry, and next wake interval.

## Manual Refresh

The right-side green button is GPIO3 / KEY0, active LOW. It is configured as an EXT1 deep-sleep wake source. Button wake forces a screen refresh even when the display hash has not changed. On Page 1 it fetches the Mac API before drawing. On Page 2 it redraws the static placeholder and does not connect to Wi-Fi.

## Deep Sleep

After each cycle the firmware:

1. Disconnects HTTP and Wi-Fi.
2. Waits for KEY0, KEY1, and KEY2 to be released.
3. Enables 5 minute timer wake.
4. Enables GPIO3, GPIO4, and GPIO5 active LOW wake with EXT1 `ANY_LOW`.
5. Starts deep sleep.

If a button remains LOW for the release timeout, the firmware logs a warning and uses timer-only sleep for that cycle to avoid repeated immediate wakeups.

The ePaper keeps the last image without power. If network/API fails after a valid page was displayed, the firmware keeps the old image and sleeps again. If no valid page has ever been displayed, it renders one `SETUP ERROR` page without showing tokens or protected URLs.

If no usable Wi-Fi/API settings exist, or first Wi-Fi connection fails before any valid page exists, the firmware renders the `WIFI SETUP` page and starts the setup portal instead of repeatedly sleeping with a blank configuration.

## Adding Page 3

Add the renderer and static page payload hash, then add one entry to the page registry in `src/page_manager.cpp`:

```cpp
static constexpr PageDescriptor kPages[] = {
  {PageId::CodexQuota, 1, "CodexQuota", RefreshPolicy::PeriodicData},
  {PageId::TodayMeal, 2, "TodayMeal", RefreshPolicy::Static},
  {PageId::ThirdPage, 3, "ThirdPage", RefreshPolicy::Static},
};
```

Then extend `PageId`, `pageIdName()`, `mealPlaceholderHash()` or the new page hash helper, and `PageManager::renderCurrentPage()`. Do not modify `InputManager` for the new page; left-button N-click direct navigation and middle-button next-page looping use the registry count.

Page modules should render only their page content and should not read buttons, connect Wi-Fi, mutate page selection, or enter deep sleep.

Next stage plan: replace the Page 2 placeholder renderer with a "read today's meal image from SD cache" renderer. This firmware version does not implement SD access.

## LAN Checks

The Mac IP should be stable. Set a DHCP Reservation for the Mac mini, or update the stored API URL through the setup portal whenever the Mac IP changes.

From a phone on the same Wi-Fi, open:

```text
http://<Mac-IP>:19527/api/device/<deviceToken>
```

Expected result is JSON, not HTML. If it fails, check AP Isolation, Guest Wi-Fi, VLAN/firewall rules, macOS firewall prompts for Node, and whether E1002 and Mac are on the same reachable LAN.

## Why Remove MicroSD While Debugging

The reTerminal E series examples share hardware resources between ePaper and SD. This firmware does not use SD. Removing the card keeps first bring-up focused on USB upload, UART logging, Wi-Fi, and display refresh.

## Restore SenseCraft HMI

To restore the official SenseCraft HMI flow:

1. Download the official Seeed reTerminal E1002/SenseCraft HMI firmware package from Seeed's documentation.
2. Put the device in the official flashing mode described by Seeed.
3. Flash the factory firmware with Seeed's recovery tool or documented `esptool` command.
4. Reboot the E1002.
5. Deploy a SenseCraft HMI page again.

Keep this firmware project and the Mac SSR page separate. Restoring SenseCraft does not require deleting the Mac dashboard service.
