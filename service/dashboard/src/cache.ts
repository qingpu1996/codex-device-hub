import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { DashboardConfig, MealConfig, SanitizedDashboardData, WeatherConfig } from "./types";
import { appSupportDir, cachePath, configPath } from "./paths";
import { safeJsonParse } from "./util";
import { mealExcelPath, MEAL_EXCEL_DEFAULT_PATH } from "./mealPlan";

export async function ensureAppSupportDir(home?: string): Promise<string> {
  const dir = appSupportDir(home);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  return dir;
}

export async function loadConfig(home?: string): Promise<DashboardConfig> {
  const text = await fs.readFile(configPath(home), "utf8");
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid config.json");
  }
  const config = parsed as DashboardConfig;
  let changed = false;
  if (!config.deviceToken) {
    config.deviceToken = generateDeviceToken();
    changed = true;
  }
  if (!config.adminToken) {
    config.adminToken = generateDeviceToken();
    changed = true;
  }
  if (!config.meal) {
    config.meal = defaultMealConfig(config.updatedAt ?? new Date().toISOString());
    changed = true;
  } else {
    const upgraded = normalizeMealConfig(config.meal, config.updatedAt ?? new Date().toISOString());
    if (JSON.stringify(upgraded) !== JSON.stringify(config.meal)) {
      config.meal = upgraded;
      changed = true;
    }
  }
  if (!config.weather) {
    config.weather = defaultWeatherConfig(config.updatedAt ?? new Date().toISOString());
    changed = true;
  } else {
    const upgraded = normalizeWeatherConfig(config.weather, config.updatedAt ?? new Date().toISOString());
    if (JSON.stringify(upgraded) !== JSON.stringify(config.weather)) {
      config.weather = upgraded;
      changed = true;
    }
  }
  if (changed) {
    config.updatedAt = new Date().toISOString();
    await saveConfig(config, home);
  }
  return config;
}

export async function saveConfig(config: DashboardConfig, home?: string): Promise<void> {
  await ensureAppSupportDir(home);
  const file = configPath(home);
  await writeJsonPrivate(file, config);
}

export async function loadCachedData(home?: string): Promise<SanitizedDashboardData | null> {
  try {
    const text = await fs.readFile(cachePath(home), "utf8");
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as SanitizedDashboardData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveCachedData(data: SanitizedDashboardData, home?: string): Promise<void> {
  await ensureAppSupportDir(home);
  await writeJsonPrivate(cachePath(home), data);
}

export function generateDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

export function defaultWeatherConfig(updatedAt = new Date().toISOString()): WeatherConfig {
  return {
    enabled: true,
    provider: "open-meteo",
    locationName: "Hangzhou Yuhang",
    latitude: 30.42,
    longitude: 120.30,
    timezone: "Asia/Shanghai",
    updatedAt,
  };
}

export function defaultMealConfig(updatedAt = new Date().toISOString()): MealConfig {
  return {
    enabled: true,
    excelPath: mealExcelPath(),
    updatedAt,
  };
}

export function normalizeMealConfig(input: Partial<MealConfig>, updatedAt = new Date().toISOString()): MealConfig {
  return {
    enabled: input.enabled !== false,
    excelPath: typeof input.excelPath === "string" && input.excelPath.trim() ? input.excelPath.trim().slice(0, 512) : MEAL_EXCEL_DEFAULT_PATH,
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt ? input.updatedAt : updatedAt,
  };
}

export function normalizeWeatherConfig(input: Partial<WeatherConfig>, updatedAt = new Date().toISOString()): WeatherConfig {
  const latitude = typeof input.latitude === "number" && Number.isFinite(input.latitude) ? input.latitude : 30.42;
  const longitude = typeof input.longitude === "number" && Number.isFinite(input.longitude) ? input.longitude : 120.30;
  const provider = input.provider === "caiyun-v2.6" ? "caiyun-v2.6" : "open-meteo";
  const caiyunToken = typeof input.caiyunToken === "string" ? input.caiyunToken.trim().slice(0, 256) : "";
  return {
    enabled: input.enabled !== false,
    provider,
    locationName: typeof input.locationName === "string" && input.locationName.trim() ? input.locationName.trim().slice(0, 48) : "Hangzhou Yuhang",
    latitude: clampCoordinate(latitude, -90, 90),
    longitude: clampCoordinate(longitude, -180, 180),
    timezone: typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim().slice(0, 48) : "Asia/Shanghai",
    ...(caiyunToken ? { caiyunToken } : {}),
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt ? input.updatedAt : updatedAt,
  };
}

function clampCoordinate(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value * 10000) / 10000));
}

export async function writeJsonPrivate(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}
