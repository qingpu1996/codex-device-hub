import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";

const require = createRequire(import.meta.url);

function modules() {
  return {
    jsonl: require("../dist/src/jsonl.js"),
    jsonRpc: require("../dist/src/jsonRpc.js"),
    normalizer: require("../dist/src/normalizer.js"),
    httpServer: require("../dist/src/httpServer.js"),
    deck: require("../dist/src/deck.js"),
    devicePayload: require("../dist/src/devicePayload.js"),
    mealPlan: require("../dist/src/mealPlan.js"),
    weather: require("../dist/src/weather.js"),
  };
}

const now = new Date("2026-06-24T12:00:00+08:00");
const resetFive = Math.floor(now.getTime() / 1000) + 2 * 60 * 60;
const resetWeek = Math.floor(now.getTime() / 1000) + 5 * 24 * 60 * 60;

function account(planType = "pro") {
  return {
    account: { type: "chatgpt", email: "private@example.com", planType },
    requiresOpenaiAuth: true,
  };
}

function multiBucketLimits() {
  return {
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 5.2, windowDurationMins: 300, resetsAt: resetFive },
        secondary: { usedPercent: 70.1, windowDurationMins: 10080, resetsAt: resetWeek },
        planType: "plus",
        rateLimitReachedType: null,
      },
      model_x: {
        limitId: "model_x",
        limitName: "Model X",
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: resetFive },
        secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: resetWeek },
        planType: "plus",
        rateLimitReachedType: null,
      },
    },
    rateLimitResetCredits: { availableCount: "2" },
  };
}

function usageResponse() {
  return {
    summary: {
      lifetimeTokens: 1401213494,
      peakDailyTokens: 287824432,
    },
    dailyUsageBuckets: [
      { startDate: "2026-06-23", tokens: 52326871 },
      { startDate: "2026-06-24", tokens: 3624529 },
    ],
  };
}

test("JSONL parser handles segmented and multi-line input", () => {
  const { JsonLineParser } = modules().jsonl;
  const parser = new JsonLineParser();
  assert.deepEqual(parser.push('{"a"'), []);
  assert.deepEqual(parser.push(':1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.equal(parser.pendingText(), "");
});

test("JSON-RPC client correlates request and response", async () => {
  const { JsonRpcStdioClient } = modules().jsonRpc;
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const client = new JsonRpcStdioClient(clientToServer, serverToClient, undefined, { defaultTimeoutMs: 1000 });
  const request = client.request("sample/read", { ok: true });

  const line = await new Promise((resolve) => clientToServer.once("data", (chunk) => resolve(chunk.toString())));
  const parsed = JSON.parse(line);
  assert.equal(parsed.method, "sample/read");
  serverToClient.write(`${JSON.stringify({ id: parsed.id, result: { value: 42 } })}\n`);
  assert.deepEqual(await request, { value: 42 });
});

test("JSON-RPC request timeout rejects", async () => {
  const { JsonRpcStdioClient } = modules().jsonRpc;
  const client = new JsonRpcStdioClient(new PassThrough(), new PassThrough(), undefined, { defaultTimeoutMs: 10 });
  await assert.rejects(() => client.request("slow/read"), /timed out/);
});

test("JSON-RPC unrelated notification is emitted and ignored for pending requests", async () => {
  const { JsonRpcStdioClient } = modules().jsonRpc;
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const client = new JsonRpcStdioClient(clientToServer, serverToClient, undefined, { defaultTimeoutMs: 1000 });
  const notifications = [];
  client.on("notification", (notification) => notifications.push(notification.method));
  const request = client.request("account/rateLimits/read");
  const line = await new Promise((resolve) => clientToServer.once("data", (chunk) => resolve(chunk.toString())));
  const parsed = JSON.parse(line);
  serverToClient.write('{"method":"account/rateLimits/updated","params":{}}\n');
  serverToClient.write(`${JSON.stringify({ id: parsed.id, result: { ok: true } })}\n`);
  assert.deepEqual(await request, { ok: true });
  assert.deepEqual(notifications, ["account/rateLimits/updated"]);
});

test("account/read plan parsing prefers account plan type", () => {
  const { normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData(account("pro"), multiBucketLimits(), { now });
  assert.equal(data.planType, "pro");
  assert.equal(data.displayWindows[0].planType, "pro");
});

test("rateLimitsByLimitId multi-bucket parsing works", () => {
  const { normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData(account(), multiBucketLimits(), { now });
  assert.equal(data.windows.length, 4);
  assert.equal(data.resetCreditAvailableCount, 2);
});

test("legacy rateLimits field is supported", () => {
  const { normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData(account(), {
    rateLimits: {
      limitId: "legacy",
      limitName: "Legacy",
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: resetFive },
      secondary: null,
      planType: "team",
      rateLimitReachedType: null,
    },
  }, { now });
  assert.equal(data.windows.length, 1);
  assert.equal(data.windows[0].limitId, "legacy");
});

test("primary and secondary windows are both included", () => {
  const { normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData(account(), multiBucketLimits(), { now });
  assert.ok(data.windows.some((window) => window.sourceBucket === "codex.primary"));
  assert.ok(data.windows.some((window) => window.sourceBucket === "codex.secondary"));
});

test("missing account plan type falls back to bucket plan type", () => {
  const { normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData({ account: null }, multiBucketLimits(), { now });
  assert.equal(data.planType, "plus");
});

test("usedPercent and remainingPercent are clamped", () => {
  const { normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData(account(), {
    rateLimits: {
      limitId: "x",
      primary: { usedPercent: 130, windowDurationMins: 300, resetsAt: resetFive },
      secondary: { usedPercent: -5, windowDurationMins: 10080, resetsAt: resetWeek },
      planType: null,
      rateLimitReachedType: null,
    },
  }, { now });
  assert.equal(data.windows[0].usedPercent, 100);
  assert.equal(data.windows[0].remainingPercent, 0);
  assert.equal(data.windows[1].usedPercent, 0);
  assert.equal(data.windows[1].remainingPercent, 100);
});

test("duplicate quota windows are removed", () => {
  const { normalizeQuotaData } = modules().normalizer;
  const duplicated = {
    rateLimitsByLimitId: {
      a: {
        limitId: "same",
        limitName: "Same",
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: resetFive },
        secondary: null,
        planType: "pro",
        rateLimitReachedType: null,
      },
      b: {
        limitId: "same",
        limitName: "Same",
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: resetFive },
        secondary: null,
        planType: "pro",
        rateLimitReachedType: null,
      },
    },
  };
  const data = normalizeQuotaData(account(), duplicated, { now });
  assert.equal(data.windows.length, 1);
});

test("five-hour quota window is identified", () => {
  const { normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData(account(), multiBucketLimits(), { now });
  assert.ok(data.windows.some((window) => window.windowKind === "five_hour" && window.displayName === "5 小时额度"));
});

test("weekly quota window is identified", () => {
  const { normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData(account(), multiBucketLimits(), { now });
  assert.ok(data.windows.some((window) => window.windowKind === "weekly" && window.displayName === "周额度"));
});

test("non-standard windows are displayed when expected windows are missing", () => {
  const { normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData(account(), {
    rateLimits: {
      limitId: "short",
      primary: { usedPercent: 44, windowDurationMins: 120, resetsAt: resetFive },
      secondary: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
  }, { now });
  assert.equal(data.displayWindows[0].displayName, "2 小时额度");
  assert.equal(data.displayWindows[0].remainingPercent, 56);
});

test("usage/read token counts are normalized for display", () => {
  const { formatTokenCount, normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData(account(), multiBucketLimits(), { now, usageResponse: usageResponse() });
  assert.equal(data.usage.totalTokens, 1401213494);
  assert.equal(data.usage.totalTokensText, "1.4B");
  assert.equal(data.usage.todayTokens, 3624529);
  assert.equal(data.usage.todayTokensText, "3.62M");
  assert.equal(data.usage.peakDailyTokensText, "288M");
  assert.equal(formatTokenCount(982), "982");
  assert.equal(formatTokenCount(12400), "12.4K");
});

test("app server failure can mark old cache as stale", () => {
  const { normalizeQuotaData, markCachedData } = modules().normalizer;
  const cached = normalizeQuotaData(account(), multiBucketLimits(), { now });
  const stale = markCachedData(cached, { now: new Date(now.getTime() + 60_000), appServerConnected: false });
  assert.equal(stale.usingCache, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.appServerConnected, false);
  assert.equal(stale.windows.length, cached.windows.length);
});

test("legacy page routes return 404", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const config = testConfig();
  const data = normalizeQuotaData(account(), multiBucketLimits(), { now });
  const server = createDashboardHttpServer(config, provider(data));
  await listen(server);
  try {
    const base = localBase(server);
    assert.equal((await fetch(`${base}/e1002/old-page-token`)).status, 404);
    assert.equal((await fetch(`${base}/api/e1002/old-page-token`)).status, 404);
  } finally {
    await close(server);
  }
});

test("device API requires independent device token", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const config = testConfig();
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account(), multiBucketLimits(), { now })));
  await listen(server);
  try {
    const base = localBase(server);
    assert.equal((await fetch(`${base}/api/device/test-page-token-12345678901234567890123456789012`)).status, 404);
    assert.equal((await fetch(`${base}/api/device/bad-token`)).status, 404);
    assert.equal((await fetch(`${base}/api/device/${config.deviceToken}`)).status, 200);
  } finally {
    await close(server);
  }
});

test("device API returns bounded no-store schema v1 payload", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const config = testConfig();
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account("pro"), multiBucketLimits(), { now, usageResponse: usageResponse() })));
  await listen(server);
  try {
    const response = await fetch(`${localBase(server)}/api/device/${config.deviceToken}`);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(Buffer.byteLength(text, "utf8") < 4096, true);
    assert.deepEqual(Object.keys(body), ["schemaVersion", "generatedAt", "plan", "status", "usage", "windows"]);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.plan, "PRO");
    assert.equal(body.status, "fresh");
    assert.deepEqual(body.usage, { totalTokensText: "1.4B", todayTokensText: "3.62M" });
    assert.equal(body.windows.length, 2);
    assert.deepEqual(Object.keys(body.windows[0]), ["key", "title", "remainingPercent", "resetsAt", "resetText"]);
    assert.equal(body.windows[0].key, "five_hour");
    assert.equal(body.windows[0].title, "5 HOUR");
    assert.equal(Number.isInteger(body.windows[0].remainingPercent), true);
    assert.equal(body.windows[0].remainingPercent >= 0 && body.windows[0].remainingPercent <= 100, true);
    assert.match(body.windows[0].resetText, /^[A-Z][a-z]{2} \d{2} \d{2}:\d{2}$/);
    assert.equal(text.includes("private@example.com"), false);
    assert.equal(text.includes(config.deviceToken), false);
    assert.equal(text.includes("rateLimitsByLimitId"), false);
    assert.equal(text.includes("dailyUsageBuckets"), false);
  } finally {
    await close(server);
  }
});

