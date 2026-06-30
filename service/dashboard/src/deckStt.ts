import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deckSttConfigPath, deckTmpDir } from "./paths";
import type { DeckSpeechClient, DeckSttInput, DeckSttOptions, DeckSttResult } from "./deck";
import { DeckSttUnavailableError } from "./deck";
import { redactLogLine, safeJsonParse } from "./util";

export interface SttProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  transcribe(inputWavPath: string, options: Required<DeckSttRuntimeOptions>): Promise<DeckSttResult>;
}

export interface DeckSttRuntimeOptions {
  language?: string;
  model?: string;
  timeoutMs?: number;
  maxDurationMs?: number;
  force16kMono?: boolean;
}

interface DeckSttConfig extends DeckSttRuntimeOptions {
  provider?: string;
  modelPath?: string;
  pythonPath?: string;
}

const DEFAULT_STT_CONFIG: Required<Omit<DeckSttConfig, "modelPath" | "pythonPath">> = {
  provider: "auto",
  language: "zh",
  model: "base",
  timeoutMs: 120_000,
  maxDurationMs: 25_000,
  force16kMono: true,
};

export class AutoDeckSpeechClient implements DeckSpeechClient {
  constructor(private readonly home = os.homedir()) {}

  async isAvailable(): Promise<boolean> {
    const config = await this.loadConfig();
    const provider = await this.selectProvider(config);
    return Boolean(provider);
  }

