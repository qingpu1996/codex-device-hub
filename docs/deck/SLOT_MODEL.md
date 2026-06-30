# Codex Deck Slot Model

第一版固定 5 个 Codex Deck slot，不提供 NEW THREAD，不删除 thread。

## Fixed Slots

| id | title | subtitle | 用途 |
| --- | --- | --- | --- |
| `general` | GENERAL | Quick questions | 随手问、轻量讨论、非项目问题 |
| `sisyphus` | SISYPHUS | Game project | 西西弗斯项目开发任务 |
| `sisyphus-review` | SISYPHUS REVIEW | PR review / QA | PR 审查、QA、代码复核 |
| `e1002` | E1002 | E-paper dashboard | 彩墨屏、dashboard、食谱、天气相关 |
| `deck` | DECK | Touch deck | Waveshare 触控屏和 Deck Hub 本身 |

首次启用 Deck 模块时，服务端创建这些默认 slots。若 `slots.json` 已存在，服务端会保留已有 `activeThreadId`，只补齐缺失字段。

## Slot Record

内部 `slots.json` 结构：

```json
{
  "id": "sisyphus",
  "title": "SISYPHUS",
  "subtitle": "Game project",
  "activeThreadId": null,
  "lastSummary": "",
  "status": "idle",
  "createdAt": "2026-06-30T00:00:00.000Z",
  "updatedAt": "2026-06-30T00:00:00.000Z"
}
```

设备 API 不返回 `activeThreadId`。

## Slot Status

| Status | Meaning |
| --- | --- |
| `idle` | 当前 slot 没有运行 job |
| `running` | 当前 slot 有 text job 正在运行 |
| `waiting_approval` | 预留给后续审批交互 |
| `error` | 最近一次 job 失败 |

`lastSummary` 给小屏显示，中文控制在 80 字内，英文控制在 160 字符内。

## Thread Reuse

规则：

1. 同一 slot 第二次发送任务时复用 `activeThreadId`。
2. 不同 slot 默认创建不同 `activeThreadId`。
3. 若 slot 没有 `activeThreadId`，服务端调用 `thread/start`。
4. 若 slot 已有 `activeThreadId`，服务端调用 `thread/resume` 后再 `turn/start`。
5. 语音转写本身不会创建 Codex thread；只有用户在 TRANSCRIPT 页面点击 `SEND` 后才派发。
6. 如果旧 thread 无法恢复，job 失败并保留简短错误；第一版不静默创建替代 thread。

这样可以让 `sisyphus`、`sisyphus-review`、`e1002` 和 `deck` 各自保持上下文，避免不同类型任务互相污染。

## Job Record

内部 job 文件按 job id 保存。Stage F 有三类 job id：

| Prefix | Type | 用途 |
| --- | --- | --- |
| `job_` | `codex` | 旧 `debug/text` 回归测试 |
| `stt_job_` | `stt` | audio job 本地转写 |
| `codex_job_` | `codex` | 用户确认 transcript 后的正式发送 |

```json
{
  "id": "job_0123456789abcdef01234567",
  "type": "codex",
  "slotId": "general",
  "status": "queued",
  "inputText": "hello",
  "wrappedPrompt": "...",
  "screenReply": "",
  "fullReplyPath": "",
  "errorMessage": null,
  "audioJobId": null,
  "transcript": "",
  "screenTranscript": "",
  "sourceAudioJobId": null,
  "sourceSttJobId": null,
  "createdAt": "2026-06-30T00:00:00.000Z",
  "updatedAt": "2026-06-30T00:00:00.000Z"
}
```

`wrappedPrompt` 只保存在本机私有 job 文件中，不通过 HTTP 返回。`fullReplyPath` 使用相对路径，设备 API 只返回 `fullReplyAvailable`。

## Prompt Wrapping

`general` slot 使用短问答 prompt，要求：

- 先给一句结论。
- 最多 3 条要点。
- 尽量控制在 300 个中文字符以内。
- 除非用户明确要求，不执行工程操作。

项目类 slot 使用任务 prompt，包含：

- 目标 slot title。
- slot subtitle。
- 当前任务来自桌面 Codex Deck。
- 如需修改文件或运行命令，遵循 Codex 正常安全策略。
- 输出应包含适合 172 x 640 小屏显示的摘要。

HTTP 响应不返回完整 wrapped prompt。

## Debug Text vs Voice Send

`POST /debug/text` 只用于固件和服务端回归测试：

- 设备主界面不再显示 `SEND TEST`。
- 可由服务端测试、脚本或手动 HTTP 请求触发。
- 请求固定 text-only debug prompt。
- 返回 `job_<24 hex>`。

正式语音任务使用 Stage F 流程：

- 点击 `TAP TO RECORD` 开始录音，再点击 `TAP TO STOP` 上传 WAV。
- `/audio/:audioJobId/transcribe` 创建 `stt_job_<24 hex>`。
- 小屏显示 TRANSCRIPT。
- 用户点击 `SEND` 后调用 `/codex/send`。
- `/codex/send` 创建 `codex_job_<24 hex>`。

这两个路径都复用 slot 的 `activeThreadId`，但只有正式 send 使用用户确认后的 transcript。

## Persistence

`slots.json` 和 job JSON 都使用临时文件 + rename 写入，避免写坏文件。job 文件名只来自服务端随机 `jobId`，不来自用户输入。