test("device meal metadata requires device token and returns image schema", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const config = testConfig();
  const previousPath = process.env.CODEX_MEAL_EXCEL_PATH;
  process.env.CODEX_MEAL_EXCEL_PATH = "/tmp/codex-quota-dashboard-missing-meal.xlsx";
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account("pro"), multiBucketLimits(), { now })));
  await listen(server);
  try {
    const base = localBase(server);
    assert.equal((await fetch(`${base}/api/device/bad-token/meal/today`)).status, 404);
    const response = await fetch(`${base}/api/device/${config.deviceToken}/meal/today`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.status, "missing");
    assert.equal(body.image.format, "e1002-4bpp");
    assert.equal(body.image.width, 800);
    assert.equal(body.image.height, 480);
    assert.equal(body.image.rawBytes, 192000);
    assert.match(body.image.hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(body).includes(config.deviceToken), false);
  } finally {
    await close(server);
    if (previousPath === undefined) {
      delete process.env.CODEX_MEAL_EXCEL_PATH;
    } else {
      process.env.CODEX_MEAL_EXCEL_PATH = previousPath;
    }
  }
});

test("device meal raw endpoint returns fixed-size 4bpp image", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const config = testConfig();
  const previousPath = process.env.CODEX_MEAL_EXCEL_PATH;
  process.env.CODEX_MEAL_EXCEL_PATH = "/tmp/codex-quota-dashboard-missing-meal.xlsx";
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account("pro"), multiBucketLimits(), { now })), {
    saveConfig: async () => {},
  });
  await listen(server);
  try {
    const response = await fetch(`${localBase(server)}/api/device/${config.deviceToken}/meal/today.raw`);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/vnd.codex.e1002-4bpp");
    assert.equal(body.length, 192000);
    assert.match(response.headers.get("x-meal-image-hash"), /^[0-9a-f]{64}$/);
  } finally {
    await close(server);
    if (previousPath === undefined) {
      delete process.env.CODEX_MEAL_EXCEL_PATH;
    } else {
      process.env.CODEX_MEAL_EXCEL_PATH = previousPath;
    }
  }
});

test("device meal endpoint can be disabled from Mac config", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const config = testConfig();
  config.meal.enabled = false;
  config.meal.excelPath = "/tmp/codex-quota-dashboard-disabled-meal.xlsx";
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account("pro"), multiBucketLimits(), { now })));
  await listen(server);
  try {
    const response = await fetch(`${localBase(server)}/api/device/${config.deviceToken}/meal/today`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "missing");
    assert.equal(body.updatedText, "MEAL DISABLED");
    assert.equal(body.image.rawBytes, 192000);
  } finally {
    await close(server);
  }
});

