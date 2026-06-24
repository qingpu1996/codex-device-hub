# codex-quota-dashboard

这是运行在 Mac 上的局域网服务，给 reTerminal E1002 固件提供 Codex 额度 JSON、token 用量摘要、今日食谱图片和天气 JSON。服务不提供 HTML dashboard，不提供 iframe 页面，也不需要公网入口。

## 职责

- 长期运行 `codex app-server --stdio`。
- 读取当前 Codex CLI 登录会话的账户、额度和用量信息。
- 将数据归一化成脱敏 JSON。
- 从本地 Excel 生成今日食谱图片。
- 按本机配置请求天气源，并把结果整理成适合 E1002 的小 JSON。
- 提供带独立 `adminToken` 的本地模块配置页。
- 只在局域网 IPv4 上提供 E1002 固件接口。
- 失败时保留最近一次成功缓存。

## 架构

```text
Codex CLI 登录状态
  -> codex app-server --stdio
  -> Node.js LaunchAgent
  -> /api/device/<deviceToken>
  -> /api/device/<deviceToken>/weather
  -> E1002 固件
```

服务调用的 Codex RPC：

- `initialize`
- `initialized`
- `account/read`
- `account/rateLimits/read`
- `account/usage/read`

HTTP 请求只读取内存缓存，不会在每次请求时重新启动 Codex App Server。

## 安装和运行

```bash
cd service/dashboard
scripts/install-launchd.sh
```

安装脚本会：

- 探测 `codex`、`node`、`npm`。
- 探测默认网络接口、局域网 IPv4 和 MAC 地址。
- 执行 `npm install`。
- 执行 TypeScript 构建。
- 创建或更新私有配置。
- 写入并启动当前用户的 LaunchAgent。
- 等待 `/healthz` 返回成功。
- 打印设备 API URL。
- 打印本地模块配置页 URL。

LaunchAgent：

```text
~/Library/LaunchAgents/com.qingpu.codex-quota-dashboard.plist
```

配置和缓存：

```text
~/Library/Application Support/CodexQuotaDashboard/config.json
~/Library/Application Support/CodexQuotaDashboard/cache.json
```

日志：

```text
~/Library/Logs/CodexQuotaDashboard/stdout.log
~/Library/Logs/CodexQuotaDashboard/stderr.log
```

## 常用命令

```bash
scripts/status.sh
scripts/logs.sh
scripts/logs.sh follow
scripts/restart.sh
scripts/update-lan-ip.sh
scripts/regenerate-device-token.sh
scripts/uninstall-launchd.sh
```

`uninstall-launchd.sh` 只卸载 LaunchAgent，不删除配置和缓存。

## 本地配置页

配置页入口：

```text
GET http://<Mac-IP>:19527/admin/<adminToken>/config
```

`adminToken` 和 `deviceToken` 是两套独立随机值，都保存在：

```text
~/Library/Application Support/CodexQuotaDashboard/config.json
```

当前配置页用于天气模块：

- 是否启用服务端天气数据。
- 天气源：`open-meteo` 或 `caiyun-v2.6`。
- 彩云天气 token，输入框留空会保留旧 token，勾选清除才会删除。
- 地点名称，默认 `Hangzhou Yuhang`。
- 纬度、经度，默认约为杭州余杭。
- 时区，默认 `Asia/Shanghai`。

天气接口实际使用经纬度。`locationName` 只用于 E1002 屏幕显示，不参与天气源定位。详细地址自动解析经纬度需要另接地理编码服务，例如高德或腾讯地图，本阶段还没有启用。

配置页只在局域网服务上开放，不需要公网。不要把带 `adminToken` 的完整 URL 提交到 Git、日志或公开文档。彩云 token 只保存在 Mac 本机私有配置中，不会下发到 E1002，也不会在配置页回显。

## 设备 API

主接口：

```text
GET http://<Mac-IP>:19527/api/device/<deviceToken>
```

响应示例：

