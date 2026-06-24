export interface DashboardConfig {
  bindHost: string;
  port: number;
  deviceToken: string;
  codexPath: string;
  nodePath: string;
  projectDir: string;
  networkInterface: string;
  interfaceMac: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedQuotaWindow {
  limitId: string;
  limitName: string | null;
  sourceBucket: string;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
  resetAbsoluteText: string;
  resetRelativeText: string;
  planType: string | null;
  reached: boolean;
  displayName: string;
  windowKind: "five_hour" | "weekly" | "other";
}

export interface SanitizedDashboardData {
  version: 1;
  planType: string | null;
  windows: NormalizedQuotaWindow[];
  displayWindows: NormalizedQuotaWindow[];
  resetCreditAvailableCount: number | null;
  usage: NormalizedUsageSummary | null;
  lastSuccessAt: string | null;
  generatedAt: string;
  timezone: string;
  usingCache: boolean;
  stale: boolean;
  appServerConnected: boolean;
  statusText: string;
}

export interface NormalizedUsageSummary {
  totalTokens: number | null;
  totalTokensText: string;
  todayTokens: number | null;
  todayTokensText: string;
  peakDailyTokens: number | null;
  peakDailyTokensText: string;
  todayDate: string;
}

export interface HealthStatus {
  ok: boolean;
  appServerConnected: boolean;
  cacheFresh: boolean;
  lastSuccessAt: string | null;
  currentTime: string;
  timezone: string;
  warning: string | null;
}

export interface NetworkInfo {
  interfaceName: string;
  ipv4: string;
  mac: string;
}

export interface DeviceQuotaWindow {
  key: "five_hour" | "weekly" | "other";
  title: string;
  remainingPercent: number;
  resetsAt: number | null;
  resetText: string;
}

export interface DeviceDashboardPayload {
  schemaVersion: 1;
  generatedAt: number;
  plan: string;
  status: "fresh" | "cached" | "stale";
  usage?: DeviceUsageSummary;
  windows: DeviceQuotaWindow[];
}

export interface DeviceUsageSummary {
  totalTokensText: string;
  todayTokensText: string;
}
