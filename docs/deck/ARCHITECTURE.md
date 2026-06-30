# Codex Deck Architecture

Codex Deck 是本仓库里的第二类设备端。E1002 继续负责低频常显页面，Waveshare ESP32-S3-Touch-LCD-3.49 后续负责触控、语音、Codex 槽位选择和任务派发。

当前阶段实现 Mac 服务端 text-only 闭环、WAV 上传保存闭环，以及 Stage F 的本地 STT + transcript 确认 + Codex send 闭环：

```text
Service/API regression only
  -> /api/deck/<deckToken>/debug/text
  -> service/dashboard
  -> shared codex app-server --stdio
  -> Codex thread per slot
  -> /api/deck/<deckToken>/jobs/:jobId

Waveshare Deck firmware
  -> /api/deck/<deckToken>/audio/utterance
  -> service/dashboard
  -> ~/Library/Application Support/CodexQuotaDashboard/deck/audio/

Mac service
  -> /api/deck/<deckToken>/audio/:audioJobId/transcribe
  -> DeckSpeechClient adapter
  -> stt_job_<24 hex>
  -> /api/deck/<deckToken>/jobs/:sttJobId
  -> Waveshare TRANSCRIPT confirm page
  -> /api/deck/<deckToken>/codex/send
  -> codex_job_<24 hex>
  -> /api/deck/<deckToken>/jobs/:codexJobId
  -> Waveshare CODEX REPLY page
```

## Why Same Monorepo

Deck 和 E1002 都依赖同一台 Mac 上的本地设备 hub：

- 它们共享同一个 Codex CLI 登录状态。
- 它们共享同一个 LAN-only HTTP 服务和本机私有配置目录。
- 它们都不能把 token、Codex auth 或设备 URL 提交到 Git。
- E1002 的 quota、meal、weather 能力仍由 `service/dashboard/` 提供；Deck 只是新增 `/api/deck/...` 模块。

把 Deck 放在同一 monorepo，可以让 Mac hub、E1002 固件、Deck 固件和协议文档一起演进，避免出现两个重复的 Codex 后端或两套互相漂移的设备协议。

## Why One Mac Hub Service

Mac 上只运行一个 `service/dashboard` 进程：

- 继续提供 `GET /healthz`。
- 继续提供 E1002 的 `/api/device/<deviceToken>`、meal、weather API。
- 继续提供 `/admin/<adminToken>/config`。
- 新增 Deck 的 `/api/deck/<deckToken>/...` API。
- 复用同一个长期存活的 `codex app-server --stdio` 子进程。

Deck 不直接暴露 Codex App Server 到局域网。设备只和 `service/dashboard` 通信，后端再通过本地 stdio JSON-RPC 调用 Codex。

## Codex Integration

本阶段的 Codex job 仍只使用 text-only dispatch，不使用：

- OpenAI API。
- ChatKit。
- ChatGPT 网页自动化。
- 公网服务。
- Cloudflare。

Deck 复用当前 Mac 上已经登录的 Codex CLI。服务端 text-only debug job 和正式 `/codex/send` job 都通过 `codex app-server --stdio` 调用：

- `thread/start`
- `thread/resume`
- `turn/start`

同一个 Node.js 进程内只维护一个 app-server 子进程。quota 同步、Deck text-only debug 和正式 voice send 共享这个子进程。

## Why One Thread Per Slot

每个固定 slot 持有一个 `activeThreadId`：

- `general` 适合短问答，避免污染项目线程。
- `sisyphus` 用于项目开发上下文。
- `sisyphus-review` 用于 PR review / QA 上下文。
- `e1002` 用于 dashboard、食谱、天气和彩墨屏相关上下文。
- `deck` 用于 Deck Hub 和 Waveshare 设备本身。

同一 slot 的第二次任务复用已有 thread，让后续问题能继承该 slot 的上下文。不同 slot 默认使用不同 thread，避免轻量问答和项目任务混在一起。

第一版不提供 NEW THREAD，也不删除 thread。后续如果需要新建或归档 thread，应先设计明确的设备端交互和安全确认。

## Stage F Voice Flow

Stage F 数据流：

```text
Waveshare mic
  -> PCM WAV
  -> Mac audio store
  -> local STT provider
  -> transcript metadata
  -> Waveshare TRANSCRIPT page
  -> user taps SEND
  -> Codex slot dispatch
  -> screenReply
```

关键约束：

- 音频仍然只上传到 Mac 私有目录，不上传云端。
- STT provider 只做本地 adapter；默认自动检测 `mlx-whisper`、`whisper.cpp` 和 generic `whisper`。
- 如果本机没有 provider，`stt_job` 失败为 `STT UNAVAILABLE`，服务不崩溃。
- Transcript 不会自动发送给 Codex，必须由用户在小屏点击 `SEND`。
- `debug/text` 保留作 text-only 回归测试，正式语音任务走 `/codex/send`。
- TTS、实时语音、唤醒词、OpenAI API、ChatKit 和 ChatGPT 网页自动化仍不在范围内。

## Firmware Path

`firmware/waveshare-deck-349/` 当前基于 Waveshare 官方 V2 `Arduino/examples/10_LVGL_V9_Test` 移植显示/触控，并基于 `Arduino/examples/08_Audio_Test` 接入 ES7210/ES8311 codec。已验证 LCD、触控、背光、Wi-Fi、`/slots` 链路、slot 选择、点按式录音、WAV 上传、STT/Codex job polling 和固件构建。Stage F 固件使用从 LVGL 包内 Source Han Sans SC 生成的 `codex_deck_cjk_16`，覆盖 ASCII、Latin-1、General Punctuation、CJK 标点、全角标点和 CJK 基本区 `0x4E00-0x9FA5`，用于 TRANSCRIPT 和 CODEX REPLY 页面显示常用简体中文。

Stage F 固件不再把 Wi-Fi 或 Deck token 编译进 `secrets.h`。设备首次启动或配置失败时会发出 `CodexDeck-Setup` AP，Mac 连接后在 `http://192.168.4.1` 填写家庭 Wi-Fi、Deck Hub Base URL 和 Deck token；配置保存在 ESP32 NVS。

如果实物不是 V2，不要只改 GPIO 宏继续烧录；应改用 Waveshare 官方 V1 示例包重新移植。
