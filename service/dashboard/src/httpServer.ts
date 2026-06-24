import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { DashboardConfig, HealthStatus, SanitizedDashboardData } from "./types";
import { handleAdminConfigRequest, type AdminConfigOptions } from "./adminConfig";
import { buildDevicePayload, DEVICE_MAX_RESPONSE_BYTES } from "./devicePayload";
import {
  buildDeviceMealPayload,
  getTodayMealAssets,
  MEAL_PNG_CONTENT_TYPE,
  MEAL_RAW_BYTES,
  MEAL_RAW_CONTENT_TYPE,
} from "./mealPlan";
import { getDeviceWeatherPayload, WEATHER_MAX_RESPONSE_BYTES } from "./weather";

const CACHE_CONTROL = "no-store, no-cache, must-revalidate";
const CSP = "default-src 'none'; frame-ancestors 'none';";

export interface DashboardStateProvider {
  getData(): SanitizedDashboardData | null;
  getHealth(): HealthStatus;
}

export interface DashboardHttpServerOptions extends AdminConfigOptions {}

export function createDashboardHttpServer(
  config: DashboardConfig,
  provider: DashboardStateProvider,
  options: DashboardHttpServerOptions = {},
): http.Server {
  return http.createServer((request, response) => {
    void handleRequest(config, provider, request, response, options).catch((error) => {
      console.error(`[http] request failed: ${String(error)}`);
      if (!response.headersSent) {
        response.setHeader("Cache-Control", CACHE_CONTROL);
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      response.end("Internal Server Error\n");
    });
  });
}

async function handleRequest(
  config: DashboardConfig,
  provider: DashboardStateProvider,
  request: IncomingMessage,
  response: ServerResponse,
  options: DashboardHttpServerOptions,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? config.bindHost}`);

  if (await handleAdminConfigRequest(config, request, response, options)) {
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    return notFound(response);
  }

  if (url.pathname === "/healthz") {
    return json(response, provider.getHealth(), 200, false);
  }

  if (url.pathname === "/robots.txt") {
    setNoCacheHeaders(response);
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("User-agent: *\nDisallow: /\n");
    return;
  }

  const devicePrefix = "/api/device/";
  if (url.pathname.startsWith(devicePrefix)) {
    const suffix = url.pathname.slice(devicePrefix.length);
    const [encodedToken = "", ...subpathParts] = suffix.split("/");
    const token = decodeURIComponent(encodedToken);
    if (token !== config.deviceToken) {
      return notFound(response);
    }
    const subpath = subpathParts.join("/");
    if (subpath === "") {
      const payload = buildDevicePayload(provider.getData() ?? emptyData(false));
      return json(response, payload, 200, true, DEVICE_MAX_RESPONSE_BYTES);
    }
    if (subpath === "meal/today") {
      const assets = await getTodayMealAssets(new Date(), undefined, mealSlot(url));
      return json(response, buildDeviceMealPayload(assets), 200, true, 2048);
    }
    if (subpath === "meal/today.raw") {
      const assets = await getTodayMealAssets(new Date(), undefined, mealSlot(url));
      return binary(response, assets.raw4bpp, MEAL_RAW_CONTENT_TYPE, {
        "X-Meal-Image-Hash": assets.imageHash,
        "X-Meal-Status": assets.status,
      }, MEAL_RAW_BYTES);
    }
    if (subpath === "meal/today.png") {
      const assets = await getTodayMealAssets(new Date(), undefined, mealSlot(url));
      return binary(response, assets.png, MEAL_PNG_CONTENT_TYPE, {
        "X-Meal-Image-Hash": assets.imageHash,
        "X-Meal-Status": assets.status,
      }, 512 * 1024);
    }
    if (subpath === "weather") {
      const payload = await getDeviceWeatherPayload(config.weather, pageSlot(url));
      return json(response, payload, 200, true, WEATHER_MAX_RESPONSE_BYTES);
    }
    return notFound(response);
  }

  return notFound(response);
}

function mealSlot(url: URL): number {
  return pageSlot(url);
}

function pageSlot(url: URL): number {
  const value = Number(url.searchParams.get("slot") ?? "1");
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

export function setNoCacheHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", CACHE_CONTROL);
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.setHeader("Content-Security-Policy", CSP);
}

function json(
  response: ServerResponse,
  value: unknown,
  statusCode: number,
  includeCsp: boolean,
  maxBodyBytes = 64 * 1024,
): void {
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
    response.setHeader("Cache-Control", CACHE_CONTROL);
    response.setHeader("Pragma", "no-cache");
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end('{"error":"response_too_large"}\n');
    return;
  }
  response.setHeader("Cache-Control", CACHE_CONTROL);
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (includeCsp) {
    response.setHeader("Content-Security-Policy", CSP);
  }
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(body);
}

function binary(
  response: ServerResponse,
  body: Buffer,
  contentType: string,
  extraHeaders: Record<string, string>,
  expectedMaxBytes: number,
): void {
  if (body.length > expectedMaxBytes) {
    response.setHeader("Cache-Control", CACHE_CONTROL);
    response.setHeader("Pragma", "no-cache");
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("response too large\n");
    return;
  }
  response.setHeader("Cache-Control", CACHE_CONTROL);
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.setHeader("Content-Security-Policy", CSP);
  for (const [name, value] of Object.entries(extraHeaders)) {
    response.setHeader(name, value);
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(body.length),
  });
  response.end(body);
}

function notFound(response: ServerResponse): void {
  setNoCacheHeaders(response);
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not Found\n");
}

function emptyData(appServerConnected: boolean): SanitizedDashboardData {
  const now = new Date();
  return {
    version: 1,
    planType: null,
    windows: [],
    displayWindows: [],
    resetCreditAvailableCount: null,
    usage: null,
    lastSuccessAt: null,
    generatedAt: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Local",
    usingCache: true,
    stale: true,
    appServerConnected,
    statusText: "等待首次额度同步",
  };
}

export const dashboardHeaders = {
  cacheControl: CACHE_CONTROL,
  csp: CSP,
};
