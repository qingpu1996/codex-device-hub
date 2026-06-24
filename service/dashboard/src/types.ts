export interface DashboardConfig {
  bindHost: string;
  port: number;
  deviceToken: string;
  adminToken: string;
  codexPath: string;
  nodePath: string;
  projectDir: string;
  networkInterface: string;
  interfaceMac: string;
  meal: MealConfig;
  weather: WeatherConfig;
  createdAt: string;
  updatedAt: string;
}

export interface MealConfig {
  enabled: boolean;
  excelPath: string;
  updatedAt: string;
}

export type WeatherProvider = "open-meteo" | "caiyun-v2.6";

export interface WeatherConfig {
  enabled: boolean;
  provider: WeatherProvider;
  locationName: string;
  latitude: number;
  longitude: number;
  timezone: string;
  caiyunToken?: string;
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

export interface DeviceWeatherPayload {
  schemaVersion: 1;
  generatedAt: number;
  status: "fresh" | "cached" | "stale" | "not_configured";
  source: WeatherProvider;
  location: string;
  timezone: string;
  slot: number;
  slotCount: number;
  current: DeviceWeatherCurrent;
  today: DeviceWeatherToday;
  details: DeviceWeatherDetails;
  hourly: DeviceWeatherHour[];
  daily: DeviceWeatherDay[];
}

export interface DeviceWeatherCurrent {
  tempC: number | null;
  feelsLikeC: number | null;
  humidityPercent: number | null;
  condition: string;
  icon: string;
  weatherCode: number | null;
  windKph: number | null;
  windDirectionDeg: number | null;
  windText: string;
  pressureHpa: number | null;
  precipMm: number | null;
  pm25: number | null;
  pm10: number | null;
  uvIndex: number | null;
}

export interface DeviceWeatherToday {
  highC: number | null;
  lowC: number | null;
  precipProbPercent: number | null;
  precipMm: number | null;
  sunriseText: string;
  sunsetText: string;
  uvIndexMax: number | null;
}

export interface DeviceWeatherDetails {
  aqiChn: number | null;
  visibilityKm: number | null;
  cloudPercent: number | null;
  localRainIntensity: number | null;
  nearestRainDistanceKm: number | null;
  nearestRainIntensity: number | null;
  comfortIndex: number | null;
  dressingIndex: number | null;
  coldRiskIndex: number | null;
}

export interface DeviceWeatherHour {
  timeText: string;
  tempC: number | null;
  precipProbPercent: number | null;
  precipMm: number | null;
  condition: string;
  icon: string;
  weatherCode: number | null;
}

export interface DeviceWeatherDay {
  dayText: string;
  highC: number | null;
  lowC: number | null;
  precipProbPercent: number | null;
  precipMm: number | null;
  condition: string;
  icon: string;
  weatherCode: number | null;
}
