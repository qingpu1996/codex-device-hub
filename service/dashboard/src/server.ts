import type { Server } from "node:http";
import { loadConfig } from "./cache";
import { CodexAppServerMonitor } from "./codexAppServer";
import { createDashboardHttpServer } from "./httpServer";
import { detectDefaultNetwork, isIpAssigned } from "./network";
import type { HealthStatus } from "./types";
import { sleep } from "./util";

const NETWORK_RETRY_MS = 5_000;
const FRESH_AFTER_MS = 150_000;

async function main(): Promise<void> {
  const config = await loadConfig();
  const monitor = new CodexAppServerMonitor(config);
  await monitor.start();

  const healthProvider = {
    getData: () => monitor.getData(),
    getHealth: (): HealthStatus => {
      const status = monitor.getStatus();
      const lastSuccessMs = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : 0;
      const cacheFresh = lastSuccessMs > 0 && Date.now() - lastSuccessMs <= FRESH_AFTER_MS;
      return {
        ok: true,
        appServerConnected: status.connected,
        cacheFresh,
        lastSuccessAt: status.lastSuccessAt,
        currentTime: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Local",
        warning: status.lastError,
      };
    },
  };

  let server: Server | null = null;

  const shutdown = async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    await monitor.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  for (;;) {
    await warnOnIpMismatch(config.bindHost);
    if (!isIpAssigned(config.bindHost)) {
      process.stderr.write(
        `[${new Date().toISOString()}] configured IP ${config.bindHost} is not assigned; retrying in ${NETWORK_RETRY_MS / 1000}s\n`,
      );
      await sleep(NETWORK_RETRY_MS);
      continue;
    }

    server = createDashboardHttpServer(config, healthProvider);
    try {
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(config.port, config.bindHost, () => resolve());
      });
      process.stdout.write(
        `[${new Date().toISOString()}] Codex quota dashboard listening on http://${config.bindHost}:${config.port}/api/device/[token]\n`,
      );
      break;
    } catch (error) {
      process.stderr.write(`[${new Date().toISOString()}] HTTP listen failed: ${String(error)}\n`);
      await new Promise<void>((resolve) => server!.close(() => resolve())).catch(() => undefined);
      server = null;
      await sleep(NETWORK_RETRY_MS);
    }
  }
}

async function warnOnIpMismatch(configuredIp: string): Promise<void> {
  try {
    const current = await detectDefaultNetwork();
    if (current.ipv4 !== configuredIp) {
      process.stderr.write(
        `[${new Date().toISOString()}] WARNING: configured bindHost ${configuredIp} differs from current default LAN IPv4 ${current.ipv4} on ${current.interfaceName}; run scripts/update-lan-ip.sh if you want to change the device API URL.\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`[${new Date().toISOString()}] WARNING: default network detection failed: ${String(error)}\n`);
  }
}

void main().catch((error) => {
  process.stderr.write(`[${new Date().toISOString()}] fatal: ${String(error)}\n`);
  process.exit(1);
});
