import type {
  DeviceWeatherDay,
  DeviceWeatherDetails,
  DeviceWeatherHour,
  DeviceWeatherPayload,
  WeatherConfig,
} from "./types";

const WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;
const WEATHER_STALE_TTL_MS = 6 * 60 * 60 * 1000;
const WEATHER_FETCH_TIMEOUT_MS = 8000;
export const WEATHER_SLOT_COUNT = 3;
export const WEATHER_MAX_RESPONSE_BYTES = 8192;

interface WeatherCacheEntry {
  key: string;
  payload: DeviceWeatherPayload;
  fetchedAtMs: number;
}

let cache: WeatherCacheEntry | null = null;

export async function getDeviceWeatherPayload(config: WeatherConfig, requestedSlot = 1, now = new Date()): Promise<DeviceWeatherPayload> {
  const slot = normalizeSlot(requestedSlot);
  const generatedAt = Math.floor(now.getTime() / 1000);
  if (!config.enabled) {
    return emptyWeatherPayload(config, slot, "not_configured", generatedAt);
  }
  if (config.provider === "caiyun-v2.6" && !config.caiyunToken) {
    return emptyWeatherPayload(config, slot, "not_configured", generatedAt);
  }

  const key = weatherCacheKey(config);
  if (cache && cache.key === key && now.getTime() - cache.fetchedAtMs < WEATHER_CACHE_TTL_MS) {
    return withRequestFields(cache.payload, slot, generatedAt, "cached");
  }

  try {
    const payload = config.provider === "caiyun-v2.6"
      ? await fetchCaiyunPayload(config, slot, generatedAt)
      : await fetchOpenMeteoPayload(config, slot, generatedAt);
    cache = { key, payload, fetchedAtMs: now.getTime() };
    return payload;
  } catch (error) {
    if (cache && cache.key === key && now.getTime() - cache.fetchedAtMs < WEATHER_STALE_TTL_MS) {
      return withRequestFields(cache.payload, slot, generatedAt, "stale");
    }
    return emptyWeatherPayload(config, slot, "stale", generatedAt);
  }
}

async function fetchCaiyunPayload(config: WeatherConfig, slot: number, generatedAt: number): Promise<DeviceWeatherPayload> {
  const data = await fetchJson(caiyunWeatherUrl(config));
  if (data.status !== "ok" || !data.result) {
    throw new Error("caiyun weather status not ok");
  }

  const realtime = data.result.realtime ?? {};
  const hourly = data.result.hourly ?? {};
  const daily = data.result.daily ?? {};
  const currentCondition = conditionFromCaiyunSkycon(typeof realtime.skycon === "string" ? realtime.skycon : null);

  return {
    schemaVersion: 1,
    generatedAt,
    status: "fresh",
    source: "caiyun-v2.6",
    location: safeLabel(config.locationName, "Hangzhou Yuhang", 48),
    timezone: safeLabel(data.timezone ?? config.timezone, "Asia/Shanghai", 48),
    slot,
    slotCount: WEATHER_SLOT_COUNT,
    current: {
      tempC: roundOrNull(realtime.temperature),
      feelsLikeC: roundOrNull(realtime.apparent_temperature),
      humidityPercent: percentOrNull(realtime.humidity),
      condition: currentCondition.label,
      icon: currentCondition.icon,
      weatherCode: null,
      windKph: roundOrNull(realtime.wind?.speed),
      windDirectionDeg: roundOrNull(realtime.wind?.direction),
      windText: windDirectionText(numberOrNull(realtime.wind?.direction)),
      pressureHpa: pressureHpaOrNull(realtime.pressure),
      precipMm: round1OrNull(realtime.precipitation?.local?.intensity),
      pm25: roundOrNull(realtime.air_quality?.pm25),
      pm10: roundOrNull(realtime.air_quality?.pm10),
      uvIndex: round1OrNull(realtime.life_index?.ultraviolet?.index),
    },
    today: {
      highC: roundOrNull(recordAt(daily.temperature, 0).max),
      lowC: roundOrNull(recordAt(daily.temperature, 0).min),
      precipProbPercent: roundOrNull(recordAt(daily.precipitation, 0).probability),
      precipMm: round1OrNull(recordAt(daily.precipitation, 0).avg),
      sunriseText: safeTimeText(recordValue(recordAt(daily.astro, 0).sunrise).time),
      sunsetText: safeTimeText(recordValue(recordAt(daily.astro, 0).sunset).time),
      uvIndexMax: round1OrNull(recordAt(daily.life_index?.ultraviolet, 0).index),
    },
    details: {
      aqiChn: roundOrNull(realtime.air_quality?.aqi?.chn),
      visibilityKm: round1OrNull(realtime.visibility),
      cloudPercent: percentOrNull(realtime.cloudrate),
      localRainIntensity: round1OrNull(realtime.precipitation?.local?.intensity),
      nearestRainDistanceKm: round1OrNull(realtime.precipitation?.nearest?.distance),
      nearestRainIntensity: round1OrNull(realtime.precipitation?.nearest?.intensity),
      comfortIndex: roundOrNull(realtime.life_index?.comfort?.index),
      dressingIndex: roundOrNull(recordAt(daily.life_index?.dressing, 0).index),
      coldRiskIndex: roundOrNull(recordAt(daily.life_index?.coldRisk, 0).index),
    },
    hourly: buildCaiyunHourly(hourly),
    daily: buildCaiyunDaily(daily, config.timezone),
  };
}

