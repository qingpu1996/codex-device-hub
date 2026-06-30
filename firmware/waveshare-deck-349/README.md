# Waveshare Codex Deck 3.49 Firmware

目标硬件是 Waveshare `ESP32-S3-Touch-LCD-3.49` 系列：

- `ESP32-S3-Touch-LCD-3.49`
- `ESP32-S3-Touch-LCD-3.49-EN`
- `ESP32-S3-Touch-LCD-3.49B`
- `ESP32-S3-Touch-LCD-3.49B-EN`

当前固件状态是 Stage F：在已验证的屏幕、触控、Wi-Fi、`/slots` 链路、设备自助配置门户、slot 选择、WAV 封装和上传到 Mac Deck Hub 基础上，新增本地 STT job、TRANSCRIPT 确认页、用户确认后的 `/codex/send` 和 CODEX REPLY 显示。设备主界面不再显示 `SEND TEST`；服务端仍保留 text-only debug API 作为回归测试入口。录音改为点按式：点击 `TAP TO RECORD` 开始，再点击 `TAP TO STOP` 结束，避免长按误断触。第一次启动或配置失败时，设备会自己发出 Wi-Fi AP，Mac 连接后在浏览器填写家庭 Wi-Fi、Deck Hub Base URL 和 Deck token。配置保存到 ESP32 NVS，不再需要把 Wi-Fi 密码或 token 编译进固件。

## Official Baseline

本目录以 Waveshare 官方资料为基准，不猜引脚，不混用 V1/V2：

- 官方文档：<https://docs.waveshare.com/ESP32-S3-Touch-LCD-3.49>
- 官方 Arduino 开发页：<https://docs.waveshare.com/ESP32-S3-Touch-LCD-3.49/Development-Environment-Setup-Arduino>
- 官方 V2 示例仓库：<https://github.com/waveshareteam/ESP32-S3-Touch-LCD-3.49-V2>
- 已采用的官方显示/触控示例：`Arduino/examples/10_LVGL_V9_Test`
- 已采用的官方音频示例：`Arduino/examples/08_Audio_Test`

本仓库当前默认：

```text
DECK_HARDWARE_VARIANT=2
LVGL=9.3.0
Screen=172 x 640
LCD_TE=GPIO21
LCD_RESET=TCA9554 IO expander
Audio board=S3_LCD_3_49
Audio input codec=ES7210
Audio output codec=ES8311
Audio I2S=TDM
Audio sample=24000 Hz / 16-bit / 2ch
Audio I2C sda=47 scl=48
Audio I2S mclk=7 bclk=15 ws=46 din=6 dout=45
```

如果实物不是 V2，不要只改一个 GPIO 宏继续烧录；应改用 Waveshare 官方 V1 示例包重新移植。

## Stage F Boundary

允许：

- LCD/QSPI 初始化。
- TCA9554 背光和 reset 初始化。
- I2C 触控读取。
- LVGL v9 slot list UI 和坐标回显。
- Wi-Fi STA 连接。
- AP 配置门户：`CodexDeck-Setup`。
- NVS 保存 Wi-Fi、Deck Hub Base URL 和 Deck token。
- 只读请求 `GET /api/deck/<deckToken>/health`。
- 只读请求 `GET /api/deck/<deckToken>/slots`。
- 每 30 秒刷新 slot list。
- 触摸选择固定 slot。
- 设备主界面不显示 `SEND TEST`；`POST /api/deck/<deckToken>/debug/text` 仅保留给脚本和服务端回归测试。
- `GET /api/deck/<deckToken>/jobs/:jobId`。
- 每 3 秒轮询 active job。
- 固定英文 UI 文案继续使用 LVGL 内置 Montserrat 字体。
- TRANSCRIPT 和 CODEX REPLY 页面使用自定义 `codex_deck_cjk_16` 中文字体。
- 中文字体已通过实机验证；正常启动不再显示字体测试页。
- `TAP TO RECORD` 开始录音，`TAP TO STOP` 停止录音。
- 录音格式：PCM WAV，24kHz，16-bit，2ch，最长 15 秒，最短 300ms。
- `POST /api/deck/<deckToken>/audio/utterance?slotId=<slotId>`。
- `POST /api/deck/<deckToken>/audio/:audioJobId/transcribe`。
- `POST /api/deck/<deckToken>/codex/send`。
- STT job 轮询：`GET /api/deck/<deckToken>/jobs/:sttJobId`。
- Codex job 轮询：`GET /api/deck/<deckToken>/jobs/:codexJobId`。
- 用户必须在 TRANSCRIPT 页面点击 `SEND`，转写结果不会自动发给 Codex。
- 串口输出录音统计：duration、bytes、peak、RMS、clipping、silence hint。

