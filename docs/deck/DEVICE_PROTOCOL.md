# Codex Deck Device Protocol

Deck API 由现有 `service/dashboard` 提供，路径前缀是：

```text
/api/deck/<deckToken>
```

`deckToken` 是独立随机 token，不复用 E1002 的 `deviceToken`，也不复用 admin 配置页的 `adminToken`。错误 token 一律返回 404。

## Private Storage

Deck 私有文件保存在：

```text
~/Library/Application Support/CodexQuotaDashboard/deck/config.json
~/Library/Application Support/CodexQuotaDashboard/deck/slots.json
~/Library/Application Support/CodexQuotaDashboard/deck/jobs/
~/Library/Application Support/CodexQuotaDashboard/deck/audio/
```

`deckToken` 首次使用 Deck 模块时自动生成，至少 32 字节随机值。slot、job 和 audio JSON 使用临时文件 + rename 写入。

## Health

```text
GET /api/deck/<deckToken>/health
```

响应：

```json
{
  "ok": true,
  "service": "codex-deck",
  "codex": "connected",
  "storage": "ok"
}
```

字段：

| Field | Values |
| --- | --- |
| `codex` | `connected`, `disconnected`, `unknown` |
| `storage` | `ok`, `error` |

## Slots

```text
GET /api/deck/<deckToken>/slots
GET /api/deck/<deckToken>/slots/:slotId
```

响应只返回设备需要显示的脱敏字段：

```json
[
  {
    "id": "general",
    "title": "GENERAL",
    "subtitle": "Quick questions",
    "status": "idle",
    "lastSummary": ""
  }
]
```

不存在的 `slotId` 返回 404。

Waveshare 3.49 小屏首版只依赖这些字段：

| Field | Type | Screen Use |
| --- | --- | --- |
| `id` | string | 后续选择 slot 和发起 job 的稳定标识 |
| `title` | string | slot 主标题，建议一行大写短文本 |
| `subtitle` | string | 小屏副标题，建议少于 32 个英文字符或 16 个中文字符 |
| `status` | string | `idle`、`running`、`waiting_approval`、`error` |
| `lastSummary` | string | 可为空；小屏只显示短摘要，不显示完整回复 |

当前 Waveshare Stage F 固件会在 AP 配置后请求 `/slots`，显示这些字段；点击 slot 只改变目标 slot。设备主界面不再显示 `SEND TEST`，text-only debug 任务只通过服务端 API 或脚本回归触发。录音使用点按式交互：点击 `TAP TO RECORD` 开始录音，再点击 `TAP TO STOP` 停止并把 WAV 上传到当前 slot，随后进入本地 STT 和 transcript 确认流程。

## Text Debug Dispatch

```text
POST /api/deck/<deckToken>/debug/text
Content-Type: application/json
```

请求：

```json
{
  "slotId": "general",
  "text": "用三句话解释这个 Deck 第一版应该怎么做。"
}
```

响应：

```json
{
  "jobId": "job_0123456789abcdef01234567",
  "status": "running"
}
```

验证规则：

- 缺少 `slotId` 返回 400。
- 缺少 `text` 返回 400。
- 不存在的 `slotId` 返回 404。
- `jobId` 由服务端安全随机生成，文件名不来自用户输入。
- HTTP 响应不返回完整 wrapped prompt。

## Job Polling

```text
GET /api/deck/<deckToken>/jobs/:jobId
```

响应：

```json
{
  "jobId": "job_0123456789abcdef01234567",
  "type": "codex",
  "status": "done",
  "slotId": "general",
  "screenReply": "第一版先验证 text-only 派发闭环。",
  "fullReplyAvailable": true,
  "errorMessage": null,
  "audioJobId": null,
  "transcript": "",
  "screenTranscript": "",
  "sourceAudioJobId": null,
  "sourceSttJobId": null,
  "createdAt": "2026-06-30T00:00:00.000Z",
  "updatedAt": "2026-06-30T00:00:05.000Z"
}
```

状态：

| Status | Meaning |
| --- | --- |
| `queued` | job 已创建，尚未开始 |
| `running` | 已提交给 Codex |
| `waiting_approval` | 后续需要审批交互 |
| `done` | 已完成 |
| `failed` | 已失败 |

`screenReply` 是 172 x 640 小屏用短回复：

- 中文尽量不超过 300 字。
- 英文尽量不超过 600 字符。
- 过长时截断并追加 `...`。

`fullReplyAvailable` 只表示服务端有更完整回复文件，不暴露绝对路径。

## Audio Upload

```text
POST /api/deck/<deckToken>/audio/utterance?slotId=<slotId>
Content-Type: audio/wav
```

请求 body 是 raw WAV bytes，不是 JSON。

验证规则：