```json
{
  "schemaVersion": 1,
  "generatedAt": 1780000000,
  "plan": "PRO",
  "status": "fresh",
  "usage": {
    "totalTokensText": "1.4B",
    "todayTokensText": "3.62M"
  },
  "windows": [
    {
      "key": "five_hour",
      "title": "5 HOUR",
      "remainingPercent": 73,
      "resetsAt": 1780003600,
      "resetText": "Jun 23 21:40"
    },
    {
      "key": "weekly",
      "title": "WEEK",
      "remainingPercent": 48,
      "resetsAt": 1780520000,
      "resetText": "Jun 29 08:00"
    }
  ]
}
```

规则：

- `deviceToken` 是独立随机值，保存在本机配置中。
- 错误 token 返回 404。
- 响应带 `Cache-Control: no-store`。
- `remainingPercent` 是 0 到 100 的整数。
- `windows` 最多返回两个，优先 5 小时和周额度。
- `resetText` 由 Mac 按本机时区预格式化。
- 不返回邮箱、账户 ID、OAuth token、Cookie、device token 或原始 RPC。

旧入口已经移除：

```text
GET /e1002/<token>       -> 404
GET /api/e1002/<token>   -> 404
```

## 天气模块 API

天气接口与额度接口共用 `deviceToken`：

```text
GET /api/device/<deviceToken>/weather?slot=1
GET /api/device/<deviceToken>/weather?slot=2
GET /api/device/<deviceToken>/weather?slot=3
```

响应固定为小 JSON，最大 8KB：

```json
{
  "schemaVersion": 1,
  "generatedAt": 1780000000,
  "status": "fresh",
  "source": "caiyun-v2.6",
  "location": "Hangzhou Yuhang",
  "timezone": "Asia/Shanghai",
  "slot": 1,
  "slotCount": 3,
  "current": {
    "tempC": 30,
    "feelsLikeC": 34,
    "humidityPercent": 70,
    "condition": "RAIN",
    "icon": "RAIN",
    "weatherCode": null,
    "windKph": 12,
    "windDirectionDeg": 90,
    "windText": "E",
    "pressureHpa": 1008,
    "precipMm": 0.8,
    "pm25": 18,
    "pm10": 35,
    "uvIndex": 3.2
  },
  "today": {
    "highC": 33,
    "lowC": 25,
    "precipProbPercent": 80,
    "precipMm": 12.5,
    "sunriseText": "04:59",
    "sunsetText": "19:04",
    "uvIndexMax": 7.1
  },
  "details": {
    "aqiChn": 46,
    "visibilityKm": 18.6,
    "cloudPercent": 82,
    "localRainIntensity": 0.8,
    "nearestRainDistanceKm": 2.4,
    "nearestRainIntensity": 0.2,
    "comfortIndex": 4,
    "dressingIndex": 3,
    "coldRiskIndex": 2
  },
  "hourly": [],
  "daily": []
}
```

规则：

- 错误 `deviceToken` 返回 404。
- 响应带 `Cache-Control: no-store`。
- `schemaVersion` 当前为 1。
- `slotCount` 当前为 3，对应固件内部天气页 `W1/3`、`W2/3`、`W3/3`。
- `details` 是增强天气字段；固件会把这些字段分散显示在前三个内部页。Open-Meteo 等兜底源缺失的字段返回 `null`，设备端显示为 `--`。
- `status` 允许 `fresh`、`cached`、`stale`、`not_configured`。
- 不返回任何 Codex 认证数据、Wi-Fi 密码、device token 或 admin token。

当前天气源支持：

- Open-Meteo：不需要 key，覆盖 forecast 和 air quality，适合先跑通。
- 彩云天气 v2.6：需要 token，服务端调用综合接口，一次拉取实况、小时、天级、空气质量、能见度、云量、附近降水和生活指数等数据。

后续可选：

- 和风天气 QWeather：大陆天气、分钟降水、生活指数等能力完整，可作为另一套 provider。
- 高德天气：接入简单，但字段较少，更适合作为轻量 fallback 或地理编码来源。

## 可选食谱模块

服务端保留食谱图片 API，但它只是后端能力。只有固件以 `FEATURE_MEAL=1` 构建时，E1002 才会请求 `/meal/...`。