禁止：

- TTS。
- ChatGPT / ChatKit / OpenAI API。
- 云端转写。
- 未经用户确认自动发送 transcript。
- 扬声器播放。
- E1002 固件或正式 LaunchAgent 改动。

当前已用 Mac 私有 venv 中的 `mlx-whisper-python` 跑通本地 STT。Mac 未检测到可用本地 STT provider 时，小屏会显示 `STT UNAVAILABLE`，这不是固件错误；需要先安装或配置 `mlx-whisper`、`whisper.cpp` 或 generic `whisper`。

## Files

核心入口：

```text
platformio.ini
include/lv_conf.h
src/main.cpp
src/app_config.h
src/user_config.h
src/deck_audio.cpp
src/deck_settings.h
src/deck_client.cpp
src/deck_provisioning.cpp
src/board/board_config.h
src/board/lvgl_port.c
src/ui/deck_ui.c
```

官方 V2 移植组件：

```text
src/axs15231b/
src/tca9554/
src/touch/
src/lcd_bl_bsp/
src/board/i2c_bsp.c
src/codec_board/
src/esp_codec_dev/
```

本地脚本：

```text
scripts/build.sh
scripts/flash.sh
scripts/monitor.sh
scripts/clean.sh
scripts/serial-port.sh
scripts/test-audio-contract.sh
```

`include/secrets.h` 已不再参与 Stage F 固件配置；如果本地还存在，它仍保持 ignored，只是上一阶段遗留文件。

## CJK Font

中文显示使用从 LVGL 9.3.0 包内 Source Han Sans SC 生成的自定义字体：

```text
src/fonts/codex_deck_cjk_16.c
```

生成命令：

```bash
cd firmware/waveshare-deck-349
scripts/generate-cjk-font.sh
```

来源：当前 PlatformIO `lvgl@9.3.0` 包内的 `SourceHanSansSC-Normal.otf`。许可证随 LVGL 包中的 Source Han Sans SC font license，为 SIL Open Font License 1.1。仓库提交的是生成后的 LVGL C 字体文件，没有提交原始 OTF，也没有使用 macOS 系统字体。

覆盖范围：ASCII `0x20-0x7E`、Latin-1 `0x00A0-0x00FF`、General Punctuation `0x2000-0x206F`、CJK 标点 `0x3000-0x303F`、全角 ASCII/标点 `0xFF00-0xFFEF`、CJK Unified Ideographs 基本区 `0x4E00-0x9FA5`。字号 16px，1bpp，不含 kerning。该范围覆盖测试句中的 `弗/斯/项/检/按/键/逻/辑/语/转/确/认/发/给`，也覆盖模型回复里常见的弯引号 `“”`、破折号 `—`、省略号 `…` 和绝大多数常见简体中文 transcript/reply。

## AP Setup

第一次启动或配置失败时，屏幕会显示：

```text
SETUP AP
CodexDeck-Setup
http://192.168.4.1
```

在 Mac 上连接设备 AP：

```text
SSID: CodexDeck-Setup
Password: codex-deck
URL: http://192.168.4.1
```