- 缺少 `slotId` 返回 400。
- 不存在的 `slotId` 返回 404。
- Content-Type 不是 `audio/wav`、`audio/wave` 或 `audio/x-wav` 返回 415。
- body 超过 8MB 返回 413。
- 非 `RIFF/WAVE`、缺少 `fmt` 或 `data`、非 PCM、太短或太长返回 400。
- 时长最短 300ms，最长 25s。

成功响应：

```json
{
  "jobId": "audio_job_0123456789abcdef01234567",
  "status": "audio_received",
  "slotId": "general",
  "bytes": 96044,
  "format": {
    "container": "wav",
    "sampleRate": 24000,
    "bitsPerSample": 16,
    "channels": 2,
    "durationMs": 1000
  },
  "message": "Audio received"
}
```

查询 metadata：

```text
GET /api/deck/<deckToken>/audio/:audioJobId
```

响应不返回本机绝对路径、token 或完整 URL。

## Audio Transcription

```text
POST /api/deck/<deckToken>/audio/:audioJobId/transcribe
Content-Type: application/json
```

请求 body 可为空，也可以指定语言：

```json
{
  "language": "zh"
}
```

响应创建 STT job：

```json
{
  "jobId": "stt_job_0123456789abcdef01234567",
  "status": "running",
  "audioJobId": "audio_job_0123456789abcdef01234567",
  "slotId": "general"
}
```

然后轮询：

```text
GET /api/deck/<deckToken>/jobs/stt_job_0123456789abcdef01234567
```

完成响应：

```json
{
  "jobId": "stt_job_0123456789abcdef01234567",
  "type": "stt",
  "status": "done",
  "slotId": "general",
  "audioJobId": "audio_job_0123456789abcdef01234567",
  "transcript": "让 Codex 检查一下 PR 的按键逻辑。",
  "screenTranscript": "让 Codex 检查一下 PR 的按键逻辑。",
  "screenReply": "",
  "fullReplyAvailable": false,
  "errorMessage": null,
  "sourceAudioJobId": "audio_job_0123456789abcdef01234567",
  "sourceSttJobId": null,
  "createdAt": "2026-06-30T00:00:00.000Z",
  "updatedAt": "2026-06-30T00:00:05.000Z"
}
```

规则：

- 固件不做 STT，只上传 WAV。
- 服务端通过可插拔 `DeckSpeechClient` 处理 WAV。
- 已经转写完成的 audio job 会复用 transcript，不重复跑 STT，除非请求设置 `force: true`。
- 没有本地 provider 时，STT job 返回 `failed`，`errorMessage` 为 `STT UNAVAILABLE`。
- 响应不返回音频绝对路径、shell 命令、堆栈或 token。
- `screenTranscript` 面向 172 x 640 小屏，中文最多约 500 字。

## Codex Send

```text
POST /api/deck/<deckToken>/codex/send
Content-Type: application/json
```

请求：

```json
{
  "slotId": "general",
  "transcript": "让 Codex 检查一下 PR 的按键逻辑。",
  "sourceAudioJobId": "audio_job_0123456789abcdef01234567",
  "sourceSttJobId": "stt_job_0123456789abcdef01234567"
}
```

响应：

```json
{
  "jobId": "codex_job_0123456789abcdef01234567",
  "status": "running"
}
```

规则：

- token 错误返回 404。
- 缺少 `slotId` 返回 400。
- 不存在的 `slotId` 返回 404。
- `transcript` 缺失、空白或超过 4000 字返回 400。
- 服务端复用该 slot 的 `activeThreadId`；没有时才创建新 thread。
- `screenReply` 中文最多约 300 字，英文最多约 600 字符。
- Codex 等待人工审批时，job 状态为 `waiting_approval`。
- failed job 不返回堆栈。
- 固件必须等用户在 TRANSCRIPT 页面点击 `SEND` 后才调用本接口。

## Security Boundaries

Deck HTTP 响应不得包含：

- Codex auth。
- OAuth token。
- Cookie。
- OpenAI API key。
- GitHub token。
- `auth.json` 路径。
- 完整受保护 URL。
- 本机音频文件绝对路径。
- `deckToken`、`deviceToken` 或 `adminToken`。

日志可以记录简短错误，但必须脱敏 token 和 auth 路径。设备端只需要处理 200、400、404 和短错误文本。

## Out Of Scope For Stage F

本阶段不实现：

- TTS。
- WebSocket。
- SSE。
- 设备端自由文字输入。
- ChatGPT / ChatKit / OpenAI API 调用。

Waveshare Stage F 允许本地 STT、transcript 确认页、用户确认后的 Codex send 和 screenReply 显示；它仍不包含 TTS、实时语音、唤醒词、OpenAI API、ChatKit 或 ChatGPT 网页自动化。
