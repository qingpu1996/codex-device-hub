import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { normalizeMealConfig, normalizeWeatherConfig, saveConfig } from "./cache";
import { getDeviceWeatherPayload } from "./weather";
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
    html(response, await renderConfigPage(config, false), 200);
    return true;
  }
  if (method === "POST") {
    const form = await readForm(request);
    applyMealForm(config, form);
    applyWeatherForm(config, form);
    config.updatedAt = new Date().toISOString();
    await (options.saveConfig ?? saveConfig)(config);
    const weatherTest = form.get("action") === "test-weather" ? await runWeatherTest(config) : null;
    html(response, await renderConfigPage(config, true, weatherTest), 200);
    return true;
  }

  notFound(response);
  return true;
}

function applyMealForm(config: DashboardConfig, form: URLSearchParams): void {
  const existing = config.meal;
  config.meal = normalizeMealConfig({
    enabled: form.get("mealEnabled") === "1",
    excelPath: form.get("mealExcelPath") ?? existing.excelPath,
    updatedAt: new Date().toISOString(),
  });
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

interface WeatherTestResult {
  ok: boolean;
  status: string;
  source: string;
  location: string;
  slotCount: number;
  responseBytes: number;
  summary: string;
}

async function runWeatherTest(config: DashboardConfig): Promise<WeatherTestResult> {
  const payload = await getDeviceWeatherPayload(config.weather, 1, new Date());
  const body = `${JSON.stringify(payload)}\n`;
  const temp = payload.current.tempC === null ? "--" : `${payload.current.tempC}C`;
  const condition = payload.current.condition || "UNKNOWN";
  return {
    ok: payload.status === "fresh" || payload.status === "cached" || payload.status === "stale",
    status: payload.status,
    source: payload.source,
    location: payload.location,
    slotCount: payload.slotCount,
    responseBytes: Buffer.byteLength(body, "utf8"),
    summary: `${condition} ${temp}`,
  };
}

async function renderConfigPage(config: DashboardConfig, saved: boolean, weatherTest: WeatherTestResult | null = null): Promise<string> {
  const meal = config.meal;
  const weather = config.weather;
  const mealChecked = meal.enabled ? "checked" : "";
  const weatherChecked = weather.enabled ? "checked" : "";
  const openMeteoSelected = weather.provider === "open-meteo" ? "selected" : "";
  const caiyunSelected = weather.provider === "caiyun-v2.6" ? "selected" : "";
  const caiyunTokenStatus = weather.caiyunToken ? "已保存，留空表示保留现有 token。" : "未设置。选择彩云天气时需要填写 token。";
  const mealPathStatus = await fileStatus(meal.excelPath);
  const weatherProviderStatus = weather.provider === "caiyun-v2.6" && !weather.caiyunToken ? "需要填写彩云 token" : "配置完整";
  const suggestedMeal = meal.enabled ? "1" : "0";
  const suggestedWeather = weather.enabled ? "1" : "0";
  const weatherTestHtml = weatherTest ? `
<section class="result ${weatherTest.ok ? "good" : "bad"}">
  <h2>天气连接测试</h2>
  <p><strong>${weatherTest.ok ? "可用" : "不可用"}</strong>：${escapeHtml(weatherTest.source)} / ${escapeHtml(weatherTest.status)} / ${escapeHtml(weatherTest.location)}</p>
  <p>${escapeHtml(weatherTest.summary)}，内部页 ${weatherTest.slotCount} 页，响应 ${weatherTest.responseBytes} bytes。</p>
</section>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>E1002 Config</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;line-height:1.45;color:#111;background:#fafafa}
main{max-width:880px}
label{display:block;margin:12px 0 4px;font-weight:600}
input,select{font:inherit;padding:8px;width:100%;box-sizing:border-box}
button{font:inherit;padding:9px 14px;margin:16px 8px 0 0}
section{background:#fff;border:1px solid #ccc;padding:16px;margin:16px 0}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.modules{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.module{border:1px solid #bbb;padding:12px}
.status{font-weight:700}
.good{border-color:#067d00}
.bad{border-color:#b00020}
.ok,.good .status{color:#067d00;font-weight:700}
.bad .status{color:#b00020}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f1f1f1;padding:8px;white-space:pre-wrap}
.hint{color:#555}
@media (max-width:720px){.row,.modules{grid-template-columns:1fr}}
</style>
<main>
<h1>E1002 模块配置</h1>
${saved ? '<p class="ok">已保存。下一次 E1002 请求天气页时生效。</p>' : ""}
${weatherTestHtml}
<section>
  <h2>模块总览</h2>
  <div class="modules">
    <div class="module good">
      <div class="status">Codex 额度：启用</div>
      <p class="hint">内置基础页，固件始终包含。</p>
    </div>
    <div class="module ${meal.enabled ? "good" : "bad"}">
      <div class="status">每日食谱：${meal.enabled ? "启用" : "关闭"}</div>
      <p class="hint">${escapeHtml(mealPathStatus)}</p>
    </div>
    <div class="module ${weather.enabled ? "good" : "bad"}">
      <div class="status">天气：${weather.enabled ? "启用" : "关闭"}</div>
      <p class="hint">${escapeHtml(weatherProviderStatus)}</p>
    </div>
  </div>
  <p class="hint">配置页只控制 Mac 服务端能力；固件是否包含页面仍由烧录时的 feature 选择决定。</p>
  <div class="code">FEATURE_MEAL=${suggestedMeal}
FEATURE_WEATHER=${suggestedWeather}</div>
</section>
<form method="post">
  <section>
  <h2>每日食谱模块</h2>
  <label><input type="checkbox" name="mealEnabled" value="1" ${mealChecked} style="width:auto"> 启用服务端食谱数据</label>
  <label>Excel 路径</label>
  <input name="mealExcelPath" maxlength="512" value="${escapeHtml(meal.excelPath)}">
  <p class="hint">E1002 不解析 Excel；Mac 服务会把当天食谱渲染成 800 x 480 raw 图片。路径可以是 NAS 挂载目录下的 xlsx 文件。</p>
  </section>
  <section>
  <h2>天气模块</h2>
  <label><input type="checkbox" name="weatherEnabled" value="1" ${weatherChecked} style="width:auto"> 启用服务端天气数据</label>
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
  </section>
  <button type="submit" name="action" value="save">保存配置</button>
  <button type="submit" name="action" value="test-weather">保存并测试天气</button>
</form>
</main>
</html>`;
}

async function fileStatus(file: string): Promise<string> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      return "路径存在，但不是文件。";
    }
    return `文件存在，大小 ${stat.size} bytes。`;
  } catch {
    return "文件不存在或当前未挂载。";
  }
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
