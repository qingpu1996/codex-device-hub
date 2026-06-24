# codex-quota-dashboard

局域网内运行的 Codex 套餐额度服务，只给 reTerminal E1002 自定义固件提供脱敏 JSON API 和食谱图片接口。E1002 固件不加载 HTML、CSS、JavaScript、iframe 或浏览器页面，只获取数据并在设备端用原生绘图 API 渲染。

## 架构

链路：

```text
Codex CLI 登录状态
  -> codex app-server
  -> Mac mini 局域网 HTTP 服务
  -> E1002 JSON / raw image 固件客户端
  -> reTerminal E1002
```

服务由当前 macOS 用户的 LaunchAgent 运行。Node 进程长期启动 `codex app-server --stdio`，通过 JSONL JSON-RPC 调用：

- `initialize`
- `initialized`
- `account/read`，使用 `refreshToken=false`
- `account/rateLimits/read`
- `account/usage/read`

HTTP 请求只读取内存缓存，不会在每次访问时重新启动 App Server。最后一次成功的脱敏数据会写入：

```text
~/Library/Application Support/CodexQuotaDashboard/cache.json
```

## 数据来源和隐私边界

数据来自当前 Mac 用户已经登录的 Codex CLI 会话，所以不需要 OpenAI API Key。

项目不会读取、复制或输出 `~/.codex/auth.json`。认证细节只由 `codex app-server` 自己处理，本服务只接收 `account/read`、`account/rateLimits/read` 和 `account/usage/read` 返回后归一化出的脱敏字段。

API 不显示邮箱、账户 ID、OAuth Token、Cookie、device token 或原始 RPC 响应。错误 token 和未知路径统一返回 404。

## 设备 API

主接口：

```text
http://<Mac局域网IP>:19527/api/device/<deviceToken>
```

`deviceToken` 是至少 32 字节安全随机值，保存在本机私有配置中，不提交到 Git。接口只返回屏幕绘制所需字段：

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
    }
  ]
}
```

接口带 `Cache-Control: no-store`，错误 token 返回 404，响应体受大小限制。

## 食谱图片 API

食谱页使用同一个设备 token：

```text
GET /api/device/<deviceToken>/meal/today
GET /api/device/<deviceToken>/meal/today.raw
GET /api/device/<deviceToken>/meal/today.png
```

- `meal/today` 返回图片元数据。
- `meal/today.raw` 返回 E1002 固件使用的 800x480 4bpp 原始图像。
- `meal/today.png` 只用于浏览器或本机调试预览。

默认读取：

```text
~/Documents/codex-quota-dashboard/meal-plan.xlsx
```

也可以通过环境变量覆盖：

```bash
CODEX_MEAL_EXCEL_PATH=/path/to/meal-plan.xlsx scripts/restart.sh
```

Excel 路径不应提交到 Git；仓库只包含解析和渲染逻辑。

## 安装

```bash
cd /path/to/codex-quota-dashboard
scripts/install-launchd.sh
```

安装脚本会：

- 探测 `codex`、`node`、默认网络接口、局域网 IPv4 和 MAC 地址。
- 安装 npm 依赖。
- 构建 TypeScript。
- 创建 `~/Library/Application Support/CodexQuotaDashboard/config.json`。
- 生成设备 API 使用的随机 `deviceToken`。
- 安装并启动当前用户级 LaunchAgent：

```text
~/Library/LaunchAgents/com.qingpu.codex-quota-dashboard.plist
```

脚本最后会打印设备 API URL。完整 URL 包含 token，只应填入本机固件配置或用于局域网验证，不要提交到 Git。

## 启动、停止、重启

```bash
scripts/restart.sh
scripts/uninstall-launchd.sh
```

`uninstall-launchd.sh` 只卸载 LaunchAgent，保留配置和缓存。

## 状态和日志

```bash
scripts/status.sh
scripts/logs.sh
scripts/logs.sh follow
```

日志路径：

```text
~/Library/Logs/CodexQuotaDashboard/stdout.log
~/Library/Logs/CodexQuotaDashboard/stderr.log
```

## 更新局域网 IP

如果 Mac mini 的 DHCP 地址变化，服务不会静默改 URL。状态脚本会显示 configured IP 和 current IP 的差异。

显式更新：

```bash
scripts/update-lan-ip.sh
```

更新后需要把新的设备 API URL 填回固件本地配置。

## 重新生成设备 Token

```bash
scripts/regenerate-device-token.sh
```

这会改变设备 API URL。重新生成后需要更新 `firmware/e1002/include/secrets.h` 或后续配网页面中的 API 设置。

## Codex 重新登录后的处理

如果 Codex CLI 登录状态过期，先在终端里重新登录 Codex CLI，然后重启服务：

```bash
scripts/restart.sh
```

服务失败期间会返回最后一次成功缓存，并标记数据可能已过期。

## macOS 防火墙

如果 macOS 防火墙弹窗询问是否允许 Node 接收入站连接，需要点击“允许”，否则 E1002 可能无法从局域网访问 Mac mini。

不要用 `sudo` 修改系统防火墙；本项目只安装当前用户 LaunchAgent。

## E1002 与 Mac 不同网时

如果 E1002 和 Mac mini 不在同一个二层/三层可达网络，设备 API 会访问失败。常见原因：

- E1002 在 Guest Wi-Fi。
- 路由器开启 AP Isolation。
- VLAN 防火墙阻止设备访问 Mac。
- Mac IP 已改变。
- 固件中的 device token 仍是旧 token。
- macOS 防火墙拒绝 Node 入站连接。

## 为什么建议 DHCP 地址保留

固件中填写的是固定 IPv4 URL。若 Mac mini 的 IPv4 改变，E1002 仍会请求旧地址。建议在路由器中为 Mac 默认接口的 MAC 地址设置 DHCP 地址保留。

优先使用 IPv4 而不是 `mac-mini.local`，是因为嵌入式设备和隔离 Wi-Fi 对 mDNS 的支持不稳定，而 IPv4 地址在同网段内更可预测。

## 手机验证局域网 API

手机连接与 E1002 相同的 Wi-Fi，访问：

```text
http://<Mac局域网IP>:19527/api/device/<deviceToken>
```

能看到 JSON 说明局域网、macOS 防火墙和 token 都基本正确。不要把完整 URL 发到公网聊天或提交到仓库。

## 开发验证

```bash
npm test
```

测试覆盖 JSONL 分段输入、JSON-RPC 关联和超时、当前和旧版额度字段、primary/secondary、套餐解析、token 用量、clamp、去重、窗口识别、缓存回退、设备 token 路由、脱敏、响应大小限制、旧页面路由 404、食谱图片接口和 no-store 头。