export function resetWeatherCacheForTests(): void {
  cache = null;
}

async function fetchOpenMeteoPayload(config: WeatherConfig, slot: number, generatedAt: number): Promise<DeviceWeatherPayload> {
  const forecast = await fetchJson(openMeteoForecastUrl(config));
  const air = await fetchJson(openMeteoAirQualityUrl(config)).catch(() => null);

  const current = forecast.current ?? {};
  const daily = forecast.daily ?? {};
  const hourly = forecast.hourly ?? {};
  const airCurrent = air?.current ?? {};

  const currentCode = numberOrNull(current.weather_code);
  const currentCondition = conditionFromWeatherCode(currentCode);
  return {
    schemaVersion: 1,
    generatedAt,
    status: "fresh",
    source: "open-meteo",
    location: safeLabel(config.locationName, "Hangzhou Yuhang", 48),
    timezone: safeLabel(config.timezone, "Asia/Shanghai", 48),
    slot,
    slotCount: WEATHER_SLOT_COUNT,
    current: {
      tempC: roundOrNull(current.temperature_2m),
      feelsLikeC: roundOrNull(current.apparent_temperature),
      humidityPercent: roundOrNull(current.relative_humidity_2m),
      condition: currentCondition.label,
      icon: currentCondition.icon,
      weatherCode: currentCode,
      windKph: roundOrNull(current.wind_speed_10m),
      windDirectionDeg: roundOrNull(current.wind_direction_10m),
      windText: windDirectionText(numberOrNull(current.wind_direction_10m)),
      pressureHpa: roundOrNull(current.pressure_msl),
      precipMm: round1OrNull(current.precipitation),
      pm25: roundOrNull(airCurrent.pm2_5),
      pm10: roundOrNull(airCurrent.pm10),
      uvIndex: round1OrNull(airCurrent.uv_index),
    },
    today: {
      highC: roundOrNull(arrayValue(daily.temperature_2m_max, 0)),
      lowC: roundOrNull(arrayValue(daily.temperature_2m_min, 0)),
      precipProbPercent: roundOrNull(arrayValue(daily.precipitation_probability_max, 0)),
      precipMm: round1OrNull(arrayValue(daily.precipitation_sum, 0)),
      sunriseText: timeText(arrayValue(daily.sunrise, 0)),
      sunsetText: timeText(arrayValue(daily.sunset, 0)),
      uvIndexMax: round1OrNull(arrayValue(daily.uv_index_max, 0)),
    },
    details: {
      aqiChn: null,
      visibilityKm: metersToKmOrNull(current.visibility),
      cloudPercent: roundOrNull(current.cloud_cover),
      localRainIntensity: round1OrNull(current.precipitation),
      nearestRainDistanceKm: null,
      nearestRainIntensity: null,
      comfortIndex: null,
      dressingIndex: null,
      coldRiskIndex: null,
    },
    hourly: buildHourly(hourly),
    daily: buildDaily(daily, config.timezone),
  };
}

