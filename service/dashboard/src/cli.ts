import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWeatherConfig, loadConfig, saveConfig, generateDeviceToken, ensureAppSupportDir, normalizeWeatherConfig } from "./cache";
import { detectDefaultNetwork } from "./network";
import { configPath, launchAgentPath, logsDir, LABEL } from "./paths";
import type { DashboardConfig } from "./types";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "detect-network":
      console.log(JSON.stringify(await detectDefaultNetwork(), null, 2));
      return;
    case "ensure-config":
      await ensureConfig(args);
      return;
    case "status":
      await printStatus();
      return;
    case "update-lan-ip":
      await updateLanIp();
      return;
    case "print-device-url":
      await printDeviceUrl();
      return;
    case "regenerate-device-token":
      await regenerateDeviceToken();
      return;
    case "write-plist":
      await writePlistCommand(args);
      return;
    case "healthcheck":
      await healthcheck();
      return;
    default:
      throw new Error(`Unknown command: ${command ?? "(missing)"}`);
  }
}

async function ensureConfig(args: Map<string, string>): Promise<void> {
  const bindHost = required(args, "bind-host");
  const port = Number(required(args, "port"));
  const codexPath = required(args, "codex-path");
  const nodePath = required(args, "node-path");
  const projectDir = required(args, "project-dir");
  const networkInterface = required(args, "network-interface");
  const interfaceMac = required(args, "interface-mac");

  let existing: DashboardConfig | null = null;
  try {
    existing = await loadConfig();
  } catch {
    existing = null;
  }

  const now = new Date().toISOString();
  const config: DashboardConfig = {
    bindHost: existing?.bindHost ?? bindHost,
    port: existing?.port ?? port,
    deviceToken: existing?.deviceToken ?? generateDeviceToken(),
    adminToken: existing?.adminToken ?? generateDeviceToken(),
    codexPath,
    nodePath,
    projectDir,
    networkInterface: existing?.networkInterface ?? networkInterface,
    interfaceMac: existing?.interfaceMac ?? interfaceMac,
    weather: existing?.weather ? normalizeWeatherConfig(existing.weather, now) : defaultWeatherConfig(now),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await saveConfig(config);
  if (existing && existing.bindHost !== bindHost) {
    console.error(
      `WARNING: existing config keeps bindHost ${existing.bindHost}; current default LAN IPv4 is ${bindHost}. Run scripts/update-lan-ip.sh to change the device API URL.`,
    );
  }
  printConfigSummary(config);
}

async function printDeviceUrl(): Promise<void> {
  const config = await loadConfig();
  console.log(`http://${config.bindHost}:${config.port}/api/device/${config.deviceToken}`);
}

async function printStatus(): Promise<void> {
  const config = await loadConfig();
  let network = null;
  try {
    network = await detectDefaultNetwork();
  } catch (error) {
    console.log(`network_detection_error=${String(error)}`);
  }

  console.log(`label=${LABEL}`);
  console.log(`config=${configPath()}`);
  console.log(`configured_ip=${config.bindHost}`);
  console.log(`configured_port=${config.port}`);
  console.log(`configured_interface=${config.networkInterface}`);
  console.log(`configured_mac=${config.interfaceMac}`);
  if (network) {
    console.log(`current_interface=${network.interfaceName}`);
    console.log(`current_ip=${network.ipv4}`);
    console.log(`current_mac=${network.mac}`);
    if (network.ipv4 !== config.bindHost) {
      console.log(`warning=configured_ip_differs_from_current_ip`);
    }
  }
  console.log(`device_url=http://${config.bindHost}:${config.port}/api/device/${config.deviceToken}`);
  console.log(`admin_config_url=http://${config.bindHost}:${config.port}/admin/${config.adminToken}/config`);
  console.log(`weather_location=${config.weather.locationName}`);
  console.log(`weather_provider=${config.weather.provider}`);
  console.log(`weather_caiyun_token=${config.weather.caiyunToken ? "configured" : "missing"}`);

  try {
    const health = await fetch(`http://${config.bindHost}:${config.port}/healthz`, { cache: "no-store" });
    console.log(`health_http=${health.status}`);
    console.log(await health.text());
  } catch (error) {
    console.log(`health_error=${String(error)}`);
  }
}

async function updateLanIp(): Promise<void> {
  const config = await loadConfig();
  const network = await detectDefaultNetwork();
  const oldUrl = `http://${config.bindHost}:${config.port}/api/device/${config.deviceToken}`;
  config.bindHost = network.ipv4;
  config.networkInterface = network.interfaceName;
  config.interfaceMac = network.mac;
  config.updatedAt = new Date().toISOString();
  await saveConfig(config);
  const newUrl = `http://${config.bindHost}:${config.port}/api/device/${config.deviceToken}`;
  console.log(`old_url=${oldUrl}`);
  console.log(`new_url=${newUrl}`);
  console.log(`interface=${network.interfaceName}`);
  console.log(`ipv4=${network.ipv4}`);
  console.log(`mac=${network.mac}`);
}

async function regenerateDeviceToken(): Promise<void> {
  const config = await loadConfig();
  config.deviceToken = generateDeviceToken();
  config.updatedAt = new Date().toISOString();
  await saveConfig(config);
  console.log(`new_device_url=http://${config.bindHost}:${config.port}/api/device/${config.deviceToken}`);
}

async function writePlistCommand(args: Map<string, string>): Promise<void> {
  const plist = required(args, "plist");
  const nodePath = required(args, "node");
  const entry = required(args, "entry");
  const projectDir = required(args, "project");
  const home = required(args, "home");
  const pathEnv = required(args, "path");
  const stdout = required(args, "stdout");
  const stderr = required(args, "stderr");

  await fs.mkdir(path.dirname(plist), { recursive: true });
  await fs.mkdir(path.dirname(stdout), { recursive: true });
  await fs.mkdir(path.dirname(stderr), { recursive: true });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(entry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderr)}</string>
</dict>
</plist>
`;

  await fs.writeFile(plist, xml, { mode: 0o644 });
  console.log(`plist=${plist}`);
}

async function healthcheck(): Promise<void> {
  const config = await loadConfig();
  const response = await fetch(`http://${config.bindHost}:${config.port}/healthz`, { cache: "no-store" });
  console.log(`health_http=${response.status}`);
  console.log(await response.text());
  if (!response.ok) {
    process.exitCode = 1;
  }
}

function printConfigSummary(config: DashboardConfig): void {
  console.log(`config=${configPath()}`);
  console.log(`cache_dir=${path.dirname(configPath())}`);
  console.log(`device_url=http://${config.bindHost}:${config.port}/api/device/${config.deviceToken}`);
  console.log(`admin_config_url=http://${config.bindHost}:${config.port}/admin/${config.adminToken}/config`);
  console.log(`weather_location=${config.weather.locationName}`);
  console.log(`weather_provider=${config.weather.provider}`);
  console.log(`weather_caiyun_token=${config.weather.caiyunToken ? "configured" : "missing"}`);
}

function parseArgs(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      result.set(key, "true");
    } else {
      result.set(key, next);
      index += 1;
    }
  }
  return result;
}

function required(args: Map<string, string>, key: string): string {
  const value = args.get(key);
  if (!value) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

void ensureAppSupportDir()
  .then(() => main())
  .catch((error) => {
    console.error(String(error));
    process.exit(1);
  });

export { launchAgentPath, logsDir };
