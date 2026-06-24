import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeWeatherConfig, saveConfig } from "./cache";
import type { DashboardConfig, WeatherConfig } from "./types";

const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none';";
const MAX_FORM_BYTES = 8192;

export interface AdminConfigOptions {
  saveConfig?: (config: DashboardConfig) => Promise<void>;
}

export async function handleAdminConfigRequest(
  config: DashboardConfig,
  request: IncomingMessage,
  response: ServerResponse,
  options: AdminConfigOptions = {},
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? config.bindHost}`);
  const prefix = "/admin/";
  if (!url.pathname.startsWith(prefix)) {
    return false;
  }

  const parts = url.pathname.slice(prefix.length).split("/");
  const token = decodeURIComponent(parts[0] ?? "");
  const page = parts.slice(1).join("/");
  if (token !== config.adminToken || page !== "config") {
    notFound(response);
    return true;
  }

  const method = request.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    html(response, renderConfigPage(config, url.pathname, false), 200);
    return true;
  }
  if (method === "POST") {
    const form = await readForm(request);
    applyWeatherForm(config, form);
    config.updatedAt = new Date().toISOString();
    await (options.saveConfig ?? saveConfig)(config);
    html(response, renderConfigPage(config, url.pathname, true), 200);
    return true;
  }

  notFound(response);
  return true;
}

function applyWeatherForm(config: DashboardConfig, form: URLSearchParams): void {
  const existing = config.weather;
  const provider = form.get("provider") === "caiyun-v2.6" ? "caiyun-v2.6" : "open-meteo";
  const tokenInput = (form.get("caiyunToken") ?? "").trim();
  const clearToken = form.get("clearCaiyunToken") === "1";
  const next: Partial<WeatherConfig> = {
    enabled: form.get("weatherEnabled") === "1",
    provider,
    locationName: form.get("locationName") ?? existing.locationName,
    latitude: Number(form.get("latitude") ?? existing.latitude),
    longitude: Number(form.get("longitude") ?? existing.longitude),
    timezone: form.get("timezone") ?? existing.timezone,
    caiyunToken: clearToken ? "" : (tokenInput || existing.caiyunToken || ""),
    updatedAt: new Date().toISOString(),
  };
  config.weather = normalizeWeatherConfig(next);
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_FORM_BYTES) {
      throw new Error("admin config form too large");
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function renderConfigPage(config: DashboardConfig, actionPath: string, saved: boolean): string {
  const weather = config.weather;
  const checked = weather.enabled ? "checked" : "";
  const openMeteoSelected = weather.provider === "open-meteo" ? "selected" : "";
  const caiyunSelected = weather.provider === "caiyun-v2.6" ? "selected" : "";
  const caiyunTokenStatus = weather.caiyunToken ? "已保存，留空表示保留现有 token。" : "未设置。选择彩云天气时需要填写 token。";
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E1002 Config</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;line-height:1.45;color:#111}
main{max-width:720px}
label{display:block;margin:12px 0 4px;font-weight:600}
input,select{font:inherit;padding:8px;width:100%;box-sizing:border-box}
button{font:inherit;padding:9px 14px;margin-top:16px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ok{color:#067d00;font-weight:700}
.hint{color:#555}
</style>
<main>
<h1>E1002 模块配置</h1>
${saved ? '<p class="ok">已保存。下一次 E1002 请求天气页时生效。</p>' : ""}
<form method="post" action="${escapeHtml(actionPath)}">
  <h2>天气模块</h2>
  <label><input type="checkbox" name="weatherEnabled" value="1" ${checked} style="width:auto"> 启用服务端天气数据</label>
  <label>天气源</label>
  <select name="provider">
    <option value="open-meteo" ${openMeteoSelected}>Open-Meteo, no key</option>
    <option value="caiyun-v2.6" ${caiyunSelected}>彩云天气 v2.6, token</option>
  </select>
  <p class="hint">杭州余杭默认坐标已经填好；如需更精确到小区/公司，可手动改经纬度。彩云 token 只保存在 Mac 本地配置中，不会下发给 E1002。</p>
  <label>彩云天气 Token</label>
  <input name="caiyunToken" type="password" autocomplete="off" maxlength="256" placeholder="${weather.caiyunToken ? "留空保留现有 token" : "粘贴彩云 token"}">
  <p class="hint">${escapeHtml(caiyunTokenStatus)}</p>
  <label><input type="checkbox" name="clearCaiyunToken" value="1" style="width:auto"> 清除已保存的彩云 token</label>
  <label>地点名称</label>
  <input name="locationName" maxlength="48" value="${escapeHtml(weather.locationName)}">
  <div class="row">
    <div>
      <label>纬度 Latitude</label>
      <input name="latitude" inputmode="decimal" value="${escapeHtml(String(weather.latitude))}">
    </div>
    <div>
      <label>经度 Longitude</label>
      <input name="longitude" inputmode="decimal" value="${escapeHtml(String(weather.longitude))}">
    </div>
  </div>
  <label>时区</label>
  <input name="timezone" maxlength="48" value="${escapeHtml(weather.timezone)}">
  <button type="submit">保存配置</button>
</form>
</main>
</html>`;
}

function html(response: ServerResponse, body: string, statusCode: number): void {
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.setHeader("Content-Security-Policy", ADMIN_CSP);
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function notFound(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.setHeader("Content-Security-Policy", ADMIN_CSP);
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not Found\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
