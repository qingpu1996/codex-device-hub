import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DashboardConfig, SanitizedDashboardData } from "./types";
import { JsonRpcStdioClient, type JsonRpcNotification } from "./jsonRpc";
import { loadCachedData, saveCachedData } from "./cache";
import { markCachedData, normalizeQuotaData } from "./normalizer";
import { redactLogLine, sleep } from "./util";

const POLL_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

export class CodexAppServerMonitor extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private client: JsonRpcStdioClient | null = null;
  private data: SanitizedDashboardData | null = null;
  private connected = false;
  private stopping = false;
  private starting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private backoffMs = 1_000;
  private lastError: string | null = null;

  constructor(private readonly config: DashboardConfig) {
    super();
  }

  async start(): Promise<void> {
    const cached = await loadCachedData().catch((error) => {
      this.log(`cache load failed: ${redactLogLine(String(error))}`);
      return null;
    });
    if (cached) {
      this.data = markCachedData(cached, { appServerConnected: false });
    }
    this.scheduleReconnect(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.client?.dispose();
    this.client = null;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      await sleep(500);
      if (!this.child.killed) {
        this.child.kill("SIGKILL");
      }
    }
    this.child = null;
    this.connected = false;
  }

  getData(): SanitizedDashboardData | null {
    if (!this.data) {
      return null;
    }
    if (!this.connected) {
      return markCachedData(this.data, { appServerConnected: false, statusText: this.lastError ?? undefined });
    }
    return this.data;
  }

  getStatus(): { connected: boolean; lastSuccessAt: string | null; lastError: string | null; hasData: boolean } {
    return {
      connected: this.connected,
      lastSuccessAt: this.data?.lastSuccessAt ?? null,
      lastError: this.lastError,
      hasData: Boolean(this.data),
    };
  }

  async requestAppServer(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.client || !this.connected) {
      throw new Error("Codex App Server is disconnected");
    }
    return this.client.request(method, params, timeoutMs);
  }

  async refreshNow(): Promise<void> {
    await this.refreshSnapshot();
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopping || this.reconnectTimer || this.starting || this.child) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, delayMs);
  }

  private async connectOnce(): Promise<void> {
    if (this.stopping || this.starting || this.child) {
      return;
    }
    this.starting = true;

    try {
      this.child = spawn(this.config.codexPath, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
      });

      this.child.on("exit", (code, signal) => this.handleExit(code, signal));
      this.child.on("error", (error) => {
        this.lastError = `App Server 启动失败: ${redactLogLine(error.message)}`;
        this.log(this.lastError);
      });

      this.client = new JsonRpcStdioClient(this.child.stdin, this.child.stdout, this.child.stderr, {
        defaultTimeoutMs: REQUEST_TIMEOUT_MS,
      });
      this.client.on("stderr", (line) => this.log(`app-server stderr: ${line}`));
      this.client.on("notification", (notification: JsonRpcNotification) => this.handleNotification(notification));
      this.client.on("protocolError", (error) => this.log(`protocol error: ${redactLogLine(String(error))}`));

      await this.initialize();
      this.connected = true;
      this.lastError = null;
      this.backoffMs = 1_000;
      await this.refreshSnapshot();
      this.schedulePoll();
    } catch (error) {
      this.lastError = `App Server 暂不可用，显示最后一次成功缓存`;
      this.log(`connect failed: ${redactLogLine(String(error))}`);
      this.cleanupChild();
      this.scheduleReconnect(this.nextBackoff());
    } finally {
      this.starting = false;
    }
  }

  private async initialize(): Promise<void> {
    if (!this.client) {
      throw new Error("JSON-RPC client not available");
    }
    await this.client.request(
      "initialize",
      {
        clientInfo: {
          name: "codex_quota_dashboard",
          title: "Codex Quota Dashboard",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [
            "thread/started",
            "turn/started",
            "item/started",
            "rawResponseItem/completed",
          ],
        },
      },
      REQUEST_TIMEOUT_MS,
    );
    this.client.notify("initialized");
  }

  private async refreshSnapshot(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.doRefreshSnapshot().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefreshSnapshot(): Promise<void> {
    if (!this.client) {
      throw new Error("JSON-RPC client not available");
    }
    const account = await this.client.request("account/read", { refreshToken: false }, REQUEST_TIMEOUT_MS);
    const limits = await this.client.request("account/rateLimits/read", undefined, REQUEST_TIMEOUT_MS);
    let usage: unknown = null;
    try {
      usage = await this.client.request("account/usage/read", undefined, REQUEST_TIMEOUT_MS);
    } catch (error) {
      this.log(`usage read failed: ${redactLogLine(String(error))}`);
    }
    const normalized = normalizeQuotaData(account, limits, { appServerConnected: true, usageResponse: usage });
    this.data = normalized;
    await saveCachedData(normalized);
    this.emit("updated", normalized);
  }

  private schedulePoll(): void {
    if (this.pollTimer || this.stopping) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      if (this.stopping || !this.connected) {
        return;
      }
      try {
        await this.refreshSnapshot();
      } catch (error) {
        this.lastError = "App Server 同步失败，显示最后一次成功缓存";
        this.log(`poll failed: ${redactLogLine(String(error))}`);
      } finally {
        this.schedulePoll();
      }
    }, POLL_INTERVAL_MS);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    this.emit("notification", notification);
    if (notification.method === "account/rateLimits/updated") {
      void this.refreshSnapshot().catch((error) => {
        this.lastError = "App Server 通知同步失败，显示最后一次成功缓存";
        this.log(`notification refresh failed: ${redactLogLine(String(error))}`);
      });
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopping) {
      return;
    }
    this.log(`app-server exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
    this.connected = false;
    this.cleanupChild();
    this.lastError = "App Server 已退出，显示最后一次成功缓存";
    this.scheduleReconnect(this.nextBackoff());
  }

  private cleanupChild(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.client?.dispose();
    this.client = null;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = null;
    this.connected = false;
  }

  private nextBackoff(): number {
    const current = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    return current;
  }

  private log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    process.stderr.write(`${line}\n`);
    this.emit("log", line);
  }
}
