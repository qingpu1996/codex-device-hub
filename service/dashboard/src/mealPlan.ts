import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { XMLParser } from "fast-xml-parser";
import { escapeHtml } from "./util";

export const MEAL_SCHEMA_VERSION = 1;
export const MEAL_IMAGE_WIDTH = 800;
export const MEAL_IMAGE_HEIGHT = 480;
export const MEAL_FOOTER_TOP = 416;
export const MEAL_RAW_BYTES = (MEAL_IMAGE_WIDTH * MEAL_IMAGE_HEIGHT) / 2;
export const MEAL_EXCEL_DEFAULT_PATH = path.join(process.env.HOME ?? ".", "Documents", "codex-quota-dashboard", "meal-plan.xlsx");
export const MEAL_RAW_CONTENT_TYPE = "application/vnd.codex.e1002-4bpp";
export const MEAL_PNG_CONTENT_TYPE = "image/png";

const WEEKLY_SHEET = "一周食谱";
const SUMMARY_SHEET = "每日汇总";

type MealStatus = "fresh" | "missing" | "error";

interface MealEntry {
  meal: string;
  name: string;
  ingredients: string;
  note: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

interface MealSummary {
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  vegetables: number | null;
}

export interface MealAssets {
  status: MealStatus;
  generatedAt: number;
  date: string;
  weekday: string;
  updatedText: string;
  slot: number;
  slotCount: number;
  mealTitle: string;
  mealCount: number;
  summary: MealSummary | null;
  imageHash: string;
  png: Buffer;
  raw4bpp: Buffer;
  error: string | null;
}

export interface DeviceMealPayload {
  schemaVersion: 1;
  generatedAt: number;
  date: string;
  weekday: string;
  status: MealStatus;
  updatedText: string;
  slot: number;
  slotCount: number;
  mealTitle: string;
  mealCount: number;
  summary: MealSummary | null;
  image: {
    format: "e1002-4bpp";
    width: 800;
    height: 480;
    rawBytes: number;
    hash: string;
  };
}

interface ParsedWorkbook {
  sheets: Map<string, unknown[][]>;
}

let cachedAssets: { key: string; assets: MealAssets } | null = null;

export function mealExcelPath(): string {
  return process.env.CODEX_MEAL_EXCEL_PATH || MEAL_EXCEL_DEFAULT_PATH;
}

export async function getTodayMealAssets(now = new Date(), excelPath = mealExcelPath(), requestedSlot = 1, enabled = true): Promise<MealAssets> {
  const date = localDateString(now);
  const weekday = weekdayLabel(now);
  if (!enabled) {
    const slot = normalizeSlot(requestedSlot);
    const cacheKey = `${excelPath}:disabled:${date}:${slot}`;
    if (cachedAssets?.key === cacheKey) {
      return cachedAssets.assets;
    }
    const assets = await renderMealAssets({
      status: "missing",
      date,
      weekday,
      updatedText: "MEAL DISABLED",
      requestedSlot: slot,
      meals: [],
      summary: null,
      error: "Meal module disabled in Mac config",
    });
    cachedAssets = { key: cacheKey, assets };
    return assets;
  }
  const stat = await fs.stat(excelPath).catch(() => null);
  const slot = normalizeSlot(requestedSlot);
  const cacheKey = stat ? `${excelPath}:${stat.mtimeMs}:${date}:${slot}` : `${excelPath}:missing:${date}:${slot}`;
  if (cachedAssets?.key === cacheKey) {
    return cachedAssets.assets;
  }

  let assets: MealAssets;
  if (!stat) {
    assets = await renderMealAssets({
      status: "missing",
      date,
      weekday,
      updatedText: "NAS EXCEL MISSING",
      requestedSlot: slot,
      meals: [],
      summary: null,
      error: "NAS Excel not mounted or not found",
    });
  } else {
    try {
      const workbook = await readWorkbookSheets(excelPath, [WEEKLY_SHEET, SUMMARY_SHEET]);
      const weeklyRows = workbook.sheets.get(WEEKLY_SHEET) ?? [];
      const summaryRows = workbook.sheets.get(SUMMARY_SHEET) ?? [];
      const plan = buildTodayMealPlan(weeklyRows, summaryRows, now, stat.mtime, slot);
      assets = await renderMealAssets({ status: "fresh", ...plan, error: null });
    } catch (error) {
      assets = await renderMealAssets({
        status: "error",
        date,
        weekday,
        updatedText: "NAS EXCEL ERROR",
        requestedSlot: slot,
        meals: [],
        summary: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  cachedAssets = { key: cacheKey, assets };
  return assets;
}

export function buildDeviceMealPayload(assets: MealAssets): DeviceMealPayload {
  return {
    schemaVersion: MEAL_SCHEMA_VERSION,
    generatedAt: assets.generatedAt,
    date: assets.date,
    weekday: assets.weekday,
    status: assets.status,
    updatedText: assets.updatedText,
    slot: assets.slot,
    slotCount: assets.slotCount,
    mealTitle: assets.mealTitle,
    mealCount: assets.mealCount,
    summary: assets.summary,
    image: {
      format: "e1002-4bpp",
      width: MEAL_IMAGE_WIDTH,
      height: MEAL_IMAGE_HEIGHT,
      rawBytes: MEAL_RAW_BYTES,
      hash: assets.imageHash,
    },
  };
}

export function weekdayLabel(date: Date): string {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
}

export function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function packE1002Raw4bpp(rgba: Buffer, width: number, height: number): Buffer {
  if (width !== MEAL_IMAGE_WIDTH || height !== MEAL_IMAGE_HEIGHT) {
    throw new Error(`unexpected image size ${width}x${height}`);
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`unexpected rgba length ${rgba.length}`);
  }

  const raw = Buffer.alloc(MEAL_RAW_BYTES);
  for (let pixel = 0; pixel < width * height; pixel += 2) {
    const left = nearestE1002ColorNibble(rgba[pixel * 4], rgba[pixel * 4 + 1], rgba[pixel * 4 + 2], rgba[pixel * 4 + 3]);
    const right = nearestE1002ColorNibble(
      rgba[(pixel + 1) * 4],
      rgba[(pixel + 1) * 4 + 1],
      rgba[(pixel + 1) * 4 + 2],
      rgba[(pixel + 1) * 4 + 3],
    );
    raw[pixel / 2] = (left << 4) | right;
  }
  return raw;
}

export function nearestE1002ColorNibble(red: number, green: number, blue: number, alpha = 255): number {
  const blended = blendOnWhite(red, green, blue, alpha);
  let best: E1002PaletteColor = E1002_PALETTE[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const color of E1002_PALETTE) {
    const dr = blended.r - color.r;
    const dg = blended.g - color.g;
    const db = blended.b - color.b;
    const distance = dr * dr * 3 + dg * dg * 4 + db * db * 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = color;
    }
  }
  return best.nibble;
}

export function buildTodayMealPlan(
  weeklyRows: unknown[][],
  summaryRows: unknown[][],
  now: Date,
  updatedAt: Date,
  requestedSlot = 1,
): {
  date: string;
  weekday: string;
  updatedText: string;
  requestedSlot: number;
  meals: MealEntry[];
  summary: MealSummary | null;
} {
  const weekday = weekdayLabel(now);
  const date = localDateString(now);
  const meals = mealsForWeekday(weeklyRows, weekday);
  return {
    date,
    weekday,
    updatedText: formatUpdatedText(updatedAt),
    requestedSlot: normalizeSlot(requestedSlot),
    meals,
    summary: summaryForWeekday(summaryRows, weekday),
  };
}

function mealsForWeekday(rows: unknown[][], targetWeekday: string): MealEntry[] {
  const header = rows[0] ?? [];
  const weekdayCol = columnIndex(header, "星期");
  const mealCol = columnIndex(header, "餐次");
  const nameCol = columnIndex(header, "餐名");
  const ingredientsCol = columnIndex(header, "食材/份量");
  const noteCol = columnIndex(header, "做法/备注");
  const kcalCol = columnIndex(header, "热量");
  const proteinCol = columnIndex(header, "蛋白质");
  const carbsCol = columnIndex(header, "碳水");
  const fatCol = columnIndex(header, "脂肪");

  const required = [weekdayCol, mealCol, nameCol, ingredientsCol];
  if (required.some((index) => index < 0)) {
    throw new Error("weekly meal sheet headers not found");
  }

  let currentWeekday = "";
  const meals: MealEntry[] = [];
  for (const row of rows.slice(1)) {
    const weekday = cellString(row[weekdayCol]);
    if (weekday) {
      currentWeekday = weekday;
    }
    if (currentWeekday !== targetWeekday) {
      continue;
    }
    const meal = cellString(row[mealCol]);
    const name = cellString(row[nameCol]);
    if (!meal || !name) {
      continue;
    }
    meals.push({
      meal,
      name,
      ingredients: normalizeIngredientText(cellString(row[ingredientsCol])),
      note: cellString(row[noteCol]),
      calories: cellNumber(row[kcalCol]),
      protein: cellNumber(row[proteinCol]),
      carbs: cellNumber(row[carbsCol]),
      fat: cellNumber(row[fatCol]),
    });
  }
  return meals;
}

function summaryForWeekday(rows: unknown[][], targetWeekday: string): MealSummary | null {
  const header = rows[0] ?? [];
  const weekdayCol = columnIndex(header, "星期");
  if (weekdayCol < 0) {
    return null;
  }
  const kcalCol = columnIndex(header, "热量");
  const proteinCol = columnIndex(header, "蛋白质");
  const carbsCol = columnIndex(header, "碳水");
  const fatCol = columnIndex(header, "脂肪");
  const vegetableCol = columnIndex(header, "蔬菜");
  const row = rows.slice(1).find((item) => cellString(item[weekdayCol]) === targetWeekday);
  if (!row) {
    return null;
  }
  return {
    calories: cellNumber(row[kcalCol]),
    protein: cellNumber(row[proteinCol]),
    carbs: cellNumber(row[carbsCol]),
    fat: cellNumber(row[fatCol]),
    vegetables: cellNumber(row[vegetableCol]),
  };
}

async function renderMealAssets(input: {
  status: MealStatus;
  date: string;
  weekday: string;
  updatedText: string;
  requestedSlot: number;
  meals: MealEntry[];
  summary: MealSummary | null;
  error: string | null;
}): Promise<MealAssets> {
  const svg = renderMealSvg(input);
  const rendered = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw4bpp = packE1002Raw4bpp(rendered.data, rendered.info.width, rendered.info.height);
  const png = await packedRawToPng(raw4bpp);
  const imageHash = crypto.createHash("sha256").update(raw4bpp).digest("hex");
  return {
    status: input.status,
    generatedAt: Math.floor(Date.now() / 1000),
    date: input.date,
    weekday: input.weekday,
    updatedText: input.updatedText,
    slot: selectedMealSlot(input.requestedSlot, input.meals.length),
    slotCount: input.meals.length > 0 ? input.meals.length : 1,
    mealTitle: selectedMeal(input.requestedSlot, input.meals)?.name ?? "",
    mealCount: input.meals.length,
    summary: input.summary,
    imageHash,
    png,
    raw4bpp,
    error: input.error,
  };
}

function renderMealSvg(input: {
  status: MealStatus;
  date: string;
  weekday: string;
  updatedText: string;
  requestedSlot: number;
  meals: MealEntry[];
  summary: MealSummary | null;
  error: string | null;
}): string {
  const title = input.status === "fresh" ? "今日食谱" : "今日食谱不可用";
  const subtitle = input.status === "fresh" ? `${input.date} · ${input.weekday}` : input.updatedText;
  const summary = input.summary ? summaryText(input.summary) : "等待食谱数据";
  const slot = selectedMealSlot(input.requestedSlot, input.meals.length);
  const meal = selectedMeal(input.requestedSlot, input.meals);
  const mealContent = meal ? singleMealSvg(meal, slot, input.meals.length) : emptyMealSvg(input.error);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${MEAL_IMAGE_WIDTH}" height="${MEAL_IMAGE_HEIGHT}" viewBox="0 0 ${MEAL_IMAGE_WIDTH} ${MEAL_IMAGE_HEIGHT}">
  <style>
    text { font-family: "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Arial Unicode MS", sans-serif; dominant-baseline: central; }
    .title { font-size: 38px; font-weight: 700; fill: #0000ff; }
    .subtitle { font-size: 20px; fill: #000000; }
    .summary { font-size: 22px; font-weight: 700; fill: #008000; }
    .meal-label { font-size: 23px; font-weight: 700; fill: #ffffff; }
    .meal-name { font-size: 34px; font-weight: 700; fill: #000000; }
    .section { font-size: 20px; font-weight: 700; fill: #0000ff; }
    .body { font-size: 21px; fill: #000000; }
    .note-title { font-size: 20px; font-weight: 700; fill: #0000ff; dominant-baseline: hanging; }
    .note-body { font-size: 21px; fill: #000000; dominant-baseline: hanging; }
    .metric { font-size: 22px; font-weight: 700; fill: #ff0000; }
    .muted { font-size: 18px; fill: #000000; }
  </style>
  <rect x="0" y="0" width="800" height="480" fill="#ffffff"/>
  <rect x="0" y="0" width="800" height="480" fill="none" stroke="#000000" stroke-width="4"/>
  <rect x="18" y="18" width="764" height="52" fill="#ffffff" stroke="#000000" stroke-width="3"/>
  <text x="34" y="44" class="title">${escapeXml(title)}</text>
  <text x="770" y="36" text-anchor="end" class="subtitle">${escapeXml(subtitle)}</text>
  <text x="770" y="60" text-anchor="end" class="summary">${escapeXml(summary)}</text>
  ${mealContent}
  <line x1="20" y1="${MEAL_FOOTER_TOP}" x2="780" y2="${MEAL_FOOTER_TOP}" stroke="#000000" stroke-width="3"/>
  <rect x="0" y="${MEAL_FOOTER_TOP + 2}" width="800" height="${480 - MEAL_FOOTER_TOP - 2}" fill="#ffffff"/>
</svg>`;
}

function singleMealSvg(meal: MealEntry, slot: number, slotCount: number): string {
  const metric = meal.calories === null ? "" : `${Math.round(meal.calories)} kcal`;
  const macros = meal.protein === null ? "" : `P ${round1(meal.protein)}  C ${round1(meal.carbs)}  F ${round1(meal.fat)}`;
  const ingredientLines = wrapForSvg(shorten(meal.ingredients, 150), 31, 4, 56, 190, "body", 29);
  const noteLines = wrapForSvg(shorten(meal.note, 74), 26, 2, 56, 354, "note-body", 27);
  return `
  <rect x="28" y="88" width="744" height="306" fill="#ffffff" stroke="#000000" stroke-width="4"/>
  <rect x="28" y="88" width="112" height="62" fill="#0000ff" stroke="#000000" stroke-width="4"/>
  <text x="84" y="119" text-anchor="middle" class="meal-label">${escapeXml(shorten(meal.meal, 4))}</text>
  <text x="158" y="119" class="meal-name">${escapeXml(shorten(meal.name, 17))}</text>
  <text x="754" y="108" text-anchor="end" class="metric">${escapeXml(metric)}</text>
  <text x="754" y="138" text-anchor="end" class="muted">${escapeXml(macros)}</text>
  <text x="56" y="166" class="section">食材 / 份量</text>
  ${ingredientLines}
  <line x1="48" y1="306" x2="752" y2="306" stroke="#000000" stroke-width="2"/>
  <text x="56" y="322" class="note-title">做法 / 备注</text>
  ${noteLines}
  <text x="746" y="374" text-anchor="end" class="summary">M${slot}/${slotCount}</text>`;
}

function mealCardSvg(meal: MealEntry, index: number): string {
  const y = 84 + index * 80;
  const labelColor = index % 2 === 0 ? "#0000ff" : "#008000";
  const ingredients = wrapForSvg(shorten(meal.ingredients, 30), 30, 1, 130, y + 46, "body", 22);
  const metric = meal.calories === null ? "" : `${Math.round(meal.calories)} kcal`;
  const macros = meal.protein === null ? "" : `P ${round1(meal.protein)}  C ${round1(meal.carbs)}  F ${round1(meal.fat)}`;
  return `
  <rect x="28" y="${y}" width="744" height="72" fill="#ffffff" stroke="#000000" stroke-width="3"/>
  <rect x="28" y="${y}" width="84" height="72" fill="${labelColor}" stroke="#000000" stroke-width="3"/>
  <text x="70" y="${y + 36}" text-anchor="middle" class="meal-label">${escapeXml(shorten(meal.meal, 4))}</text>
  <text x="130" y="${y + 20}" class="meal-name">${escapeXml(shorten(meal.name, 23))}</text>
  ${ingredients}
  <text x="754" y="${y + 22}" text-anchor="end" class="metric">${escapeXml(metric)}</text>
  <text x="754" y="${y + 52}" text-anchor="end" class="muted">${escapeXml(macros)}</text>`;
}

function normalizeSlot(slot: number): number {
  return Number.isFinite(slot) && slot >= 1 ? Math.floor(slot) : 1;
}

function selectedMealSlot(requestedSlot: number, mealCount: number): number {
  if (mealCount <= 0) {
    return 1;
  }
  const normalized = normalizeSlot(requestedSlot);
  return ((normalized - 1) % mealCount) + 1;
}

function selectedMeal(requestedSlot: number, meals: MealEntry[]): MealEntry | null {
  if (meals.length === 0) {
    return null;
  }
  return meals[selectedMealSlot(requestedSlot, meals.length) - 1];
}

function emptyMealSvg(error: string | null): string {
  return `
  <rect x="56" y="132" width="688" height="200" fill="#ffffff" stroke="#000000" stroke-width="4"/>
  <text x="400" y="198" text-anchor="middle" class="title">未配置今日食谱</text>
  <text x="400" y="258" text-anchor="middle" class="subtitle">${escapeXml(shorten(error ?? "等待 NAS Excel 数据", 34))}</text>`;
}

async function packedRawToPng(raw4bpp: Buffer): Promise<Buffer> {
  const rgba = Buffer.alloc(MEAL_IMAGE_WIDTH * MEAL_IMAGE_HEIGHT * 4);
  for (let pixel = 0; pixel < MEAL_IMAGE_WIDTH * MEAL_IMAGE_HEIGHT; pixel += 2) {
    writePalettePixel(rgba, pixel, raw4bpp[pixel / 2] >> 4);
    writePalettePixel(rgba, pixel + 1, raw4bpp[pixel / 2] & 0x0f);
  }
  return sharp(rgba, { raw: { width: MEAL_IMAGE_WIDTH, height: MEAL_IMAGE_HEIGHT, channels: 4 } }).png().toBuffer();
}

function writePalettePixel(rgba: Buffer, pixel: number, nibble: number): void {
  const color = E1002_PALETTE.find((item) => item.nibble === nibble) ?? E1002_PALETTE[0];
  const offset = pixel * 4;
  rgba[offset] = color.r;
  rgba[offset + 1] = color.g;
  rgba[offset + 2] = color.b;
  rgba[offset + 3] = 255;
}

async function readWorkbookSheets(filePath: string, sheetNames: string[]): Promise<ParsedWorkbook> {
  const workbookXml = await requiredZipEntry(filePath, "xl/workbook.xml");
  const relsXml = await requiredZipEntry(filePath, "xl/_rels/workbook.xml.rels");
  const sharedStringsXml = await readZipEntry(filePath, "xl/sharedStrings.xml");
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : [];
  const sheetMap = parseWorkbookSheetMap(workbookXml, relsXml);
  const sheets = new Map<string, unknown[][]>();
  for (const name of sheetNames) {
    const entryName = sheetMap.get(name);
    if (!entryName) {
      continue;
    }
    const sheetXml = await requiredZipEntry(filePath, entryName);
    sheets.set(name, parseWorksheet(sheetXml, sharedStrings));
  }
  return { sheets };
}

async function requiredZipEntry(filePath: string, entryName: string): Promise<Buffer> {
  const entry = await readZipEntry(filePath, entryName);
  if (!entry) {
    throw new Error(`missing xlsx entry ${entryName}`);
  }
  return entry;
}

function readZipEntry(filePath: string, entryName: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error("failed to open xlsx zip"));
        return;
      }
      zipFile.readEntry();
      zipFile.on("entry", (entry: Entry) => {
        if (entry.fileName !== entryName) {
          zipFile.readEntry();
          return;
        }
        collectEntry(zipFile, entry).then(
          (buffer) => {
            zipFile.close();
            resolve(buffer);
          },
          (error) => {
            zipFile.close();
            reject(error);
          },
        );
      });
      zipFile.on("end", () => resolve(null));
      zipFile.on("error", reject);
    });
  });
}

function collectEntry(zipFile: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`failed to read ${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

function parseWorkbookSheetMap(workbookXml: Buffer, relsXml: Buffer): Map<string, string> {
  const workbook = recordValue(parseXml(workbookXml), "workbook");
  const rels = recordValue(parseXml(relsXml), "Relationships");
  const relationships = new Map<string, string>();
  for (const rel of asArray<Record<string, unknown>>(rels.Relationship)) {
    const id = stringAttr(rel, "Id");
    const target = stringAttr(rel, "Target");
    if (id && target) {
      relationships.set(id, `xl/${target.replace(/^\/xl\//, "")}`);
    }
  }

  const result = new Map<string, string>();
  const sheetsNode = recordValue(workbook, "sheets");
  for (const sheet of asArray<Record<string, unknown>>(sheetsNode.sheet)) {
    const name = stringAttr(sheet, "name");
    const relId = stringAttr(sheet, "r:id") || stringAttr(sheet, "id");
    const target = relId ? relationships.get(relId) : null;
    if (name && target) {
      result.set(name, path.posix.normalize(target));
    }
  }
  return result;
}

function parseSharedStrings(xml: Buffer): string[] {
  const sst = recordValue(parseXml(xml), "sst");
  return asArray<unknown>(sst?.si).map(sharedStringText);
}

function sharedStringText(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }
  const value = item as Record<string, unknown>;
  if (typeof value.t === "string") {
    return value.t;
  }
  if (value.t && typeof value.t === "object" && typeof (value.t as Record<string, unknown>)["#text"] === "string") {
    return String((value.t as Record<string, unknown>)["#text"]);
  }
  return asArray<Record<string, unknown>>(value.r).map((run) => sharedStringText(run)).join("");
}

function parseWorksheet(xml: Buffer, sharedStrings: string[]): unknown[][] {
  const worksheet = recordValue(parseXml(xml), "worksheet");
  const sheetData = recordValue(worksheet, "sheetData");
  const rows = asArray<Record<string, unknown>>(sheetData.row);
  const result: unknown[][] = [];
  for (const row of rows) {
    const rowIndex = Number(stringAttr(row, "r")) || result.length + 1;
    const values: unknown[] = [];
    for (const cell of asArray<Record<string, unknown>>(row.c)) {
      const address = stringAttr(cell, "r");
      const colIndex = address ? columnIndexFromAddress(address) : values.length;
      values[colIndex] = cellValue(cell, sharedStrings);
    }
    result[rowIndex - 1] = values;
  }
  return result.filter(Boolean);
}

function cellValue(cell: Record<string, unknown>, sharedStrings: string[]): unknown {
  const type = stringAttr(cell, "t");
  const rawValue = cell.v;
  if (type === "s") {
    const index = Number(rawValue);
    return Number.isInteger(index) ? sharedStrings[index] ?? "" : "";
  }
  if (type === "inlineStr") {
    return sharedStringText(cell.is);
  }
  if (typeof rawValue === "number") {
    return rawValue;
  }
  if (typeof rawValue !== "string") {
    return "";
  }
  if (type === "str") {
    return rawValue;
  }
  const number = Number(rawValue);
  return Number.isFinite(number) ? number : rawValue;
}

function parseXml(xml: Buffer): Record<string, unknown> {
  return new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  }).parse(xml.toString("utf8")) as Record<string, unknown>;
}

function recordValue(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = value[key];
  return child && typeof child === "object" ? child as Record<string, unknown> : {};
}

function columnIndex(header: unknown[], name: string): number {
  return header.findIndex((value) => cellString(value).includes(name));
}

function columnIndexFromAddress(address: string): number {
  const letters = address.match(/^[A-Z]+/)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + letter.charCodeAt(0) - 64;
  }
  return index - 1;
}

function stringAttr(value: Record<string, unknown>, name: string): string {
  return typeof value[`@_${name}`] === "string" ? String(value[`@_${name}`]) : "";
}

function asArray<T>(value: unknown): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value as T[] : [value as T];
}

function cellString(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function cellNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeIngredientText(value: string): string {
  return value.replace(/[•·]/g, " ").replace(/\s*\/\s*/g, "；").replace(/\s+/g, " ").trim();
}

function formatUpdatedText(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `更新 ${month}-${day} ${hour}:${minute}`;
}

function summaryText(summary: MealSummary): string {
  const kcal = summary.calories === null ? "--" : String(Math.round(summary.calories));
  const protein = summary.protein === null ? "--" : String(Math.round(summary.protein));
  const carbs = summary.carbs === null ? "--" : String(Math.round(summary.carbs));
  const fat = summary.fat === null ? "--" : String(Math.round(summary.fat));
  return `${kcal} kcal  P ${protein}  C ${carbs}  F ${fat}`;
}

function wrapForSvg(value: string, maxChars: number, maxLines: number, x: number, y: number, className: string, lineHeight: number): string {
  return wrapText(value, maxChars, maxLines)
    .map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" class="${className}">${escapeXml(line)}</text>`)
    .join("");
}

function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const chars = Array.from(value);
  const lines: string[] = [];
  for (let i = 0; i < chars.length && lines.length < maxLines; i += maxChars) {
    let line = chars.slice(i, i + maxChars).join("");
    if (lines.length === maxLines - 1 && i + maxChars < chars.length) {
      line = `${line.slice(0, Math.max(0, maxChars - 1))}…`;
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [""];
}

function shorten(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) {
    return value;
  }
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function round1(value: number | null): string {
  if (value === null) {
    return "--";
  }
  return String(Math.round(value));
}

function escapeXml(value: unknown): string {
  return escapeHtml(value);
}

function blendOnWhite(red: number, green: number, blue: number, alpha: number): { r: number; g: number; b: number } {
  const a = Math.max(0, Math.min(255, alpha)) / 255;
  return {
    r: Math.round(red * a + 255 * (1 - a)),
    g: Math.round(green * a + 255 * (1 - a)),
    b: Math.round(blue * a + 255 * (1 - a)),
  };
}

interface E1002PaletteColor {
  name: string;
  nibble: number;
  r: number;
  g: number;
  b: number;
}

const E1002_PALETTE: E1002PaletteColor[] = [
  { name: "white", nibble: 0x0, r: 255, g: 255, b: 255 },
  { name: "green", nibble: 0x2, r: 0, g: 128, b: 0 },
  { name: "red", nibble: 0x6, r: 255, g: 0, b: 0 },
  { name: "yellow", nibble: 0x0b, r: 255, g: 255, b: 0 },
  { name: "blue", nibble: 0x0d, r: 0, g: 0, b: 255 },
  { name: "black", nibble: 0x0f, r: 0, g: 0, b: 0 },
];