function openMeteoForecastUrl(config: WeatherConfig): string {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(config.latitude));
  url.searchParams.set("longitude", String(config.longitude));
  url.searchParams.set("timezone", config.timezone);
  url.searchParams.set("wind_speed_unit", "kmh");
  url.searchParams.set("precipitation_unit", "mm");
  url.searchParams.set("forecast_days", "3");
  url.searchParams.set("forecast_hours", "12");
  url.searchParams.set("current", [
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "is_day",
    "precipitation",
    "weather_code",
    "pressure_msl",
    "wind_speed_10m",
    "wind_direction_10m",
    "cloud_cover",
    "visibility",
  ].join(","));
  url.searchParams.set("hourly", [
    "temperature_2m",
    "precipitation_probability",
    "precipitation",
    "weather_code",
  ].join(","));
  url.searchParams.set("daily", [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
    "precipitation_sum",
    "sunrise",
    "sunset",
    "uv_index_max",
  ].join(","));
  return url.toString();
}

function openMeteoAirQualityUrl(config: WeatherConfig): string {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.searchParams.set("latitude", String(config.latitude));
  url.searchParams.set("longitude", String(config.longitude));
  url.searchParams.set("timezone", config.timezone);
  url.searchParams.set("forecast_hours", "1");
  url.searchParams.set("current", "pm2_5,pm10,uv_index");
  return url.toString();
}