网页需要填写：

```text
Wi-Fi SSID
Wi-Fi Password
Deck Hub Base URL, e.g. http://192.168.5.156:19600
Deck Token, 64 hex chars
```

Deck token 来自 Mac 私有文件：

```text
~/Library/Application Support/CodexQuotaDashboard/deck/config.json
```

网页不会回显 token；保存后设备会重启。设备重启后会连接家庭 Wi-Fi，读取 `/health` 和 `/slots`。

如果需要重新配置，可以让设备在启动时连不上 Wi-Fi 或 Deck Hub，再由它自动进入 AP 配置门户；也可以在门户里点 `Clear Saved Settings` 清掉 NVS。

## Build

```bash
cd firmware/waveshare-deck-349
scripts/build.sh
```

当前 Stage F 验证结果：

```text
RAM:   126512 / 327680 bytes, 38.6%
Flash: 2221959 / 3145728 bytes, 70.6%
firmware.bin: 2222368 bytes
```

全量基本区自定义 CJK 字体会显著增加 Flash，但仍在当前 app 分区内。相比上一版 LVGL 内置 CJK 方案，Flash 增加约 `537000 bytes`，换来 CJK 基本区 `0x4E00-0x9FA5` 和常见通用标点覆盖；本轮补入 `0x00A0-0x00FF`、`0x2000-0x206F` 后额外增加约 `2.5KB` Flash。

构建使用 Seeed PlatformIO 平台包，因为普通 `espressif32@6.12.0` 的 Arduino/ESP-IDF 组合缺少官方 V2 示例需要的新 LCD/I2C API。`platformio.ini` 使用本目录私有 `packages_dir = .pio/packages`，避免污染仓库其他固件。

## Flash

```bash
cd firmware/waveshare-deck-349
scripts/flash.sh
```

当前实测串口：

```text
/dev/cu.usbmodem21101
```

## Monitor

```bash
cd firmware/waveshare-deck-349
scripts/monitor.sh
```

AP 配置模式预期日志：

```text
[codex_deck] firmware=0.6.0-stage-f-stt-codex
[codex_deck] stage=F stt_codex_ready
[codex_deck] starting setup portal reason=missing config
[deck_setup] setup ap ssid=CodexDeck-Setup started=yes ip=192.168.4.1
```

正常联网模式预期日志：

```text
[codex_deck] wifi connected ip=<device-ip> rssi=<rssi>
[codex_deck] deck slots updated count=5 codex=connected storage=ok
```

Text debug job 预期日志，仅适用于服务端 API 或脚本回归，不再由设备主界面触发：

```text
[codex_deck] selected slot index=0 id=general
[codex_deck] deck job submitted slot=general job=job_<24 hex> status=running
[codex_deck] deck job poll job=job_<24 hex> status=done
```

Audio upload 预期日志：

```text
[deck_audio] record start free_heap=<bytes> free_psram=<bytes>
[deck_audio] record stop duration_ms=<ms> pcm=<bytes> wav=<bytes> peak=<n> rms=<n> clipped=<n> silence=<0|1> max=<0|1>
[codex_deck] audio upload start slot=<slot> wav=<bytes> duration_ms=<ms> peak=<n> rms=<n> clipped=<n> silence=<0|1>
[codex_deck] audio upload ok job=audio_job_<24 hex> bytes=<bytes> duration_ms=<ms> sample_rate=24000 channels=2 bits=16
[codex_deck] stt job submitted audio=audio_job_<24 hex> stt=stt_job_<24 hex> status=running
[codex_deck] stt poll job=stt_job_<24 hex> status=done transcript_len=<bytes>
[codex_deck] codex job submitted slot=<slot> job=codex_job_<24 hex> source_audio=audio_job_<24 hex> source_stt=stt_job_<24 hex>
[codex_deck] codex poll job=codex_job_<24 hex> status=done reply_len=<bytes>
```

