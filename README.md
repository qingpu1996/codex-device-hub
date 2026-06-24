# Codex Quota E1002

这是 reTerminal E1002 的本地局域网仪表盘项目。Mac 上的服务从当前用户已经登录的 Codex CLI 会话读取额度和用量，整理成脱敏 JSON；可选模块由 Mac 继续处理食谱、天气等数据源，E1002 固件通过 Wi-Fi 获取设备协议数据，并用 Seeed_GFX 直接绘制到六色电子纸。

本仓库是当前正式 monorepo。后续服务端和固件改动都应从这里进入。

## 目录结构

```text
service/dashboard/   macOS Node.js 服务，提供设备 JSON API、食谱图片接口、天气接口和本地配置页
firmware/e1002/      PlatformIO Arduino 固件，运行在 reTerminal E1002
```

如果本机仍保留旧的独立服务目录或旧固件目录，它们只作为迁移备份，不再作为正式开发入口。

## 当前架构

```text
Codex CLI 登录状态
  -> codex app-server --stdio
  -> Mac mini 局域网 HTTP 服务
  -> E1002 Wi-Fi 客户端
  -> Seeed_GFX 原生绘制
  -> 六色电子纸
  -> deep sleep
```

E1002 不运行 HTML、CSS、JavaScript、iframe 或浏览器。Mac 服务也不再提供旧的 HTML dashboard 页面；正式接口只面向固件。

## Mac 服务

服务目录：

```bash
cd service/dashboard
```

常用命令：

```bash
npm install
npm test
scripts/install-launchd.sh
scripts/status.sh
scripts/logs.sh follow
scripts/restart.sh
```

服务由当前用户的 LaunchAgent 运行：

```text
~/Library/LaunchAgents/com.qingpu.codex-quota-dashboard.plist
```

运行配置和缓存保存在：

```text
~/Library/Application Support/CodexQuotaDashboard/config.json
~/Library/Application Support/CodexQuotaDashboard/cache.json
```

服务暴露的接口：

```text
GET /healthz
GET /api/device/<deviceToken>
GET /api/device/<deviceToken>/meal/today
GET /api/device/<deviceToken>/meal/today.raw
GET /api/device/<deviceToken>/meal/today.png
GET /api/device/<deviceToken>/weather?slot=N
GET /admin/<adminToken>/config
```

`/e1002/<token>` 和 `/api/e1002/<token>` 是已经移除的旧页面入口，当前实现会返回 404。

食谱和天气接口都是可选模块使用的后端能力。烧录纯额度固件时，E1002 不会请求这些接口。

## E1002 固件

固件目录：

```bash
cd firmware/e1002
```

常用命令：

```bash
test/run_host_tests.sh
scripts/install.sh
scripts/build.sh
scripts/flash.sh
scripts/monitor.sh
```

关键硬件配置：

- Seeed 官方 PlatformIO 平台包。
- Arduino framework。
- `BOARD_SCREEN_COMBO 521`。
- Seeed_GFX。
- OPI PSRAM。
- 上传速度 `115200`。
- 内置按键：右侧绿色键 `GPIO3`，中键 `GPIO4`，左键 `GPIO5`。

## 当前 UI

核心固件一定包含 Page 1：Codex 额度页。

- 套餐类型。
- 5 小时额度和周额度。
- `TOTAL` 总 token 用量。
- `TODAY` 今日 token 用量。
- 底部电量、按键提示和页码。

每日食谱是可选模块。启用后会增加一个今日食谱页。

- Mac 服务从 Excel 解析当天食谱。
- Mac 服务渲染 800 x 480 图片并转成 E1002 4bpp raw。
- 固件下载 raw 图片后整屏刷新。
- 中键长按切换食谱内部页，例如 `M1/4`、`M2/4`。

天气也是可选模块。启用后会增加一个天气页。