  async transcribe(input: DeckSttInput, options: DeckSttOptions = {}): Promise<DeckSttResult> {
    const config = await this.loadConfig();
    const provider = await this.selectProvider(config);
    if (!provider) {
      throw new DeckSttUnavailableError("STT UNAVAILABLE");
    }

    const runtimeOptions = this.runtimeOptions(config, options);
    const wavPath = runtimeOptions.force16kMono
      ? await maybeConvertTo16kMono(input.wavPath, this.home, runtimeOptions.timeoutMs)
      : input.wavPath;
    try {
      return await provider.transcribe(wavPath, runtimeOptions);
    } finally {
      if (wavPath !== input.wavPath) {
        await fs.rm(wavPath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async loadConfig(): Promise<DeckSttConfig> {
    try {
      const text = await fs.readFile(deckSttConfigPath(this.home), "utf8");
      const parsed = safeJsonParse(text);
      return normalizeSttConfig(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...DEFAULT_STT_CONFIG };
      }
      throw error;
    }
  }

  private runtimeOptions(config: DeckSttConfig, request: DeckSttOptions): Required<DeckSttRuntimeOptions> {
    return {
      language: safeLanguage(request.language ?? config.language ?? DEFAULT_STT_CONFIG.language),
      model: typeof config.model === "string" && config.model ? config.model : DEFAULT_STT_CONFIG.model,
      timeoutMs: positiveInt(config.timeoutMs, DEFAULT_STT_CONFIG.timeoutMs),
      maxDurationMs: positiveInt(config.maxDurationMs, DEFAULT_STT_CONFIG.maxDurationMs),
      force16kMono: config.force16kMono !== false,
    };
  }

  private async selectProvider(config: DeckSttConfig): Promise<SttProvider | null> {
    const requested = typeof config.provider === "string" && config.provider.trim()
      ? config.provider.trim().toLowerCase()
      : DEFAULT_STT_CONFIG.provider;
    const providers: SttProvider[] = [
      new MlxWhisperCliProvider(),
      new MlxWhisperPythonProvider(config.pythonPath),
      new WhisperCppProvider(config.modelPath),
      new GenericWhisperProvider(),
    ];
    for (const provider of providers) {
      if (requested !== "auto" && provider.name !== requested) {
        continue;
      }
      if (await provider.isAvailable()) {
        return provider;
      }
    }
    return null;
  }
}

class MlxWhisperCliProvider implements SttProvider {
  name = "mlx-whisper";
  private command: string | null = null;

  async isAvailable(): Promise<boolean> {
    this.command = await firstCommand(["mlx-whisper", "mlx_whisper"]);
    return Boolean(this.command);
  }

  async transcribe(inputWavPath: string, options: Required<DeckSttRuntimeOptions>): Promise<DeckSttResult> {
    if (!this.command) {
      throw new DeckSttUnavailableError("STT UNAVAILABLE");
    }
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-deck-stt-"));
    const outputName = `mlx_${Date.now()}`;
    const model = mlxModelName(options.model);
    const args = [inputWavPath, "--model", model, "-f", "txt", "--output-name", outputName];
    if (options.language && options.language !== "auto") {
      args.push("--language", options.language);
    }
    const result = await execFileSafe(this.command, args, { cwd: tmpDir, timeoutMs: options.timeoutMs });
    const text = await readFirstTextFile(tmpDir).catch(() => result.stdout);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      text: normalizeTranscript(text),
      language: options.language === "auto" ? undefined : options.language,
      engine: `${this.name}:${model}`,
    };
  }
}

class MlxWhisperPythonProvider implements SttProvider {
  name = "mlx-whisper-python";
  private python: string;

  constructor(pythonPath?: string) {
    this.python = pythonPath || process.env.PYTHON || "python3";
  }

  async isAvailable(): Promise<boolean> {
    const result = await execFileSafe(this.python, ["-c", "import mlx_whisper"], { timeoutMs: 5_000 }).catch(() => null);
    return Boolean(result);
  }

  async transcribe(inputWavPath: string, options: Required<DeckSttRuntimeOptions>): Promise<DeckSttResult> {
    const script = [
      "import json, sys, wave",
      "from math import gcd",
      "import numpy as np",
      "from scipy.signal import resample_poly",
      "import mlx_whisper",
      "audio, model, language = sys.argv[1], sys.argv[2], sys.argv[3]",
      "def load_wav_pcm(path):",
      "    with wave.open(path, 'rb') as wf:",
      "        channels, width, sr, frames = wf.getnchannels(), wf.getsampwidth(), wf.getframerate(), wf.getnframes()",
      "        raw = wf.readframes(frames)",
      "    if width == 1:",
      "        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0",
      "    elif width == 2:",
      "        data = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0",
      "    elif width == 4:",
      "        data = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0",
      "    else:",
      "        raise RuntimeError('unsupported wav sample width')",
      "    if channels > 1:",
      "        data = data.reshape(-1, channels).mean(axis=1)",
      "    if sr != 16000:",
      "        step = gcd(sr, 16000)",
      "        data = resample_poly(data, 16000 // step, sr // step).astype(np.float32)",
      "    return data.astype(np.float32, copy=False)",
      "try:",
      "    audio_input = load_wav_pcm(audio)",
      "except Exception:",
      "    audio_input = audio",
      "kwargs = {'path_or_hf_repo': model}",
      "if language and language != 'auto': kwargs['language'] = language",
      "result = mlx_whisper.transcribe(audio_input, **kwargs)",
      "print(json.dumps({'text': result.get('text', ''), 'language': result.get('language')}, ensure_ascii=False))",
    ].join("\n");
    const model = mlxModelName(options.model);
    const result = await execFileSafe(this.python, ["-c", script, inputWavPath, model, options.language], { timeoutMs: options.timeoutMs });
    const parsed = safeJsonParse(result.stdout.trim());
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    return {
      text: normalizeTranscript(typeof record.text === "string" ? record.text : result.stdout),
      language: typeof record.language === "string" ? record.language : (options.language === "auto" ? undefined : options.language),
      engine: `${this.name}:${model}`,
    };
  }
}

class WhisperCppProvider implements SttProvider {
  name = "whisper.cpp";
  private command: string | null = null;

  constructor(private readonly modelPath?: string) {}

  async isAvailable(): Promise<boolean> {
    if (!this.modelPath) {
      return false;
    }
    this.command = await firstCommand(["whisper-cli", "main"]);
    return Boolean(this.command);
  }

  async transcribe(inputWavPath: string, options: Required<DeckSttRuntimeOptions>): Promise<DeckSttResult> {
    if (!this.command || !this.modelPath) {
      throw new DeckSttUnavailableError("STT UNAVAILABLE");
    }
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-deck-stt-"));
    const outputBase = path.join(tmpDir, "whisper_cpp");
    const args = ["-m", this.modelPath, "-f", inputWavPath, "-otxt", "-of", outputBase];
    if (options.language && options.language !== "auto") {
      args.push("-l", options.language);
    }
    const result = await execFileSafe(this.command, args, { timeoutMs: options.timeoutMs });
    const text = await fs.readFile(`${outputBase}.txt`, "utf8").catch(() => result.stdout);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      text: normalizeTranscript(text),
      language: options.language === "auto" ? undefined : options.language,
      engine: `${this.name}:${path.basename(this.modelPath)}`,
    };
  }
}

class GenericWhisperProvider implements SttProvider {
  name = "whisper";
  private command: string | null = null;

