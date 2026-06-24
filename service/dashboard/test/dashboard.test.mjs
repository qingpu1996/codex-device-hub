import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function modules() {
  return {
    jsonl: require("../dist/src/jsonl.js"),
    jsonRpc: require("../dist/src/jsonRpc.js"),
    normalizer: require("../dist/src/normalizer.js"),
    httpServer: require("../dist/src/httpServer.js"),
    devicePayload: require("../dist/src/devicePayload.js"),
    mealPlan: require("../dist/src/mealPlan.js"),
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
  const server = createDashboardHttpServer(config, provider(normalizeQuotaData(account("pro"), multiBucketLimits(), { now })));
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

function testConfig() {
  return {
    bindHost: "127.0.0.1",
    port: 0,
    deviceToken: "test-device-token-12345678901234567890123456789012",
    codexPath: "/bin/false",
    nodePath: process.execPath,
    projectDir: process.cwd(),
    networkInterface: "lo0",
    interfaceMac: "00:00:00:00:00:00",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
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
