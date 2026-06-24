import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { DashboardConfig, SanitizedDashboardData } from "./types";
import { appSupportDir, cachePath, configPath } from "./paths";
import { safeJsonParse } from "./util";

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
  if (!config.deviceToken) {
    config.deviceToken = generateDeviceToken();
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

export async function writeJsonPrivate(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}
