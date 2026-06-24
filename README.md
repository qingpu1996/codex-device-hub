# Codex Quota E1002

LAN-only Codex quota dashboard for Seeed Studio reTerminal E1002.

This monorepo contains two parts:

```text
service/dashboard/   macOS Node.js service, JSON API, optional meal image renderer
firmware/e1002/      PlatformIO Arduino firmware for reTerminal E1002
```

The E1002 firmware does not run HTML, CSS, JavaScript, iframes, or a browser.
It fetches sanitized JSON and raw 800x480 4bpp meal images from the Mac service,
then renders through Seeed_GFX and enters deep sleep.

## Privacy Boundary

The service talks to `codex app-server --stdio` using the currently logged-in
Codex CLI session. It does not read, copy, or print `~/.codex/auth.json`.

Do not commit:

- `service/dashboard/preview/`
- `service/dashboard/dist/`
- `service/dashboard/generated/`
- `firmware/e1002/include/secrets.h`
- Wi-Fi passwords
- device tokens
- full protected URLs
- logs containing local runtime output

## Service

```bash
cd service/dashboard
npm install
npm test
scripts/install-launchd.sh
```

The service exposes:

- `GET /api/device/<deviceToken>` for native firmware JSON.
- `GET /api/device/<deviceToken>/meal/today`
- `GET /api/device/<deviceToken>/meal/today.raw`
- `GET /api/device/<deviceToken>/meal/today.png`

There is no browser page token and no HTML dashboard route. The firmware uses
the device token directly and renders the screen natively.

## Firmware

```bash
cd firmware/e1002
cp include/secrets.example.h include/secrets.h
# edit include/secrets.h locally only
scripts/build.sh
scripts/flash.sh
scripts/monitor.sh
```

Important hardware settings:

- `BOARD_SCREEN_COMBO 521`
- OPI PSRAM enabled
- Upload speed `115200`
- Three built-in buttons: GPIO3 green, GPIO4 middle, GPIO5 left

## Current UI

Page 1 is the Codex quota dashboard:

- `TOTAL` token count on the left of the plan label.
- `TODAY` token count on the right of the plan label.
- 5-hour and weekly quota windows.
- Battery in the footer.

Page 2 is the meal plan image page:

- Short middle press: next top-level page.
- Long middle press: next meal subpage.
- Green button: refresh current page.
- Left button multi-click: direct page navigation.

## Public Repo Checklist

Before pushing publicly:

```bash
git status --short --ignored
git grep -nI -E 'sk-|Bearer |WIFI_PASSWORD|api/device/[A-Za-z0-9._-]{16,}|auth\\.json'
```

The only expected secret-like tracked paths are examples and tests with placeholder data.