function caiyunWeatherUrl(config: WeatherConfig): string {
  if (!config.caiyunToken) {
    throw new Error("caiyun token missing");
  }
  const token = encodeURIComponent(config.caiyunToken);
  const lon = config.longitude.toFixed(4);
  const lat = config.latitude.toFixed(4);
  const url = new URL(`https://api.caiyunapp.com/v2.6/${token}/${lon},${lat}/weather`);
  url.searchParams.set("lang", "zh_CN");
  url.searchParams.set("unit", "metric");
  url.searchParams.set("alert", "false");
  url.searchParams.set("dailysteps", "3");
  url.searchParams.set("hourlysteps", "12");
  return url.toString();
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`weather HTTP ${response.status}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 128 * 1024) {
      throw new Error("weather response too large");
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function buildHourly(hourly: any): DeviceWeatherHour[] {
  const result: DeviceWeatherHour[] = [];
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  for (let i = 0; i < times.length && result.length < 6; i += 1) {
    const code = numberOrNull(arrayValue(hourly.weather_code, i));
    const condition = conditionFromWeatherCode(code);
    result.push({
      timeText: timeText(times[i]),
      tempC: roundOrNull(arrayValue(hourly.temperature_2m, i)),
      precipProbPercent: roundOrNull(arrayValue(hourly.precipitation_probability, i)),
      precipMm: round1OrNull(arrayValue(hourly.precipitation, i)),
      condition: condition.label,
      icon: condition.icon,
      weatherCode: code,
    });
  }
  return result;
}

function buildDaily(daily: any, timezone: string): DeviceWeatherDay[] {
  const result: DeviceWeatherDay[] = [];
  const times = Array.isArray(daily.time) ? daily.time : [];
  for (let i = 0; i < times.length && result.length < 3; i += 1) {
    const code = numberOrNull(arrayValue(daily.weather_code, i));
    const condition = conditionFromWeatherCode(code);
    result.push({
      dayText: dayText(times[i], timezone),
      highC: roundOrNull(arrayValue(daily.temperature_2m_max, i)),
      lowC: roundOrNull(arrayValue(daily.temperature_2m_min, i)),
      precipProbPercent: roundOrNull(arrayValue(daily.precipitation_probability_max, i)),
      precipMm: round1OrNull(arrayValue(daily.precipitation_sum, i)),
      condition: condition.label,
      icon: condition.icon,
      weatherCode: code,
    });
  }
  return result;
}

function buildCaiyunHourly(hourly: any): DeviceWeatherHour[] {
  const result: DeviceWeatherHour[] = [];
  const temperatures = Array.isArray(hourly.temperature) ? hourly.temperature : [];
  for (let i = 0; i < temperatures.length && result.length < 6; i += 1) {
    const temp = recordValue(temperatures[i]);
    const precipitation = recordAt(hourly.precipitation, i);
    const skycon = recordAt(hourly.skycon, i).value ?? null;
    const condition = conditionFromCaiyunSkycon(typeof skycon === "string" ? skycon : null);
    result.push({
      timeText: timeText(temp.datetime),
      tempC: roundOrNull(temp.value),
      precipProbPercent: roundOrNull(precipitation.probability),
      precipMm: round1OrNull(precipitation.value),
      condition: condition.label,
      icon: condition.icon,
      weatherCode: null,
    });
  }
  return result;
}

function buildCaiyunDaily(daily: any, timezone: string): DeviceWeatherDay[] {
  const result: DeviceWeatherDay[] = [];
  const temperatures = Array.isArray(daily.temperature) ? daily.temperature : [];
  for (let i = 0; i < temperatures.length && result.length < 3; i += 1) {
    const temp = recordValue(temperatures[i]);
    const precipitation = recordAt(daily.precipitation, i);
    const skycon = recordAt(daily.skycon, i).value ?? null;
    const condition = conditionFromCaiyunSkycon(typeof skycon === "string" ? skycon : null);
    result.push({
      dayText: dayText((temp.date ?? recordAt(daily.skycon, i).date) ?? "", timezone),
      highC: roundOrNull(temp.max),
      lowC: roundOrNull(temp.min),
      precipProbPercent: roundOrNull(precipitation.probability),
      precipMm: round1OrNull(precipitation.avg),
      condition: condition.label,
      icon: condition.icon,
      weatherCode: null,
    });
  }
  return result;
}

function conditionFromWeatherCode(code: number | null): { label: string; icon: string } {
  if (code === null) {
    return { label: "UNKNOWN", icon: "CLOUD" };
  }
  if (code === 0) {
    return { label: "CLEAR", icon: "SUN" };
  }
  if ([1, 2].includes(code)) {
    return { label: "PARTLY", icon: "PARTLY" };
  }
  if (code === 3) {
    return { label: "CLOUDY", icon: "CLOUD" };
  }
  if ([45, 48].includes(code)) {
    return { label: "FOG", icon: "FOG" };
  }
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
    return { label: "RAIN", icon: "RAIN" };
  }
  if ([71, 73, 75, 77, 85, 86].includes(code)) {
    return { label: "SNOW", icon: "SNOW" };
  }
  if ([95, 96, 99].includes(code)) {
    return { label: "STORM", icon: "STORM" };
  }
  return { label: "CLOUDY", icon: "CLOUD" };
}

function conditionFromCaiyunSkycon(skycon: string | null): { label: string; icon: string } {
  if (!skycon) {
    return { label: "UNKNOWN", icon: "CLOUD" };
  }
  if (skycon.includes("CLEAR")) {
    return { label: "CLEAR", icon: "SUN" };
  }
  if (skycon.includes("PARTLY_CLOUDY")) {
    return { label: "PARTLY", icon: "PARTLY" };
  }
  if (skycon === "CLOUDY") {
    return { label: "CLOUDY", icon: "CLOUD" };
  }
  if (skycon.includes("FOG") || skycon.includes("HAZE") || skycon.includes("DUST") || skycon.includes("SAND")) {
    return { label: "FOG", icon: "FOG" };
  }
  if (skycon.includes("SNOW")) {
    return { label: "SNOW", icon: "SNOW" };
  }
  if (skycon.includes("STORM")) {
    return { label: "STORM", icon: "STORM" };
  }
  if (skycon.includes("RAIN")) {
    return { label: "RAIN", icon: "RAIN" };
  }
  if (skycon === "WIND") {
    return { label: "WIND", icon: "CLOUD" };
  }
  return { label: "CLOUDY", icon: "CLOUD" };
}

function windDirectionText(degrees: number | null): string {
  if (degrees === null) {
    return "--";
  }
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
}

function withRequestFields(
  payload: DeviceWeatherPayload,
  slot: number,
  generatedAt: number,
  status: DeviceWeatherPayload["status"],
): DeviceWeatherPayload {
  return {
    ...payload,
    generatedAt,
    status,
    slot,
    slotCount: WEATHER_SLOT_COUNT,
  };
}

function emptyWeatherPayload(
  config: WeatherConfig,
  slot: number,
  status: DeviceWeatherPayload["status"],
  generatedAt: number,
): DeviceWeatherPayload {
  return {
    schemaVersion: 1,
    generatedAt,
    status,
    source: config.provider,
    location: safeLabel(config.locationName, "Hangzhou Yuhang", 48),
    timezone: safeLabel(config.timezone, "Asia/Shanghai", 48),
    slot,
    slotCount: WEATHER_SLOT_COUNT,
    current: {
      tempC: null,
      feelsLikeC: null,
      humidityPercent: null,
      condition: "NO DATA",
      icon: "CLOUD",
      weatherCode: null,
      windKph: null,
      windDirectionDeg: null,
      windText: "--",
      pressureHpa: null,
      precipMm: null,
      pm25: null,
      pm10: null,
      uvIndex: null,
    },
    today: {
      highC: null,
      lowC: null,
      precipProbPercent: null,
      precipMm: null,
      sunriseText: "--:--",
      sunsetText: "--:--",
      uvIndexMax: null,
    },
    details: emptyWeatherDetails(),
    hourly: [],
    daily: [],
  };
}

function emptyWeatherDetails(): DeviceWeatherDetails {
  return {
    aqiChn: null,
    visibilityKm: null,
    cloudPercent: null,
    localRainIntensity: null,
    nearestRainDistanceKm: null,
    nearestRainIntensity: null,
    comfortIndex: null,
    dressingIndex: null,
    coldRiskIndex: null,
  };
}

function weatherCacheKey(config: WeatherConfig): string {
  return [
    config.enabled ? "1" : "0",
    config.provider,
    config.locationName,
    config.latitude,
    config.longitude,
    config.timezone,
    secretFingerprint(config.caiyunToken ?? ""),
  ].join("|");
}

function secretFingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function normalizeSlot(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return ((Math.floor(value) - 1) % WEATHER_SLOT_COUNT) + 1;
}

function arrayValue(values: unknown, index: number): unknown {
  return Array.isArray(values) ? values[index] : null;
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function recordAt(values: unknown, index: number): Record<string, any> {
  return recordValue(arrayValue(values, index));
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function roundOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number === null ? null : Math.round(number);
}

function round1OrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number === null ? null : Math.round(number * 10) / 10;
}

function percentOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  if (number === null) {
    return null;
  }
  return Math.round(number <= 1.5 ? number * 100 : number);
}

function pressureHpaOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  if (number === null) {
    return null;
  }
  return Math.round(number > 2000 ? number / 100 : number);
}

function metersToKmOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  if (number === null) {
    return null;
  }
  return Math.round((number / 1000) * 10) / 10;
}

function safeLabel(value: string, fallback: string, maxLen: number): string {
  const trimmed = value.trim();
  return (trimmed || fallback).slice(0, maxLen);
}

function timeText(value: unknown): string {
  if (typeof value !== "string") {
    return "--:--";
  }
  const match = value.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : value.slice(0, 5);
}

function safeTimeText(value: unknown): string {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? value : timeText(value);
}

function dayText(value: unknown, timezone: string): string {
  if (typeof value !== "string") {
    return "---";
  }
  const datePart = value.includes("T") ? value.slice(0, 10) : value;
  const date = new Date(`${datePart}T12:00:00`);
  if (Number.isNaN(date.getTime())) {
    return datePart.slice(5);
  }
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: timezone || "Asia/Shanghai",
  }).format(date).toUpperCase();
}