  async isAvailable(): Promise<boolean> {
    this.command = await firstCommand(["whisper"]);
    return Boolean(this.command);
  }

  async transcribe(inputWavPath: string, options: Required<DeckSttRuntimeOptions>): Promise<DeckSttResult> {
    if (!this.command) {
      throw new DeckSttUnavailableError("STT UNAVAILABLE");
    }
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-deck-stt-"));
    const args = [inputWavPath, "--model", options.model, "--output_format", "txt", "--output_dir", tmpDir];
    if (options.language && options.language !== "auto") {
      args.push("--language", options.language);
    }
    const result = await execFileSafe(this.command, args, { timeoutMs: options.timeoutMs });
    const text = await readFirstTextFile(tmpDir).catch(() => result.stdout);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      text: normalizeTranscript(text),
      language: options.language === "auto" ? undefined : options.language,
      engine: `${this.name}:${options.model}`,
    };
  }
}

function normalizeSttConfig(value: unknown): DeckSttConfig {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_STT_CONFIG };
  }
  const input = value as Partial<DeckSttConfig>;
  return {
    provider: typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : DEFAULT_STT_CONFIG.provider,
    language: safeLanguage(input.language ?? DEFAULT_STT_CONFIG.language),
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim().slice(0, 128) : DEFAULT_STT_CONFIG.model,
    modelPath: typeof input.modelPath === "string" && input.modelPath.trim() ? input.modelPath.trim().slice(0, 1024) : undefined,
    pythonPath: typeof input.pythonPath === "string" && input.pythonPath.trim() ? input.pythonPath.trim().slice(0, 1024) : undefined,
    timeoutMs: positiveInt(input.timeoutMs, DEFAULT_STT_CONFIG.timeoutMs),
    maxDurationMs: positiveInt(input.maxDurationMs, DEFAULT_STT_CONFIG.maxDurationMs),
    force16kMono: input.force16kMono !== false,
  };
}

function safeLanguage(value: unknown): string {
  return typeof value === "string" && /^[a-z]{2,8}(-[a-z0-9]{2,8})?$/i.test(value.trim())
    ? value.trim().slice(0, 16)
    : DEFAULT_STT_CONFIG.language;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function mlxModelName(model: string): string {
  if (model.includes("/")) {
    return model;
  }
  const normalized = model.trim().toLowerCase();
  if (normalized === "tiny") return "mlx-community/whisper-tiny-mlx";
  if (normalized === "small") return "mlx-community/whisper-small-mlx";
  if (normalized === "medium") return "mlx-community/whisper-medium-mlx";
  if (normalized === "large-v3-turbo") return "mlx-community/whisper-large-v3-turbo";
  return "mlx-community/whisper-base-mlx";
}

async function maybeConvertTo16kMono(inputWavPath: string, home: string, timeoutMs: number): Promise<string> {
  const ffmpeg = await firstCommand(["ffmpeg"]);
  if (!ffmpeg) {
    return inputWavPath;
  }
  const tmpDir = deckTmpDir(home);
  await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const output = path.join(tmpDir, `stt_${Date.now()}_${Math.random().toString(16).slice(2)}.wav`);
  await execFileSafe(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", inputWavPath, "-ac", "1", "-ar", "16000", output], {
    timeoutMs: Math.min(timeoutMs, 30_000),
  }).catch(() => null);
  const exists = await fs.stat(output).then((stat) => stat.isFile() && stat.size > 44).catch(() => false);
  return exists ? output : inputWavPath;
}

async function firstCommand(names: string[]): Promise<string | null> {
  for (const name of names) {
    const result = await execFileSafe("/bin/zsh", ["-lc", `command -v ${shellQuote(name)}`], { timeoutMs: 5_000 }).catch(() => null);
    const command = result?.stdout.trim().split(/\r?\n/)[0];
    if (command) {
      return command;
    }
  }
  return null;
}

async function readFirstTextFile(dir: string): Promise<string> {
  const entries = await fs.readdir(dir);
  const name = entries.find((entry) => entry.endsWith(".txt"));
  if (!name) {
    throw new Error("missing transcript output");
  }
  return fs.readFile(path.join(dir, name), "utf8");
}

function normalizeTranscript(text: string): string {
  return text.replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function execFileSafe(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = redactLogLine(String((error as Error).message || "STT command failed"));
        const stderrLine = redactLogLine(String(stderr || "").split(/\r?\n/)[0] ?? "");
        reject(new Error(stderrLine ? `${message}: ${stderrLine}` : message));
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}