test("device weather endpoint requires token and returns normalized forecast", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const { resetWeatherCacheForTests } = modules().weather;
  const config = testConfig();
  resetWeatherCacheForTests();
  const restoreFetch = mockWeatherFetch();
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account("pro"), multiBucketLimits(), { now })));
  await listen(server);
  try {
    const base = localBase(server);
    assert.equal((await fetch(`${base}/api/device/bad-token/weather`)).status, 404);
    const response = await fetch(`${base}/api/device/${config.deviceToken}/weather?slot=2`);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(Buffer.byteLength(text, "utf8") < 8192, true);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.source, "open-meteo");
    assert.equal(body.location, "Hangzhou Yuhang");
    assert.equal(body.slot, 2);
    assert.equal(body.slotCount, 3);
    assert.equal(body.current.tempC, 31);
    assert.equal(body.current.condition, "RAIN");
    assert.equal(body.current.pm25, 18);
    assert.equal(body.details.visibilityKm, 12.3);
    assert.equal(body.details.cloudPercent, 76);
    assert.equal(body.today.highC, 33);
    assert.equal(body.hourly.length, 6);
    assert.equal(body.daily.length, 3);
    assert.equal(JSON.stringify(body).includes(config.deviceToken), false);
    assert.equal(JSON.stringify(body).includes(config.adminToken), false);
  } finally {
    await close(server);
    restoreFetch();
    resetWeatherCacheForTests();
  }
});

test("device weather endpoint supports caiyun provider without exposing token", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const { resetWeatherCacheForTests } = modules().weather;
  const config = testConfig();
  config.weather.provider = "caiyun-v2.6";
  config.weather.caiyunToken = "test-caiyun-token-keep-private";
  resetWeatherCacheForTests();
  const restoreFetch = mockWeatherFetch();
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account("pro"), multiBucketLimits(), { now })));
  await listen(server);
  try {
    const response = await fetch(`${localBase(server)}/api/device/${config.deviceToken}/weather?slot=3`);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.source, "caiyun-v2.6");
    assert.equal(body.status, "fresh");
    assert.equal(body.slot, 3);
    assert.equal(body.slotCount, 3);
    assert.equal(body.current.tempC, 30);
    assert.equal(body.current.humidityPercent, 68);
    assert.equal(body.current.pressureHpa, 1005);
    assert.equal(body.current.condition, "RAIN");
    assert.equal(body.current.pm25, 20);
    assert.equal(body.details.aqiChn, 46);
    assert.equal(body.details.visibilityKm, 18.6);
    assert.equal(body.details.cloudPercent, 82);
    assert.equal(body.details.nearestRainDistanceKm, 2.4);
    assert.equal(body.details.comfortIndex, 4);
    assert.equal(body.details.dressingIndex, 3);
    assert.equal(body.details.coldRiskIndex, 2);
    assert.equal(body.today.highC, 34);
    assert.equal(body.today.sunriseText, "05:02");
    assert.equal(body.hourly.length, 6);
    assert.equal(body.daily.length, 3);
    assert.equal(text.includes(config.weather.caiyunToken), false);
  } finally {
    await close(server);
    restoreFetch();
    resetWeatherCacheForTests();
  }
});

test("caiyun provider without token returns not configured payload", async () => {
  const { getDeviceWeatherPayload, resetWeatherCacheForTests } = modules().weather;
  const config = testConfig().weather;
  config.provider = "caiyun-v2.6";
  delete config.caiyunToken;
  resetWeatherCacheForTests();
  const payload = await getDeviceWeatherPayload(config, 1, now);
  assert.equal(payload.status, "not_configured");
  assert.equal(payload.source, "caiyun-v2.6");
  assert.equal(payload.current.condition, "NO DATA");
});

test("admin config page requires admin token and saves weather config without exposing device token", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const config = testConfig();
  let saved = null;
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account("pro"), multiBucketLimits(), { now })), {
    saveConfig: async (next) => {
      saved = JSON.parse(JSON.stringify(next));
    },
  });
  await listen(server);
  try {
    const base = localBase(server);
    assert.equal((await fetch(`${base}/admin/bad-token/config`)).status, 404);
    const page = await fetch(`${base}/admin/${config.adminToken}/config`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(html.includes(config.deviceToken), false);
    assert.equal(html.includes(config.adminToken), false);
    assert.equal(html.includes("secret-caiyun-token"), false);
    assert.equal(html.includes("模块总览"), true);
    assert.equal(html.includes("FEATURE_MEAL=1"), true);

    const form = new URLSearchParams({
      mealEnabled: "1",
      mealExcelPath: "/tmp/private-meal-plan.xlsx",
      weatherEnabled: "1",
      provider: "caiyun-v2.6",
      caiyunToken: "secret-caiyun-token",
      locationName: "Hangzhou Yuhang West",
      latitude: "30.426",
      longitude: "120.289",
      timezone: "Asia/Shanghai",
    });
    const response = await fetch(`${base}/admin/${config.adminToken}/config`, {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    assert.equal(response.status, 200);
    assert.equal(saved.meal.enabled, true);
    assert.equal(saved.meal.excelPath, "/tmp/private-meal-plan.xlsx");
    assert.equal(saved.weather.locationName, "Hangzhou Yuhang West");
    assert.equal(saved.weather.latitude, 30.426);
    assert.equal(saved.weather.longitude, 120.289);
    assert.equal(saved.weather.provider, "caiyun-v2.6");
    assert.equal(saved.weather.caiyunToken, "secret-caiyun-token");

    const secondForm = new URLSearchParams({
      mealEnabled: "1",
      mealExcelPath: "/tmp/private-meal-plan.xlsx",
      weatherEnabled: "1",
      provider: "caiyun-v2.6",
      locationName: "Hangzhou Yuhang West",
      latitude: "30.426",
      longitude: "120.289",
      timezone: "Asia/Shanghai",
    });
    await fetch(`${base}/admin/${config.adminToken}/config`, {
      method: "POST",
      body: secondForm,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    assert.equal(saved.weather.caiyunToken, "secret-caiyun-token");

    secondForm.set("clearCaiyunToken", "1");
    await fetch(`${base}/admin/${config.adminToken}/config`, {
      method: "POST",
      body: secondForm,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    assert.equal(saved.weather.caiyunToken, undefined);
  } finally {
    await close(server);
  }
});

test("admin config page can test weather without exposing provider token", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const { resetWeatherCacheForTests } = modules().weather;
  const config = testConfig();
  resetWeatherCacheForTests();
  const restoreFetch = mockWeatherFetch();
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account("pro"), multiBucketLimits(), { now })), {
    saveConfig: async () => {},
  });
  await listen(server);
  try {
    const form = new URLSearchParams({
      action: "test-weather",
      mealEnabled: "1",
      mealExcelPath: config.meal.excelPath,
      weatherEnabled: "1",
      provider: "caiyun-v2.6",
      caiyunToken: "test-caiyun-token-keep-private",
      locationName: "Hangzhou Yuhang",
      latitude: "30.42",
      longitude: "120.30",
      timezone: "Asia/Shanghai",
    });
    const response = await fetch(`${localBase(server)}/admin/${config.adminToken}/config`, {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /天气连接测试/);
    assert.match(html, /caiyun-v2\.6/);
    assert.equal(html.includes("test-caiyun-token-keep-private"), false);
    assert.equal(html.includes(config.deviceToken), false);
    assert.equal(html.includes(config.adminToken), false);
  } finally {
    await close(server);
    restoreFetch();
    resetWeatherCacheForTests();
  }
});

test("meal helpers select weekday and pack two pixels per byte", () => {
  const { buildTodayMealPlan, nearestE1002ColorNibble, packE1002Raw4bpp } = modules().mealPlan;
  const weeklyRows = [
    ["星期", "餐次", "餐名", "食材/份量（生重/干重；整盒/整包项目除外）", "做法/备注", "蔬菜(g)", "热量(kcal)", "蛋白质(g)", "碳水(g)", "脂肪(g)"],
    ["周三", "早餐", "测试早餐", "鸡蛋 2个 / 菠菜 100g", "水煮", 100, 300, 20, 30, 10],
    ["", "午餐", "测试午餐", "米饭 1盒 / 鸡胸 150g", "加热", 200, 600, 45, 75, 12],
  ];
  const summaryRows = [
    ["星期", "热量(kcal)", "蛋白质(g)", "碳水(g)", "脂肪(g)", "蔬菜(g)"],
    ["周三", 900, 65, 105, 22, 300],
  ];
  const plan = buildTodayMealPlan(weeklyRows, summaryRows, new Date("2026-06-24T12:00:00+08:00"), new Date("2026-06-19T23:34:00+08:00"));
  assert.equal(plan.weekday, "周三");
  assert.equal(plan.meals.length, 2);
  assert.equal(plan.summary.calories, 900);
  assert.equal(nearestE1002ColorNibble(255, 255, 255, 255), 0x0);
  assert.equal(nearestE1002ColorNibble(0, 0, 0, 255), 0x0f);

  const rgba = Buffer.alloc(800 * 480 * 4, 255);
  rgba[0] = 0;
  rgba[1] = 0;
  rgba[2] = 0;
  rgba[3] = 255;
  const raw = packE1002Raw4bpp(rgba, 800, 480);
  assert.equal(raw.length, 192000);
  assert.equal(raw[0], 0xf0);
});

test("device payload reports stale status and uses real fallback windows", () => {
  const { buildDevicePayload } = modules().devicePayload;
  const { markCachedData, normalizeQuotaData } = modules().normalizer;
  const data = normalizeQuotaData(account(), {
    rateLimits: {
      limitId: "short",
      primary: { usedPercent: 44, windowDurationMins: 120, resetsAt: resetFive },
      secondary: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
  }, { now });
  const payload = buildDevicePayload(markCachedData(data, { now }));
  assert.equal(payload.status, "stale");
  assert.equal(payload.windows.length, 1);
  assert.equal(payload.windows[0].key, "other");
  assert.equal(payload.windows[0].title, "2 HOUR");
  assert.equal(payload.windows[0].remainingPercent, 56);
});

test("healthz requires no token and does not return quota details", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const config = testConfig();
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account(), multiBucketLimits(), { now })));
  await listen(server);
  try {
    const response = await fetch(`${localBase(server)}/healthz`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes("displayWindows"), false);
    assert.equal(text.includes("planType"), false);
  } finally {
    await close(server);
  }
});