触摸时串口会输出类似：

```text
Touch: touch x=<0..171> y=<0..639> raw_x=<...> raw_y=<...> points=<...>
```

## Deck Hub Test Server

Stage F 固件请求：

```text
GET /api/deck/<deckToken>/health
GET /api/deck/<deckToken>/slots
POST /api/deck/<deckToken>/debug/text
GET /api/deck/<deckToken>/jobs/:jobId
POST /api/deck/<deckToken>/audio/utterance?slotId=<slotId>
POST /api/deck/<deckToken>/audio/:audioJobId/transcribe
POST /api/deck/<deckToken>/codex/send
```

临时测试服务：

```bash
cd service/dashboard
DECK_DEV_HOST=192.168.5.156 DECK_DEV_PORT=19600 npm run dev
```

这只用于开发测试，不安装或修改正式 LaunchAgent。

## Confirmation Gate

Stage F flash 后确认：

- C1 屏幕显示 `SETUP AP`、`CodexDeck-Setup`、`192.168.4.1`。
- C2 Mac 可以连接 `CodexDeck-Setup`。
- C3 浏览器打开 `http://192.168.4.1` 能看到配置表单。
- C4 保存配置后设备重启。
- C5 启动临时 Deck Hub 后，屏幕显示 5 个 slot。
- C6 串口出现 `deck slots updated count=5`。
- D1 点击任意 slot 后屏幕底部显示 `SEL <slot title>`。
- D2 主界面不再显示 `SEND TEST`。
- D3 服务端 `/debug/text` API 仍可用于 text-only 回归测试。
- D4 完成后 slot summary 刷新。
- E1 屏幕底部显示 `TAP TO RECORD`，无中文方框。
- E2 点击 `TAP TO RECORD` 后屏幕显示 `RECORDING`，按钮变为 `TAP TO STOP`，footer 显示 `REC <ms> P<peak> R<rms>`。
- E3 点击 `TAP TO STOP` 后屏幕显示 `UPLOADING`，随后显示 `AUDIO RECEIVED` 或明确失败信息。
- E4 串口出现 `record stop` 和 `audio upload ok`，并包含 duration/bytes/peak/RMS/clipping/silence 摘要。
- E5 Mac 本地 `deck/audio/` 下出现 `<audioJobId>.wav` 和 `<audioJobId>.json`。
- F1 中文 transcript/reply 不是整段方框，字号可读。
- F2 录音上传后显示 `TRANSCRIBING`。
- F3 如果 Mac 未配置本地 STT provider，显示 `STT UNAVAILABLE`。
- F4 配置本地 STT provider 后，显示 `TRANSCRIPT`，且中文基本可读。
- F5 点击 `BACK` 或 `RETRY` 不会发送 Codex。
- F6 点击 `SEND` 后显示 `CODEX RUNNING`，完成后显示 `CODEX REPLY`。
- F7 `/debug/text` 仍可用于服务端 text-only debug 回归，但不再出现在设备主界面。

已确认：

- 真机屏幕显示 `AUDIO RECEIVED`。
- Mac 侧已保存 `audio_job_fd5b2721ae71b01db04520d3.wav/json`。
- 保存的 WAV 被 macOS 识别为 PCM / 24kHz / 16-bit / stereo，时长约 2.005s。
- `deck-audio-play.sh` 可正常调用系统播放器。

当前已知限制：Mac 私有 `stt.json` 已切到 `small`，中文准确率明显好于 `base`，但仍可能出现少量同音误差。TTS、实时语音和唤醒词仍未实现。

## Rollback

回滚 Stage F 固件改动：

```bash
git restore --staged firmware/waveshare-deck-349
git restore firmware/waveshare-deck-349
```

如果设备需要回到官方示例，可直接在官方 V2 仓库重新烧录 `Arduino/examples/10_LVGL_V9_Test`。如果实物确认是 V1，改用官方 V1 示例包。