- 地点配置先由 Mac 服务本地配置页管理，默认是杭州余杭。
- 天气 API 实际使用经纬度；`locationName` 只是屏幕显示名。
- Mac 服务请求天气源，当前支持 Open-Meteo 和彩云天气 v2.6。
- 固件请求 `/weather?slot=N`，显示当前天气、今日摘要、小时/未来几天预报。
- 彩云天气增强字段会分散显示在前三个内部页；兜底源缺失的字段显示为 `--`。
- 中键长按切换天气内部页，例如 `W1/3`、`W2/3`。

页面总数由启用模块动态决定。例如只启用天气时是 Codex + Weather 两页；同时启用食谱和天气时是 Codex + Meal + Weather 三页。

## 选择性烧录

交互式选择：

```bash
cd firmware/e1002
scripts/install.sh
```

脚本会显示模块列表，空格切换可选模块，Enter 确认，最后选择只保存、构建或构建并烧录。选择会写入 ignored 的本地文件：

```text
firmware/e1002/.local/features.env
```

也可以直接临时覆盖模块开关：

```bash
cd firmware/e1002
FEATURE_MEAL=0 scripts/build.sh
FEATURE_MEAL=1 scripts/build.sh
FEATURE_MEAL=1 FEATURE_WEATHER=1 scripts/build.sh
FEATURE_MEAL=0 FEATURE_WEATHER=1 scripts/flash.sh
```

PlatformIO 只保留一个正式 env：

| Env | 功能 |
| --- | --- |
| `reterminal_e1002` | 根据 `.local/features.env` 或 `FEATURE_*` 环境变量生成当前选择的固件 |

当前可选模块：

| Feature | `0` | `1` |
| --- | --- | --- |
| `FEATURE_MEAL` | 只包含 Codex 额度页 | Codex 额度页 + 今日食谱页 |
| `FEATURE_WEATHER` | 不包含天气页 | 增加天气页 |

## 按键

| 按键 | GPIO | 短按/连按行为 |
| --- | --- | --- |
| 右侧绿色键 KEY0 | GPIO3 | 刷新当前页 |
| 中键 KEY1 | GPIO4 | 短按切换下一大页；长按切换当前模块内部页 |
| 左键 KEY2 | GPIO5 | 连按 N 次直达第 N 页；长按约 1.2 秒进入配网页面 |

三颗按键都能从 deep sleep 唤醒。默认每 5 分钟也会由定时器唤醒一次。

## 配置方式

推荐使用 E1002 自带的本地配网页面：

1. E1002 睡眠时长按左键约 1.2 秒。
2. 连接 `Codex-E1002-Setup`。
3. 打开 `http://192.168.4.1`。
4. 输入 2.4GHz Wi-Fi、Wi-Fi 密码和 Mac 设备 API URL。

`firmware/e1002/include/secrets.h` 仍可作为开发时的本地 bootstrap 文件，但它必须保持 ignored，不能提交。

天气等模块配置由 Mac 服务提供：

```bash
cd service/dashboard
scripts/status.sh
```

输出中的 `admin_config_url` 是本机局域网配置页，例如：

```text
http://<Mac-IP>:19527/admin/<adminToken>/config
```

`adminToken` 是本机私有配置，不能提交到 Git。当前配置页用于天气模块，后续新增模块也应复用这个入口，而不是把模块参数写死在固件里。彩云 token 只保存在 Mac 本机私有配置中，不会下发到 E1002。

## 隐私和公开仓库边界

本项目不会读取、复制或输出 `~/.codex/auth.json`。Codex 认证只由 `codex app-server` 处理，服务只保存脱敏后的派生数据。

不要提交：

- `service/dashboard/dist/`
- `service/dashboard/node_modules/`
- `service/dashboard/generated/`
- `service/dashboard/preview/`
- `firmware/e1002/.pio/`
- `firmware/e1002/.local/`
- `firmware/e1002/include/secrets.h`
- Wi-Fi 密码
- device token
- admin token
- 完整受保护 API URL
- 本机日志

公开前建议检查：

```bash
git status --short --ignored
git grep -nI -E 'sk-|Bearer |WIFI_PASSWORD|api/device/[A-Za-z0-9._-]{16,}|auth\.json'
```

预期只会看到示例、测试 token、空密码占位符或“不要读取 auth.json”的说明。