test("robots.txt blocks all crawlers", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const config = testConfig();
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account(), multiBucketLimits(), { now })));
  await listen(server);
  try {
    const response = await fetch(`${localBase(server)}/robots.txt`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /User-agent: \*/);
    assert.match(text, /Disallow: \//);
  } finally {
    await close(server);
  }
});

test("device API headers are no-store and do not enable browser embedding", async () => {
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const config = testConfig();
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account(), multiBucketLimits(), { now })));
  await listen(server);
  try {
    const response = await fetch(`${localBase(server)}/api/device/${config.deviceToken}`, { method: "HEAD" });
    const csp = response.headers.get("content-security-policy");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(response.headers.has("x-frame-options"), false);
    assert.equal(response.headers.has("cross-origin-embedder-policy"), false);
    assert.equal(response.headers.has("cross-origin-opener-policy"), false);
    assert.equal(response.headers.has("cross-origin-resource-policy"), false);
  } finally {
    await close(server);
  }
});

test("deck storage creates random token and preserves existing slot thread ids", async () => {
  const { DeckStore, DEFAULT_DECK_SLOTS } = modules().deck;
  const home = await tempHome();
  const secondHome = await tempHome();
  try {
    const store = new DeckStore(home);
    const config = await store.ensureConfig();
    assert.match(config.deckToken, /^[a-f0-9]{64}$/);
    const slots = await store.ensureSlots();
    assert.deepEqual(slots.map((slot) => slot.id), DEFAULT_DECK_SLOTS.map((slot) => slot.id));
    assert.equal(slots.length, 5);
    assert.equal(slots[0].activeThreadId, null);
    await store.updateSlot("general", (slot) => ({
      ...slot,
      activeThreadId: "thread_keep_general",
      lastSummary: "keep this",
      status: "running",
    }));
    const reloaded = await store.ensureSlots();
    const general = reloaded.find((slot) => slot.id === "general");
    assert.equal(general.activeThreadId, "thread_keep_general");
    assert.equal(general.title, "GENERAL");

    const otherConfig = await new DeckStore(secondHome).ensureConfig();
    assert.match(otherConfig.deckToken, /^[a-f0-9]{64}$/);
    assert.notEqual(otherConfig.deckToken, config.deckToken);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(secondHome, { recursive: true, force: true });
  }
});