如果固件以 `FEATURE_MEAL=0` 构建：

- 不需要准备 Excel。
- 不需要挂载 NAS 食谱目录。
- 不会请求 `/api/device/<deviceToken>/meal/today`。
- 服务端仍可正常运行额度 API。

## 可选天气模块

服务端天气接口是后端能力。只有固件以 `FEATURE_WEATHER=1` 构建，并且用户切到天气页时，E1002 才会请求 `/weather?slot=N`。

如果固件以 `FEATURE_WEATHER=0` 构建：

- 不会请求天气源。
- 不会请求 `/api/device/<deviceToken>/weather`。
- 配置页里的天气设置可以保留，后续重新烧录天气模块时继续使用。

## 食谱图片 API

食谱接口与额度接口共用同一个 `deviceToken`：

```text
GET /api/device/<deviceToken>/meal/today?slot=1
GET /api/device/<deviceToken>/meal/today.raw?slot=1
GET /api/device/<deviceToken>/meal/today.png?slot=1
```

- `meal/today` 返回图片元数据，最大 2KB。
- `meal/today.raw` 返回 E1002 固件使用的 800 x 480 4bpp 原始图像，大小固定 192000 字节。
- `meal/today.png` 是调试预览用 PNG。

`meal/today.raw` 的 `Content-Type` 是：

```text
application/vnd.codex.e1002-4bpp
```

## 食谱 Excel

默认路径：

```text
~/Documents/codex-quota-dashboard/meal-plan.xlsx
```

可用环境变量覆盖：

```bash
CODEX_MEAL_EXCEL_PATH=/path/to/meal-plan.xlsx scripts/restart.sh
```

Excel 需要包含工作表：

- `一周食谱`
- `每日汇总`

`一周食谱` 使用的列：

- `星期`
- `餐次`
- `餐名`
- `食材/份量`
- `做法/备注`
- `热量`
- `蛋白质`
- `碳水`
- `脂肪`

`每日汇总` 使用的列：

- `星期`
- `热量`
- `蛋白质`
- `碳水`
- `脂肪`
- `蔬菜`

如果 Excel 不存在或格式错误，服务仍会返回一张错误状态图片，固件可以显示“今日食谱不可用”而不是崩溃。

## 局域网要求

E1002 必须能访问 Mac 的局域网 IPv4。常见问题：

- E1002 在 Guest Wi-Fi。
- 路由器开启 AP Isolation。
- VLAN 或防火墙阻止设备访问 Mac。
- Mac IP 变化后固件仍使用旧 URL。
- macOS 防火墙拒绝 Node 入站连接。

建议在路由器里给 Mac 设置 DHCP Reservation。固件里优先使用 IPv4 URL，而不是依赖 mDNS。

手机验证方式：

```text
http://<Mac-IP>:19527/api/device/<deviceToken>
```

手机需要和 E1002 位于同一可达 Wi-Fi。能看到 JSON，说明局域网、macOS 防火墙和 token 基本正确。

## 隐私边界

服务不会读取、复制或输出 `~/.codex/auth.json`。认证材料只由 `codex app-server` 自己处理。

不要提交：

- `dist/`
- `node_modules/`
- `generated/`
- `preview/`
- `.env`
- 日志
- 完整设备 API URL
- device token
- Excel 的私人路径或私人内容

日志和 API 响应不应包含 Wi-Fi 密码、OAuth token、Cookie、邮箱或账户 ID。

## 开发验证

```bash
npm test
```

测试覆盖：

- JSONL 分段输入。
- JSON-RPC 请求关联和超时。
- 当前和旧版额度字段。
- 5 小时额度、周额度和 fallback 窗口。
- token 用量格式化。
- 缓存回退和 stale 状态。
- 设备 token 路由。
- 旧页面入口 404。
- API 脱敏和响应大小限制。
- 食谱 Excel 解析、图片元数据和 raw 图片接口。
- 天气接口 token 校验、缓存回退和响应脱敏。
- 配置页 token 校验和天气配置保存。
- `Cache-Control: no-store` 和基础响应头。