test("deck HTTP routes require deck token and return sanitized slot data", async () => {
  const { DeckService, DeckStore } = modules().deck;
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const home = await tempHome();
  try {
    const store = new DeckStore(home);
    const deckConfig = await store.ensureConfig();
    const deckService = new DeckService(store, mockDeckClient());
    const config = testConfig();
    const server = createDashboardHttpServer(
      config,
      provider(normalizeQuotaData(account(), multiBucketLimits(), { now })),
      { deckService },
    );
    await listen(server);
    try {
      const base = localBase(server);
      assert.equal((await fetch(`${base}/api/deck/bad-token/slots`)).status, 404);
      const health = await fetch(`${base}/api/deck/${deckConfig.deckToken}/health`);
      const healthBody = await health.json();
      assert.equal(health.status, 200);
      assert.deepEqual(healthBody, {
        ok: true,
        service: "codex-deck",
        codex: "connected",
        storage: "ok",
      });

      const response = await fetch(`${base}/api/deck/${deckConfig.deckToken}/slots`);
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(response.status, 200);
      assert.equal(body.length, 5);
      assert.deepEqual(Object.keys(body[0]), ["id", "title", "subtitle", "status", "lastSummary"]);
      assert.equal(body[0].id, "general");
      assert.equal(text.includes(deckConfig.deckToken), false);
      assert.equal(text.includes("activeThreadId"), false);
      assert.equal(text.includes("auth.json"), false);

      const slot = await fetch(`${base}/api/deck/${deckConfig.deckToken}/slots/general`);
      assert.equal(slot.status, 200);
      assert.equal((await fetch(`${base}/api/deck/${deckConfig.deckToken}/slots/missing`)).status, 404);
    } finally {
      await close(server);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("deck debug text validates input and reuses one thread per slot", async () => {
  const { DeckService, DeckStore } = modules().deck;
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const home = await tempHome();
  try {
    const store = new DeckStore(home);
    const deckConfig = await store.ensureConfig();
    const client = mockDeckClient();
    const deckService = new DeckService(store, client);
    const config = testConfig();
    const server = createDashboardHttpServer(
      config,
      provider(normalizeQuotaData(account(), multiBucketLimits(), { now })),
      { deckService },
    );
    await listen(server);
    try {
      const base = localBase(server);
      const textUrl = `${base}/api/deck/${deckConfig.deckToken}/debug/text`;
      assert.equal((await postJson(textUrl, { text: "missing slot" })).status, 400);
      assert.equal((await postJson(textUrl, { slotId: "general" })).status, 400);
      assert.equal((await postJson(textUrl, { slotId: "missing", text: "hello" })).status, 404);

      const first = await (await postJson(textUrl, { slotId: "general", text: "hello one" })).json();
      assert.match(first.jobId, /^job_[a-f0-9]{24}$/);
      assert.equal(first.status, "running");
      const firstJob = await waitForPublicJob(deckService, first.jobId, "done");
      assert.equal(firstJob.status, "done");
      assert.equal(firstJob.slotId, "general");
      assert.equal(firstJob.fullReplyAvailable, true);

      const second = await (await postJson(textUrl, { slotId: "general", text: "hello two" })).json();
      await waitForPublicJob(deckService, second.jobId, "done");
      const third = await (await postJson(textUrl, { slotId: "e1002", text: "hello e1002" })).json();
      await waitForPublicJob(deckService, third.jobId, "done");

      const slots = await store.ensureSlots();
      const general = slots.find((slot) => slot.id === "general");
      const e1002 = slots.find((slot) => slot.id === "e1002");
      assert.equal(general.activeThreadId, "thread_general_1");
      assert.equal(e1002.activeThreadId, "thread_e1002_2");
      assert.equal(client.calls[1].activeThreadId, "thread_general_1");
      assert.notEqual(general.activeThreadId, e1002.activeThreadId);
    } finally {
      await close(server);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("deck jobs persist status transitions with safe filenames and relative full replies", async () => {
  const { DeckStore, publicJob } = modules().deck;
  const home = await tempHome();
  try {
    const store = new DeckStore(home);
    const job = await store.createJob("general", "input with /not/a/filename", "wrapped");
    assert.match(job.id, /^job_[a-f0-9]{24}$/);
    assert.equal(job.id.includes("filename"), false);
    assert.equal(job.status, "queued");

    const running = await store.updateJob(job.id, (current) => ({ ...current, status: "running" }));
    assert.equal(running.status, "running");
    const relativeReply = await store.saveFullReply(job.id, "full reply");
    assert.equal(relativeReply, `jobs/${job.id}.reply.txt`);
    const done = await store.updateJob(job.id, (current) => ({
      ...current,
      status: "done",
      screenReply: "done",
      fullReplyPath: relativeReply,
    }));
    assert.equal(done.status, "done");
    const publicDone = publicJob(done);
    assert.equal(publicDone.fullReplyAvailable, true);
    assert.equal(Object.values(publicDone).join(" ").includes(home), false);

    const tmpFiles = await findFiles(home, (file) => file.endsWith(".tmp"));
    assert.deepEqual(tmpFiles, []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("deck failed jobs and long screen replies are sanitized for device responses", async () => {
  const { DeckService, DeckStore } = modules().deck;
  const home = await tempHome();
  const failingHome = await tempHome();
  try {
    const longStore = new DeckStore(home);
    const longClient = mockDeckClient({
      fullReply: `${"这是一段很长的屏幕摘要。".repeat(80)} auth.json OpenAI API key Cookie OAuth token`,
    });
    const longService = new DeckService(longStore, longClient);
    const longJob = await longService.submitTextJob("general", "long reply please");
    const done = await waitForPublicJob(longService, longJob.id, "done");
    const doneText = JSON.stringify(done);
    assert.equal(done.screenReply.length <= 300, true);
    assert.match(done.screenReply, /\.\.\.$/);
    assert.equal(doneText.includes("auth.json"), false);
    assert.equal(doneText.includes("OpenAI API key"), false);
    assert.equal(doneText.includes("Cookie"), false);
    assert.equal(doneText.includes("OAuth token"), false);

    const failingStore = new DeckStore(failingHome);
    const failingService = new DeckService(failingStore, failingDeckClient());
    const failedJob = await failingService.submitTextJob("general", "please fail");
    const failed = await waitForPublicJob(failingService, failedJob.id, "failed");
    const failedText = JSON.stringify(failed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorMessage.includes("\n"), false);
    assert.equal(failedText.includes("at stack"), false);
    assert.equal(failedText.includes("auth.json"), false);
    assert.equal(failedText.includes("OpenAI API key"), false);
    assert.equal(failedText.includes("Cookie"), false);
    assert.equal(failedText.includes("OAuth token"), false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(failingHome, { recursive: true, force: true });
  }
});

test("deck audio upload accepts valid PCM WAV and stores private metadata", async () => {
  const { DeckService, DeckStore } = modules().deck;
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const home = await tempHome();
  try {
    const store = new DeckStore(home);
    const deckConfig = await store.ensureConfig();
    const deckService = new DeckService(store, mockDeckClient());
    const server = createDashboardHttpServer(
      testConfig(),
      provider(normalizeQuotaData(account(), multiBucketLimits(), { now })),
      { deckService },
    );
    await listen(server);
    try {
      const wav = makePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
      const response = await fetch(`${localBase(server)}/api/deck/${deckConfig.deckToken}/audio/utterance?slotId=general`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav,
      });
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(response.status, 200);
      assert.match(body.jobId, /^audio_job_[a-f0-9]{24}$/);
      assert.equal(body.status, "audio_received");
      assert.equal(body.slotId, "general");
      assert.equal(body.bytes, wav.length);
      assert.deepEqual(body.format, {
        container: "wav",
        sampleRate: 16000,
        bitsPerSample: 16,
        channels: 1,
        durationMs: 1000,
      });
      assert.equal(text.includes(deckConfig.deckToken), false);
      assert.equal(text.includes(home), false);

      const audioDir = path.join(home, "Library", "Application Support", "CodexQuotaDashboard", "deck", "audio");
      const files = await fs.readdir(audioDir);
      assert.ok(files.includes(`${body.jobId}.wav`));
      assert.ok(files.includes(`${body.jobId}.json`));
      assert.equal(files.some((name) => name.includes("general")), false);
      const metadata = JSON.parse(await fs.readFile(path.join(audioDir, `${body.jobId}.json`), "utf8"));
      assert.equal(metadata.slotId, "general");
      assert.equal(metadata.bytes, wav.length);
      assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(metadata).includes(deckConfig.deckToken), false);
      assert.equal(JSON.stringify(metadata).includes(home), false);

      const publicJob = await fetch(`${localBase(server)}/api/deck/${deckConfig.deckToken}/audio/${body.jobId}`);
      const publicBody = await publicJob.json();
      assert.equal(publicJob.status, 200);
      assert.deepEqual(Object.keys(publicBody), ["jobId", "status", "slotId", "bytes", "durationMs", "sampleRate", "channels", "bitsPerSample", "createdAt", "transcript"]);
      assert.equal(publicBody.durationMs, 1000);
      assert.deepEqual(publicBody.transcript, {
        status: "not_started",
        text: "",
        language: null,
        engine: null,
        confidence: null,
        errorMessage: null,
        createdAt: null,
        updatedAt: null,
      });
    } finally {
      await close(server);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("deck audio upload validates token slot media type size and wav header", async () => {
  const { DeckService, DeckStore } = modules().deck;
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const home = await tempHome();
  try {
    const store = new DeckStore(home);
    const deckConfig = await store.ensureConfig();
    const deckService = new DeckService(store, mockDeckClient());
    const server = createDashboardHttpServer(
      testConfig(),
      provider(normalizeQuotaData(account(), multiBucketLimits(), { now })),
      { deckService },
    );
    await listen(server);
    try {
      const base = localBase(server);
      const wav = makePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
      const url = `${base}/api/deck/${deckConfig.deckToken}/audio/utterance`;
      assert.equal((await postAudio(`${base}/api/deck/bad-token/audio/utterance?slotId=general`, wav)).status, 404);
      assert.equal((await postAudio(url, wav)).status, 400);
      assert.equal((await postAudio(`${url}?slotId=missing`, wav)).status, 404);
      assert.equal((await fetch(`${url}?slotId=general`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: wav })).status, 415);
      assert.equal((await postAudio(`${url}?slotId=general`, Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);

      const invalid = await postAudio(`${url}?slotId=general`, Buffer.from("not a wav"));
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).errorCode, "invalid_wav");

      const riffNotWave = Buffer.from(wav);
      riffNotWave.write("XXXX", 8, "ascii");
      const notWave = await postAudio(`${url}?slotId=general`, riffNotWave);
      assert.equal(notWave.status, 400);
      assert.equal((await notWave.json()).errorCode, "invalid_wav");

      const noData = makePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 1000, omitData: true });
      const missingData = await postAudio(`${url}?slotId=general`, noData);
      assert.equal(missingData.status, 400);
      assert.equal((await missingData.json()).errorCode, "invalid_wav");

      const tooLong = makePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 26000 });
      const tooLongResponse = await postAudio(`${url}?slotId=general`, tooLong);
      assert.equal(tooLongResponse.status, 400);
      assert.equal((await tooLongResponse.json()).errorCode, "too_long");

      assert.equal((await fetch(`${base}/api/deck/${deckConfig.deckToken}/audio/%2e%2e%2fsecret`)).status, 404);
    } finally {
      await close(server);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("deck audio transcription records unconfigured status without leaking paths", async () => {
  const { DeckService, DeckStore } = modules().deck;
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const home = await tempHome();
  try {
    const store = new DeckStore(home);
    const deckConfig = await store.ensureConfig();
    const deckService = new DeckService(store, mockDeckClient());
    const server = createDashboardHttpServer(
      testConfig(),
      provider(normalizeQuotaData(account(), multiBucketLimits(), { now })),
      { deckService },
    );
    await listen(server);
    try {
      const wav = makePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
      const upload = await postAudio(`${localBase(server)}/api/deck/${deckConfig.deckToken}/audio/utterance?slotId=general`, wav);
      const uploaded = await upload.json();

      const response = await fetch(`${localBase(server)}/api/deck/${deckConfig.deckToken}/audio/${uploaded.jobId}/transcribe`, { method: "POST" });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.match(body.jobId, /^stt_job_[a-f0-9]{24}$/);
      assert.equal(body.status, "running");
      assert.equal(body.audioJobId, uploaded.jobId);

      const failed = await waitForPublicJob(deckService, body.jobId, "failed");
      const failedText = JSON.stringify(failed);
      assert.equal(failed.type, "stt");
      assert.equal(failed.audioJobId, uploaded.jobId);
      assert.equal(failed.errorMessage, "STT UNAVAILABLE");
      assert.equal(failedText.includes(home), false);
      assert.equal(failedText.includes(deckConfig.deckToken), false);
      assert.equal(failedText.includes("at stack"), false);

      const metadata = JSON.parse(await fs.readFile(path.join(home, "Library", "Application Support", "CodexQuotaDashboard", "deck", "audio", `${uploaded.jobId}.json`), "utf8"));
      assert.equal(metadata.transcript.status, "failed");
      assert.equal(metadata.transcript.errorMessage, "STT UNAVAILABLE");
    } finally {
      await close(server);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("deck audio transcription can be supplied by a speech adapter", async () => {
  const { DeckService, DeckStore } = modules().deck;
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const home = await tempHome();
  try {
    const store = new DeckStore(home);
    const deckConfig = await store.ensureConfig();
    const speechCalls = [];
    const transcripts = [
      "让 Codex 检查一下 PR 的按键逻辑。",
      "强制重新转写后的文本。",
    ];
    const speechClient = {
      transcribe: async ({ audioJob, wavPath }) => {
        speechCalls.push({ jobId: audioJob.jobId, wavPath });
        return {
          text: transcripts[speechCalls.length - 1] ?? transcripts[0],
          language: "zh",
          engine: "mock-stt",
          confidence: 0.91,
        };
      },
    };
    const deckService = new DeckService(store, mockDeckClient(), speechClient);
    const server = createDashboardHttpServer(
      testConfig(),
      provider(normalizeQuotaData(account(), multiBucketLimits(), { now })),
      { deckService },
    );
    await listen(server);
    try {
      const wav = makePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
      const upload = await postAudio(`${localBase(server)}/api/deck/${deckConfig.deckToken}/audio/utterance?slotId=general`, wav);
      const uploaded = await upload.json();

      const response = await fetch(`${localBase(server)}/api/deck/${deckConfig.deckToken}/audio/${uploaded.jobId}/transcribe`, { method: "POST" });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.match(body.jobId, /^stt_job_[a-f0-9]{24}$/);
      const done = await waitForPublicJob(deckService, body.jobId, "done");
      assert.equal(done.type, "stt");
      assert.equal(done.transcript, "让 Codex 检查一下 PR 的按键逻辑。");
      assert.equal(done.screenTranscript, "让 Codex 检查一下 PR 的按键逻辑。");
      assert.equal(speechCalls.length, 1);
      assert.equal(speechCalls[0].jobId, uploaded.jobId);
      assert.equal(speechCalls[0].wavPath.endsWith(`${uploaded.jobId}.wav`), true);

      const publicJob = await fetch(`${localBase(server)}/api/deck/${deckConfig.deckToken}/audio/${uploaded.jobId}`);
      const publicBody = await publicJob.json();
      assert.equal(publicBody.transcript.status, "done");
      assert.equal(publicBody.transcript.text, "让 Codex 检查一下 PR 的按键逻辑。");

      const reused = await fetch(`${localBase(server)}/api/deck/${deckConfig.deckToken}/audio/${uploaded.jobId}/transcribe`, { method: "POST" });
      const reusedBody = await reused.json();
      assert.equal(reused.status, 200);
      assert.equal(reusedBody.status, "done");
      assert.equal(speechCalls.length, 1);

      const forced = await postJson(`${localBase(server)}/api/deck/${deckConfig.deckToken}/audio/${uploaded.jobId}/transcribe`, {
        language: "zh",
        force: true,
      });
      const forcedBody = await forced.json();
      assert.equal(forced.status, 200);
      assert.match(forcedBody.jobId, /^stt_job_[a-f0-9]{24}$/);
      assert.equal(forcedBody.status, "running");
      const forcedDone = await waitForPublicJob(deckService, forcedBody.jobId, "done");
      assert.equal(forcedDone.transcript, "强制重新转写后的文本。");
      assert.equal(speechCalls.length, 2);
    } finally {
      await close(server);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("deck codex send validates transcript and reuses slot threads", async () => {
  const { DeckService, DeckStore } = modules().deck;
  const { createDashboardHttpServer } = modules().httpServer;
  const { normalizeQuotaData } = modules().normalizer;
  const home = await tempHome();
  try {
    const store = new DeckStore(home);
    const deckConfig = await store.ensureConfig();
    const client = mockDeckClient();
    const deckService = new DeckService(store, client);
    const server = createDashboardHttpServer(
      testConfig(),
      provider(normalizeQuotaData(account(), multiBucketLimits(), { now })),
      { deckService },
    );
    await listen(server);
    try {
      const base = localBase(server);
      const url = `${base}/api/deck/${deckConfig.deckToken}/codex/send`;
      assert.equal((await postJson(`${base}/api/deck/bad-token/codex/send`, { slotId: "general", transcript: "hello" })).status, 404);
      assert.equal((await postJson(url, { transcript: "missing slot" })).status, 400);
      assert.equal((await postJson(url, { slotId: "general" })).status, 400);
      assert.equal((await postJson(url, { slotId: "missing", transcript: "hello" })).status, 404);
      assert.equal((await postJson(url, { slotId: "general", transcript: "x".repeat(4001) })).status, 400);

      const first = await (await postJson(url, {
        slotId: "general",
        transcript: "用三句话解释一下这个小屏下一步应该做什么。",
        sourceAudioJobId: "audio_job_0123456789abcdef01234567",
        sourceSttJobId: "stt_job_0123456789abcdef01234567",
      })).json();
      assert.match(first.jobId, /^codex_job_[a-f0-9]{24}$/);
      const firstDone = await waitForPublicJob(deckService, first.jobId, "done");
      assert.equal(firstDone.type, "codex");
      assert.equal(firstDone.sourceAudioJobId, "audio_job_0123456789abcdef01234567");
      assert.equal(firstDone.sourceSttJobId, "stt_job_0123456789abcdef01234567");

      const second = await (await postJson(url, { slotId: "general", transcript: "第二次发给同一个槽位。" })).json();
      await waitForPublicJob(deckService, second.jobId, "done");
      const third = await (await postJson(url, { slotId: "deck", transcript: "总结 Stage F 验收点。" })).json();
      await waitForPublicJob(deckService, third.jobId, "done");

      const slots = await store.ensureSlots();
      const general = slots.find((slot) => slot.id === "general");
      const deck = slots.find((slot) => slot.id === "deck");
      assert.equal(general.activeThreadId, "thread_general_1");
      assert.equal(deck.activeThreadId, "thread_deck_2");
      assert.equal(client.calls[1].activeThreadId, "thread_general_1");
      assert.notEqual(general.activeThreadId, deck.activeThreadId);

      const firstText = JSON.stringify(firstDone);
      assert.equal(firstText.includes(deckConfig.deckToken), false);
      assert.equal(firstText.includes("auth.json"), false);
      assert.equal(firstText.includes("OpenAI API key"), false);
      assert.equal(firstText.includes("Cookie"), false);
      assert.equal(firstText.includes("OAuth token"), false);
    } finally {
      await close(server);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("deck audio helper scripts list info and play without printing tokens", async () => {
  const home = await tempHome();
  try {
    const audioDir = path.join(home, "Library", "Application Support", "CodexQuotaDashboard", "deck", "audio");
    await fs.mkdir(audioDir, { recursive: true });
    const jobId = "audio_job_0123456789abcdef01234567";
    const metadata = {
      jobId,
      status: "audio_received",
      slotId: "general",
      createdAt: now.toISOString(),
      bytes: 32044,
      sha256: "a".repeat(64),
      wav: { container: "wav", audioFormat: 1, sampleRate: 16000, bitsPerSample: 16, channels: 1, dataSize: 32000, durationMs: 1000 },
    };
    await fs.writeFile(path.join(audioDir, `${jobId}.json`), JSON.stringify(metadata, null, 2));
    await fs.writeFile(path.join(audioDir, `${jobId}.wav`), makePcmWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationMs: 1000 }));

    const env = { ...process.env, HOME: home, PATH: `/tmp:${process.env.PATH}` };
    const list = await execFileText("/bin/bash", ["scripts/deck-audio-list.sh"], { cwd: process.cwd(), env });
    assert.match(list.stdout, new RegExp(jobId));
    assert.equal(list.stdout.includes("token"), false);

    const info = await execFileText("/bin/bash", ["scripts/deck-audio-info.sh", jobId], { cwd: process.cwd(), env });
    assert.match(info.stdout, /"slotId": "general"/);
    assert.equal(info.stdout.includes("test-deck-token"), false);

    const emptyPath = path.join(home, "empty-bin");
    await fs.mkdir(emptyPath);
    const play = await execFileText("/bin/bash", ["scripts/deck-audio-play.sh", jobId], { cwd: process.cwd(), env: { ...env, PATH: emptyPath } }).catch((error) => error);
    assert.notEqual(play.stdout?.includes("test-deck-token"), true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

function testConfig() {
  return {
    bindHost: "127.0.0.1",
    port: 0,
    deviceToken: "test-device-token-12345678901234567890123456789012",
    adminToken: "test-admin-token-12345678901234567890123456789012",
    codexPath: "/bin/false",
    nodePath: process.execPath,
    projectDir: process.cwd(),
    networkInterface: "lo0",
    interfaceMac: "00:00:00:00:00:00",
    meal: {
      enabled: true,
      excelPath: "/tmp/codex-quota-dashboard-test-meal.xlsx",
      updatedAt: now.toISOString(),
    },
    weather: {
      enabled: true,
      provider: "open-meteo",
      locationName: "Hangzhou Yuhang",
      latitude: 30.42,
      longitude: 120.30,
      timezone: "Asia/Shanghai",
      updatedAt: now.toISOString(),
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-deck-test-"));
}

function mockDeckClient(options = {}) {
  let nextThread = 1;
  const calls = [];
  return {
    calls,
    getConnectionStatus: () => "connected",
    runText: async ({ slot, activeThreadId, wrappedPrompt }) => {
      const threadId = activeThreadId ?? `thread_${slot.id}_${nextThread++}`;
      calls.push({ slotId: slot.id, activeThreadId, threadId, wrappedPrompt });
      const fullReply = options.fullReply ?? `mock reply for ${slot.id}`;
      return {
        threadId,
        screenReply: fullReply,
        fullReply,
        status: "done",
      };
    },
  };
}

function failingDeckClient() {
  return {
    getConnectionStatus: () => "connected",
    runText: async () => {
      throw new Error("failed with auth.json OpenAI API key Cookie OAuth token\n    at stack line");
    },
  };
}

async function waitForPublicJob(service, jobId, expectedStatus) {
  const deadline = Date.now() + 2000;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await service.getPublicJob(jobId);
    if (latest?.status === expectedStatus) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`job ${jobId} did not reach ${expectedStatus}; latest=${JSON.stringify(latest)}`);
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postAudio(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body,
  });
}

function makePcmWav({ sampleRate, channels, bitsPerSample, durationMs, omitData = false }) {
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = Math.floor(sampleRate * channels * bytesPerSample * durationMs / 1000);
  const chunks = [];
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * channels * bytesPerSample, 16);
  fmt.writeUInt16LE(channels * bytesPerSample, 20);
  fmt.writeUInt16LE(bitsPerSample, 22);
  chunks.push(fmt);
  if (!omitData) {
    const dataHeader = Buffer.alloc(8);
    dataHeader.write("data", 0, "ascii");
    dataHeader.writeUInt32LE(dataSize, 4);
    chunks.push(dataHeader, Buffer.alloc(dataSize));
  }
  const riffSize = chunks.reduce((sum, chunk) => sum + chunk.length, 4);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(riffSize, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, ...chunks]);
}

function execFileText(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function findFiles(dir, predicate) {
  const found = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (predicate(fullPath)) {
        found.push(fullPath);
      }
    }
  }
  await walk(dir);
  return found;
}

function mockWeatherFetch() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const value = String(url);
    if (value.includes("air-quality-api.open-meteo.com")) {
      return new Response(JSON.stringify({
        current: {
          pm2_5: 18,
          pm10: 30,
          uv_index: 4.5,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (value.includes("api.open-meteo.com")) {
      return new Response(JSON.stringify({
        current: {
          temperature_2m: 31,
          apparent_temperature: 35,
          relative_humidity_2m: 72,
          precipitation: 1.2,
          weather_code: 61,
          pressure_msl: 1006,
          wind_speed_10m: 12,
          wind_direction_10m: 90,
          cloud_cover: 76,
          visibility: 12300,
        },
        hourly: {
          time: ["2026-06-24T14:00", "2026-06-24T15:00", "2026-06-24T16:00", "2026-06-24T17:00", "2026-06-24T18:00", "2026-06-24T19:00"],
          temperature_2m: [31, 31, 30, 29, 28, 27],
          precipitation_probability: [80, 70, 60, 40, 20, 20],
          precipitation: [1.2, 0.8, 0.3, 0, 0, 0],
          weather_code: [61, 61, 3, 2, 1, 1],
        },
        daily: {
          time: ["2026-06-24", "2026-06-25", "2026-06-26"],
          weather_code: [61, 3, 0],
          temperature_2m_max: [33, 34, 35],
          temperature_2m_min: [26, 27, 28],
          precipitation_probability_max: [80, 30, 10],
          precipitation_sum: [12.5, 0.5, 0],
          sunrise: ["2026-06-24T05:02", "2026-06-25T05:02", "2026-06-26T05:03"],
          sunset: ["2026-06-24T19:05", "2026-06-25T19:05", "2026-06-26T19:06"],
          uv_index_max: [7.2, 8, 9],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (value.includes("api.caiyunapp.com")) {
      assert.equal(value.includes("test-caiyun-token-keep-private"), true);
      return new Response(JSON.stringify({
        status: "ok",
        api_version: "v2.6",
        timezone: "Asia/Shanghai",
        result: {
          realtime: {
            temperature: 30.2,
            apparent_temperature: 34.1,
            humidity: 0.68,
            skycon: "LIGHT_RAIN",
            pressure: 100520,
            wind: { speed: 11.6, direction: 80 },
            visibility: 18.6,
            cloudrate: 0.82,
            precipitation: {
              local: { intensity: 0.8 },
              nearest: { distance: 2.4, intensity: 0.2 },
            },
            air_quality: { pm25: 20, pm10: 28, aqi: { chn: 46 } },
            life_index: { ultraviolet: { index: 3.4, desc: "弱" }, comfort: { index: 4, desc: "温暖" } },
          },
          hourly: {
            precipitation: [
              { datetime: "2026-06-24T14:00+08:00", value: 0.8, probability: 70 },
              { datetime: "2026-06-24T15:00+08:00", value: 0.5, probability: 60 },
              { datetime: "2026-06-24T16:00+08:00", value: 0.1, probability: 30 },
              { datetime: "2026-06-24T17:00+08:00", value: 0, probability: 10 },
              { datetime: "2026-06-24T18:00+08:00", value: 0, probability: 10 },
              { datetime: "2026-06-24T19:00+08:00", value: 0, probability: 5 },
            ],
            temperature: [
              { datetime: "2026-06-24T14:00+08:00", value: 30 },
              { datetime: "2026-06-24T15:00+08:00", value: 31 },
              { datetime: "2026-06-24T16:00+08:00", value: 31 },
              { datetime: "2026-06-24T17:00+08:00", value: 30 },
              { datetime: "2026-06-24T18:00+08:00", value: 29 },
              { datetime: "2026-06-24T19:00+08:00", value: 28 },
            ],
            skycon: [
              { datetime: "2026-06-24T14:00+08:00", value: "LIGHT_RAIN" },
              { datetime: "2026-06-24T15:00+08:00", value: "LIGHT_RAIN" },
              { datetime: "2026-06-24T16:00+08:00", value: "CLOUDY" },
              { datetime: "2026-06-24T17:00+08:00", value: "PARTLY_CLOUDY_DAY" },
              { datetime: "2026-06-24T18:00+08:00", value: "CLEAR_DAY" },
              { datetime: "2026-06-24T19:00+08:00", value: "CLEAR_NIGHT" },
            ],
          },
          daily: {
            astro: [
              { date: "2026-06-24T00:00+08:00", sunrise: { time: "05:02" }, sunset: { time: "19:05" } },
            ],
            precipitation: [
              { date: "2026-06-24T00:00+08:00", avg: 1.2, probability: 80 },
              { date: "2026-06-25T00:00+08:00", avg: 0.3, probability: 30 },
              { date: "2026-06-26T00:00+08:00", avg: 0, probability: 10 },
            ],
            temperature: [
              { date: "2026-06-24T00:00+08:00", max: 34, min: 25 },
              { date: "2026-06-25T00:00+08:00", max: 35, min: 26 },
              { date: "2026-06-26T00:00+08:00", max: 36, min: 27 },
            ],
            skycon: [
              { date: "2026-06-24T00:00+08:00", value: "LIGHT_RAIN" },
              { date: "2026-06-25T00:00+08:00", value: "CLOUDY" },
              { date: "2026-06-26T00:00+08:00", value: "CLEAR_DAY" },
            ],
            life_index: {
              ultraviolet: [{ date: "2026-06-24T00:00+08:00", index: "5", desc: "中等" }],
              dressing: [{ date: "2026-06-24T00:00+08:00", index: "3", desc: "热" }],
              coldRisk: [{ date: "2026-06-24T00:00+08:00", index: "2", desc: "较低" }],
            },
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url, init);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

function provider(data) {
  return {
    getData: () => data,
    getHealth: () => ({
      ok: true,
      appServerConnected: true,
      cacheFresh: true,
      lastSuccessAt: data.lastSuccessAt,
      currentTime: now.toISOString(),
      timezone: data.timezone,
      warning: null,
    }),
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function localBase(server) {
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}
