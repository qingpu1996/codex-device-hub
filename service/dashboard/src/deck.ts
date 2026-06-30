import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { writeJsonPrivate } from "./cache";
import type { CodexAppServerMonitor } from "./codexAppServer";
import { deckAudioDir, deckConfigPath, deckDir, deckJobsDir, deckSlotsPath } from "./paths";
import { redactLogLine, safeJsonParse } from "./util";

const DECK_TOKEN_BYTES = 32;
const JOB_ID_BYTES = 12;
const REQUEST_MAX_BYTES = 64 * 1024;
const AUDIO_MAX_BYTES = 8 * 1024 * 1024;
const AUDIO_MAX_DURATION_MS = 25_000;
const AUDIO_MIN_DURATION_MS = 300;
const FULL_REPLY_MAX_BYTES = 256 * 1024;
const TURN_TIMEOUT_MS = 180_000;
const CACHE_CONTROL = "no-store, no-cache, must-revalidate";
const CSP = "default-src 'none'; frame-ancestors 'none';";
const JOB_ID_PATTERN = /^(?:job|stt_job|codex_job)_[a-f0-9]{24}$/;
const AUDIO_JOB_ID_PATTERN = /^audio_job_[a-f0-9]{24}$/;
const STT_JOB_ID_PATTERN = /^stt_job_[a-f0-9]{24}$/;
const CODEX_JOB_ID_PATTERN = /^codex_job_[a-f0-9]{24}$/;
const TRANSCRIPT_MAX_CHARS = 4_000;
const SCREEN_TRANSCRIPT_MAX_CHARS = 500;

export type DeckSlotStatus = "idle" | "running" | "waiting_approval" | "error";
export type DeckJobStatus = "queued" | "running" | "waiting_approval" | "done" | "failed";
export type DeckJobType = "codex" | "stt";
export type DeckCodexStatus = "connected" | "disconnected" | "unknown";

export interface DeckConfig {
  deckToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeckSlot {
  id: string;
  title: string;
  subtitle: string;
  activeThreadId: string | null;
  lastSummary: string;
  status: DeckSlotStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DeckJob {
  id: string;
  type: DeckJobType;
  slotId: string;
  status: DeckJobStatus;
  inputText: string;
  wrappedPrompt: string;
  screenReply: string;
  fullReplyPath: string;
  errorMessage: string | null;
  audioJobId: string | null;
  transcript: string;
  screenTranscript: string;
  sourceAudioJobId: string | null;
  sourceSttJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicDeckSlot {
  id: string;
  title: string;
  subtitle: string;
  status: DeckSlotStatus;
  lastSummary: string;
}

export interface PublicDeckJob {
  jobId: string;
  type: DeckJobType;
  status: DeckJobStatus;
  slotId: string;
  screenReply: string;
  fullReplyAvailable: boolean;
  errorMessage: string | null;
  audioJobId: string | null;
  transcript: string;
  screenTranscript: string;
  sourceAudioJobId: string | null;
  sourceSttJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeckWavFormat {
  container: "wav";
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataSize: number;
  durationMs: number;
}

export interface DeckAudioJob {
  jobId: string;
  slotId: string;
  status: "audio_received";
  createdAt: string;
  bytes: number;
  sha256: string;
  wav: DeckWavFormat;
  transcript: DeckAudioTranscript;
}

export interface PublicDeckAudioJob {
  jobId: string;
  status: "audio_received";
  slotId: string;
  bytes: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  createdAt: string;
  transcript: DeckAudioTranscript;
}

export type DeckAudioTranscriptStatus = "not_started" | "transcribing" | "done" | "failed" | "unconfigured";

export interface DeckAudioTranscript {
  status: DeckAudioTranscriptStatus;
  text: string;
  language: string | null;
  engine: string | null;
  confidence: number | null;
  errorMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DeckSttInput {
  audioJob: DeckAudioJob;
  wavPath: string;
}

export interface DeckSttOptions {
  language?: string;
}

export interface DeckSttResult {
  text: string;
  language?: string | null;
  engine: string;
  confidence?: number | null;
}

export interface DeckSpeechClient {
  isAvailable?(): Promise<boolean>;
  transcribe(input: DeckSttInput, options?: DeckSttOptions): Promise<DeckSttResult>;
}

export interface DeckAudioTranscribeResult {
  job: DeckJob;
}

export interface CodexDeckRunInput {
  slot: DeckSlot;
  activeThreadId: string | null;
  wrappedPrompt: string;
}

export interface CodexDeckRunResult {
  threadId: string;
  screenReply: string;
  fullReply: string;
  status?: "done" | "waiting_approval";
}

export interface CodexDeckClient {
  getConnectionStatus(): DeckCodexStatus;
  runText(input: CodexDeckRunInput): Promise<CodexDeckRunResult>;
}

export const DEFAULT_DECK_SLOTS: ReadonlyArray<Pick<DeckSlot, "id" | "title" | "subtitle">> = [
  { id: "general", title: "GENERAL", subtitle: "Quick questions" },
  { id: "sisyphus", title: "SISYPHUS", subtitle: "Game project" },
  { id: "sisyphus-review", title: "SISYPHUS REVIEW", subtitle: "PR review / QA" },
  { id: "e1002", title: "E1002", subtitle: "E-paper dashboard" },
  { id: "deck", title: "DECK", subtitle: "Touch deck" },
];

export class DeckStore {
  constructor(private readonly home?: string) {}

  async ensureConfig(): Promise<DeckConfig> {
    const existing = await this.loadConfigOrNull();
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const config: DeckConfig = {
      deckToken: randomBytes(DECK_TOKEN_BYTES).toString("hex"),
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonPrivate(deckConfigPath(this.home), config);
    return config;
  }

  async ensureSlots(): Promise<DeckSlot[]> {
    const now = new Date().toISOString();
    const existing = await this.loadSlotsOrNull();
    const byId = new Map((existing ?? []).map((slot) => [slot.id, slot]));
    let changed = !existing;
    const slots = DEFAULT_DECK_SLOTS.map((defaults) => {
      const current = byId.get(defaults.id);
      if (!current) {
        changed = true;
        return defaultSlot(defaults, now);
      }
      const normalized = normalizeSlot(current, defaults, now);
      if (JSON.stringify(normalized) !== JSON.stringify(current)) {
        changed = true;
      }
      return normalized;
    });
    if (changed) {
      await this.saveSlots(slots);
    }
    return slots;
  }

  async getSlot(slotId: string): Promise<DeckSlot | null> {
    const slots = await this.ensureSlots();
    return slots.find((slot) => slot.id === slotId) ?? null;
  }

  async updateSlot(slotId: string, updater: (slot: DeckSlot) => DeckSlot): Promise<DeckSlot | null> {
    const slots = await this.ensureSlots();
    const index = slots.findIndex((slot) => slot.id === slotId);
    if (index < 0) {
      return null;
    }
    const next = updater(slots[index]);
    slots[index] = { ...next, updatedAt: new Date().toISOString() };
    await this.saveSlots(slots);
    return slots[index];
  }

  async createJob(slotId: string, inputText: string, wrappedPrompt: string): Promise<DeckJob> {
    const now = new Date().toISOString();
    const job: DeckJob = {
      id: randomJobId(),
      type: "codex",
      slotId,
      status: "queued",
      inputText,
      wrappedPrompt,
      screenReply: "",
      fullReplyPath: "",
      errorMessage: null,
      audioJobId: null,
      transcript: "",
      screenTranscript: "",
      sourceAudioJobId: null,
      sourceSttJobId: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveJob(job);
    return job;
  }

  async createCodexSendJob(
    slotId: string,
    transcript: string,
    wrappedPrompt: string,
    sourceAudioJobId: string | null,
    sourceSttJobId: string | null,
  ): Promise<DeckJob> {
    const now = new Date().toISOString();
    const cleanTranscript = truncateText(redactDeckPublicText(transcript), TRANSCRIPT_MAX_CHARS);
    const job: DeckJob = {
      id: randomCodexJobId(),
      type: "codex",
      slotId,
      status: "queued",
      inputText: cleanTranscript,
      wrappedPrompt,
      screenReply: "",
      fullReplyPath: "",
      errorMessage: null,
      audioJobId: null,
      transcript: cleanTranscript,
      screenTranscript: truncateScreenTranscript(cleanTranscript),
      sourceAudioJobId,
      sourceSttJobId,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveJob(job);
    return job;
  }

  async createSttJob(audioJob: DeckAudioJob): Promise<DeckJob> {
    const now = new Date().toISOString();
    const transcript = audioJob.transcript.status === "done" ? audioJob.transcript.text : "";
    const job: DeckJob = {
      id: randomSttJobId(),
      type: "stt",
      slotId: audioJob.slotId,
      status: transcript ? "done" : "queued",
      inputText: "",
      wrappedPrompt: "",
      screenReply: "",
      fullReplyPath: "",
      errorMessage: null,
      audioJobId: audioJob.jobId,
      transcript,
      screenTranscript: truncateScreenTranscript(transcript),
      sourceAudioJobId: audioJob.jobId,
      sourceSttJobId: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveJob(job);
    return job;
  }

  async loadJob(jobId: string): Promise<DeckJob | null> {
    if (!JOB_ID_PATTERN.test(jobId)) {
      return null;
    }
    try {
      const text = await fs.readFile(this.jobPath(jobId), "utf8");
      const parsed = safeJsonParse(text);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return normalizeJob(parsed as Partial<DeckJob>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async updateJob(jobId: string, updater: (job: DeckJob) => DeckJob): Promise<DeckJob | null> {
    const current = await this.loadJob(jobId);
    if (!current) {
      return null;
    }
    const next = updater(current);
    next.updatedAt = new Date().toISOString();
    await this.saveJob(next);
    return next;
  }

  async saveFullReply(jobId: string, text: string): Promise<string> {
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new Error("Invalid job id");
    }
    const limited = Buffer.from(text, "utf8").subarray(0, FULL_REPLY_MAX_BYTES).toString("utf8");
    const relativePath = path.join("jobs", `${jobId}.reply.txt`);
    const file = path.join(deckDir(this.home), relativePath);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, limited, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600);
    return relativePath;
  }

  async saveAudioUpload(slotId: string, wav: Buffer, format: DeckWavFormat): Promise<DeckAudioJob> {
    const now = new Date().toISOString();
    const jobId = randomAudioJobId();
    const sha256 = createHash("sha256").update(wav).digest("hex");
    const audioDir = deckAudioDir(this.home);
    const wavPath = path.join(audioDir, `${jobId}.wav`);
    const wavTmp = `${wavPath}.${process.pid}.tmp`;
    const metadata: DeckAudioJob = {
      jobId,
      slotId,
      status: "audio_received",
      createdAt: now,
      bytes: wav.length,
      sha256,
      wav: format,
      transcript: defaultAudioTranscript(),
    };

    await fs.mkdir(audioDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(wavTmp, wav, { mode: 0o600 });
    await fs.chmod(wavTmp, 0o600);
    await fs.rename(wavTmp, wavPath);
    await fs.chmod(wavPath, 0o600);
    await writeJsonPrivate(path.join(audioDir, `${jobId}.json`), metadata);
    return metadata;
  }

  async loadAudioJob(jobId: string): Promise<DeckAudioJob | null> {
    if (!AUDIO_JOB_ID_PATTERN.test(jobId)) {
      return null;
    }
    try {
      const text = await fs.readFile(path.join(deckAudioDir(this.home), `${jobId}.json`), "utf8");
      const parsed = safeJsonParse(text);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return normalizeAudioJob(parsed as Partial<DeckAudioJob>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async updateAudioJob(jobId: string, updater: (job: DeckAudioJob) => DeckAudioJob): Promise<DeckAudioJob | null> {
    const current = await this.loadAudioJob(jobId);
    if (!current) {
      return null;
    }
    const next = updater(current);
    await writeJsonPrivate(this.audioMetadataPath(jobId), next);
    return next;
  }

  audioWavPath(jobId: string): string | null {
    if (!AUDIO_JOB_ID_PATTERN.test(jobId)) {
      return null;
    }
    return path.join(deckAudioDir(this.home), `${jobId}.wav`);
  }

  private async loadConfigOrNull(): Promise<DeckConfig | null> {
    try {
      const text = await fs.readFile(deckConfigPath(this.home), "utf8");
      const parsed = safeJsonParse(text);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      const config = parsed as Partial<DeckConfig>;
      if (typeof config.deckToken !== "string" || !/^[a-f0-9]{64}$/.test(config.deckToken)) {
        return null;
      }
      return {
        deckToken: config.deckToken,
        createdAt: typeof config.createdAt === "string" ? config.createdAt : new Date().toISOString(),
        updatedAt: typeof config.updatedAt === "string" ? config.updatedAt : new Date().toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async loadSlotsOrNull(): Promise<DeckSlot[] | null> {
    try {
      const text = await fs.readFile(deckSlotsPath(this.home), "utf8");
      const parsed = safeJsonParse(text);
      if (!Array.isArray(parsed)) {
        return null;
      }
      return parsed.map((slot) => normalizeSlot(slot as Partial<DeckSlot>, null, new Date().toISOString()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async saveSlots(slots: DeckSlot[]): Promise<void> {
    await writeJsonPrivate(deckSlotsPath(this.home), slots);
  }

  private async saveJob(job: DeckJob): Promise<void> {
    await fs.mkdir(deckJobsDir(this.home), { recursive: true, mode: 0o700 });
    await writeJsonPrivate(this.jobPath(job.id), job);
  }

  private jobPath(jobId: string): string {
    return path.join(deckJobsDir(this.home), `${jobId}.json`);
  }

  private audioMetadataPath(jobId: string): string {
    return path.join(deckAudioDir(this.home), `${jobId}.json`);
  }
}

export class DeckService {
  constructor(
    private readonly store: DeckStore,
    private readonly client: CodexDeckClient,
    private readonly speechClient: DeckSpeechClient = new UnconfiguredDeckSpeechClient(),
  ) {}

  async isAuthorized(token: string): Promise<boolean> {
    const config = await this.store.ensureConfig();
    return token === config.deckToken;
  }

  async getHealth(): Promise<{ ok: true; service: "codex-deck"; codex: DeckCodexStatus; storage: "ok" | "error" }> {
    try {
      await this.store.ensureConfig();
      await this.store.ensureSlots();
      return {
        ok: true,
        service: "codex-deck",
        codex: this.client.getConnectionStatus(),
        storage: "ok",
      };
    } catch {
      return {
        ok: true,
        service: "codex-deck",
        codex: this.client.getConnectionStatus(),
        storage: "error",
      };
    }
  }

  async listPublicSlots(): Promise<PublicDeckSlot[]> {
    return (await this.store.ensureSlots()).map(publicSlot);
  }

  async getPublicSlot(slotId: string): Promise<PublicDeckSlot | null> {
    const slot = await this.store.getSlot(slotId);
    return slot ? publicSlot(slot) : null;
  }

  async submitTextJob(slotId: string, text: string): Promise<DeckJob | null> {
    const slot = await this.store.getSlot(slotId);
    if (!slot) {
      return null;
    }
    const inputText = text.trim().slice(0, 4_000);
    const wrappedPrompt = wrapPrompt(slot, inputText, "debug");
    const job = await this.store.createJob(slot.id, inputText, wrappedPrompt);
    const running = await this.store.updateJob(job.id, (current) => ({ ...current, status: "running" }));
    await this.store.updateSlot(slot.id, (current) => ({ ...current, status: "running" }));
    void this.runJob(job.id).catch((error) => {
      console.error(`[deck] background job failed: ${redactLogLine(shortError(error))}`);
    });
    return running ?? job;
  }

  async submitCodexSendJob(
    slotId: string,
    transcript: string,
    sourceAudioJobId: string | null,
    sourceSttJobId: string | null,
  ): Promise<DeckJob | null> {
    const slot = await this.store.getSlot(slotId);
    if (!slot) {
      return null;
    }
    const inputText = truncateText(redactDeckPublicText(transcript.trim()), TRANSCRIPT_MAX_CHARS);
    const wrappedPrompt = wrapPrompt(slot, inputText, "voice");
    const job = await this.store.createCodexSendJob(
      slot.id,
      inputText,
      wrappedPrompt,
      validAudioJobId(sourceAudioJobId) ? sourceAudioJobId : null,
      validSttJobId(sourceSttJobId) ? sourceSttJobId : null,
    );
    const running = await this.store.updateJob(job.id, (current) => ({ ...current, status: "running" }));
    await this.store.updateSlot(slot.id, (current) => ({ ...current, status: "running" }));
    void this.runJob(job.id).catch((error) => {
      console.error(`[deck] background codex job failed: ${redactLogLine(shortError(error))}`);
    });
    return running ?? job;
  }

  async getPublicJob(jobId: string): Promise<PublicDeckJob | null> {
    const job = await this.store.loadJob(jobId);
    return job ? publicJob(job) : null;
  }

  async receiveAudio(slotId: string, wav: Buffer): Promise<DeckAudioJob | null> {
    const slot = await this.store.getSlot(slotId);
    if (!slot) {
      return null;
    }
    const format = parsePcmWav(wav);
    return this.store.saveAudioUpload(slot.id, wav, format);
  }

  async getPublicAudioJob(jobId: string): Promise<PublicDeckAudioJob | null> {
    const job = await this.store.loadAudioJob(jobId);
    return job ? publicAudioJob(job) : null;
  }

  async submitAudioTranscriptionJob(jobId: string, options: DeckSttOptions & { force?: boolean } = {}): Promise<DeckAudioTranscribeResult | null> {
    const audioJob = await this.store.loadAudioJob(jobId);
    const wavPath = this.store.audioWavPath(jobId);
    if (!audioJob || !wavPath) {
      return null;
    }
    if (audioJob.transcript.status === "done" && !options.force) {
      const job = await this.store.createSttJob(audioJob);
      return { job };
    }
    const job = await this.store.createSttJob(audioJob);
    const running = await this.store.updateJob(job.id, (current) => ({
      ...current,
      status: "running",
      errorMessage: null,
    }));
    void this.runSttJob(job.id, options).catch((error) => {
      console.error(`[deck] background stt job failed: ${redactLogLine(shortError(error))}`);
    });
    return { job: running ?? job };
  }

  private async runSttJob(jobId: string, options: DeckSttOptions = {}): Promise<void> {
    const job = await this.store.loadJob(jobId);
    if (!job || job.type !== "stt" || !job.audioJobId) {
      return;
    }
    const audioJob = await this.store.loadAudioJob(job.audioJobId);
    const wavPath = this.store.audioWavPath(job.audioJobId);
    if (!audioJob || !wavPath) {
      await this.store.updateJob(job.id, (current) => ({
        ...current,
        status: "failed",
        errorMessage: "Audio job not found",
      }));
      return;
    }
    const startedAt = new Date().toISOString();
    await this.store.updateJob(job.id, (current) => ({
      ...current,
      status: "running",
      errorMessage: null,
    }));
    const transcribing = await this.store.updateAudioJob(job.audioJobId, (current) => ({
      ...current,
      transcript: {
        status: "transcribing",
        text: "",
        language: null,
        engine: null,
        confidence: null,
        errorMessage: null,
        createdAt: current.transcript.createdAt ?? startedAt,
        updatedAt: startedAt,
      },
    }));
    try {
      const result = await this.speechClient.transcribe({ audioJob: transcribing ?? audioJob, wavPath }, options);
      const now = new Date().toISOString();
      const text = truncateText(redactDeckPublicText(result.text), TRANSCRIPT_MAX_CHARS);
      const screenTranscript = truncateScreenTranscript(text);
      const done = await this.store.updateAudioJob(job.audioJobId!, (current) => ({
        ...current,
        transcript: {
          status: "done",
          text,
          language: result.language ?? null,
          engine: result.engine,
          confidence: typeof result.confidence === "number" && Number.isFinite(result.confidence) ? result.confidence : null,
          errorMessage: null,
          createdAt: current.transcript.createdAt ?? startedAt,
          updatedAt: now,
        },
      }));
      await this.store.updateJob(job.id, (current) => ({
        ...current,
        status: "done",
        transcript: done?.transcript.text ?? text,
        screenTranscript,
        errorMessage: null,
      }));
    } catch (error) {
      const now = new Date().toISOString();
      const unavailable = error instanceof DeckSttUnavailableError;
      const failed = await this.store.updateAudioJob(job.audioJobId!, (current) => ({
        ...current,
        transcript: {
          status: "failed",
          text: "",
          language: null,
          engine: unavailable ? "unconfigured" : null,
          confidence: null,
          errorMessage: unavailable ? "STT UNAVAILABLE" : shortError(error),
          createdAt: current.transcript.createdAt ?? startedAt,
          updatedAt: now,
        },
      }));
      await this.store.updateJob(job.id, (current) => ({
        ...current,
        status: "failed",
        errorMessage: failed?.transcript.errorMessage ?? (unavailable ? "STT UNAVAILABLE" : shortError(error)),
      }));
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const job = await this.store.loadJob(jobId);
    if (!job) {
      return;
    }
    if (job.type === "stt") {
      await this.runSttJob(jobId);
      return;
    }
    const slot = await this.store.getSlot(job.slotId);
    if (!slot) {
      await this.store.updateJob(job.id, (current) => ({
        ...current,
        status: "failed",
        errorMessage: "Slot not found",
      }));
      return;
    }

    try {
      const result = await this.client.runText({
        slot,
        activeThreadId: slot.activeThreadId,
        wrappedPrompt: job.wrappedPrompt,
      });
      const threadId = slot.activeThreadId ?? result.threadId;
      const fullReply = redactDeckPublicText(result.fullReply || result.screenReply || "");
      const screenReply = truncateScreenReply(redactDeckPublicText(result.screenReply || fullReply || "任务已完成。"));
      const fullReplyPath = fullReply ? await this.store.saveFullReply(job.id, fullReply) : "";
      const status = result.status === "waiting_approval" ? "waiting_approval" : "done";
      const slotStatus = result.status === "waiting_approval" ? "waiting_approval" : "idle";
      await this.store.updateJob(job.id, (current) => ({
        ...current,
        status,
        screenReply,
        fullReplyPath,
        errorMessage: null,
      }));
      await this.store.updateSlot(slot.id, (current) => ({
        ...current,
        activeThreadId: threadId,
        status: slotStatus,
        lastSummary: truncateSlotSummary(screenReply),
      }));
    } catch (error) {
      const message = shortError(error);
      await this.store.updateJob(job.id, (current) => ({
        ...current,
        status: "failed",
        errorMessage: message,
      }));
      await this.store.updateSlot(slot.id, (current) => ({
        ...current,
        status: "error",
        lastSummary: truncateSlotSummary(message),
      }));
      console.error(`[deck] job ${job.id} failed: ${redactLogLine(message)}`);
    }
  }
}

export class UnavailableCodexDeckClient implements CodexDeckClient {
  getConnectionStatus(): DeckCodexStatus {
    return "unknown";
  }

  async runText(): Promise<CodexDeckRunResult> {
    throw new Error("Codex App Server is not attached");
  }
}

export class DeckSttUnavailableError extends Error {
  constructor(message = "Speech-to-text is not configured") {
    super(message);
  }
}

export class UnconfiguredDeckSpeechClient implements DeckSpeechClient {
  async transcribe(): Promise<DeckSttResult> {
    throw new DeckSttUnavailableError();
  }
}

export class AppServerCodexDeckClient implements CodexDeckClient {
  constructor(
    private readonly monitor: CodexAppServerMonitor,
    private readonly cwd: string,
  ) {}

  getConnectionStatus(): DeckCodexStatus {
    return this.monitor.getStatus().connected ? "connected" : "disconnected";
  }

  async runText(input: CodexDeckRunInput): Promise<CodexDeckRunResult> {
    const threadId = input.activeThreadId
      ? await this.resumeThread(input.activeThreadId)
      : await this.startThread();
    const collector = this.createTurnCollector(threadId);
    try {
      const response = await this.monitor.requestAppServer(
        "turn/start",
        {
          threadId,
          input: [
            {
              type: "text",
              text: input.wrappedPrompt,
              text_elements: [],
            },
          ],
        },
        TURN_TIMEOUT_MS,
      );
      const turn = extractTurn(response);
      const completedTurn = turn.status === "completed"
        ? turn
        : await collector.waitForCompletion(turn.id);
      if (completedTurn.status === "failed") {
        throw new Error(completedTurn.error?.message ?? "Codex turn failed");
      }
      const fullReply = extractAssistantText(completedTurn) || collector.textFor(turn.id);
      return {
        threadId,
        screenReply: truncateScreenReply(fullReply || "Codex 已完成，但没有返回可显示文字。"),
        fullReply,
        status: "done",
      };
    } finally {
      collector.dispose();
    }
  }

  private async startThread(): Promise<string> {
    const response = await this.monitor.requestAppServer(
      "thread/start",
      {
        cwd: this.cwd,
        serviceName: "codex-deck",
        ephemeral: false,
        threadSource: "codex-deck",
      },
      TURN_TIMEOUT_MS,
    );
    return extractThreadId(response);
  }

  private async resumeThread(threadId: string): Promise<string> {
    const response = await this.monitor.requestAppServer(
      "thread/resume",
      {
        threadId,
        cwd: this.cwd,
      },
      TURN_TIMEOUT_MS,
    );
    return extractThreadId(response);
  }

  private createTurnCollector(threadId: string): TurnCollector {
    const deltas = new Map<string, string>();
    const completed = new Map<string, AppServerTurn>();
    const waiters = new Map<string, { resolve: (turn: AppServerTurn) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    const cleanupWaiter = (turnId: string) => {
      const waiter = waiters.get(turnId);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(turnId);
      }
    };
    const onNotification = (notification: { method: string; params?: unknown }) => {
      const params = asRecord(notification.params);
      if (params?.threadId !== threadId) {
        return;
      }
      if (notification.method === "item/agentMessage/delta" && typeof params.turnId === "string" && typeof params.delta === "string") {
        deltas.set(params.turnId, `${deltas.get(params.turnId) ?? ""}${params.delta}`);
        return;
      }
      if (notification.method === "item/completed" && typeof params.turnId === "string") {
        const item = asRecord(params.item);
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          deltas.set(params.turnId, item.text);
        }
        return;
      }
      if (notification.method !== "turn/completed") {
        return;
      }
      const turn = asRecord(params.turn);
      if (!turn) {
        return;
      }
      const normalized = normalizeTurn(turn);
      completed.set(normalized.id, normalized);
      const waiter = waiters.get(normalized.id);
      if (waiter) {
        cleanupWaiter(normalized.id);
        waiter.resolve(normalized);
      }
    };
    this.monitor.on("notification", onNotification);
    return {
      waitForCompletion: (turnId: string) => {
        const existing = completed.get(turnId);
        if (existing) {
          return Promise.resolve(existing);
        }
        return new Promise<AppServerTurn>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanupWaiter(turnId);
            reject(new Error("Codex turn timed out"));
          }, TURN_TIMEOUT_MS);
          waiters.set(turnId, { resolve, reject, timer });
        });
      },
      textFor: (turnId: string) => deltas.get(turnId)?.trim() ?? "",
      dispose: () => {
        this.monitor.off("notification", onNotification);
        for (const [turnId, waiter] of waiters.entries()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("Codex turn collector disposed"));
          waiters.delete(turnId);
        }
      },
    };
  }
}

export async function handleDeckHttpRequest(
  service: DeckService,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const deckPrefix = "/api/deck/";
  if (!url.pathname.startsWith(deckPrefix)) {
    return false;
  }

  const suffix = url.pathname.slice(deckPrefix.length);
  const [encodedToken = "", ...subpathParts] = suffix.split("/");
  const token = decodeURIComponent(encodedToken);
  if (!(await service.isAuthorized(token))) {
    notFound(response);
    return true;
  }

  const method = request.method ?? "GET";
  const subpath = subpathParts.map((part) => decodeURIComponent(part)).filter(Boolean);

  if ((method === "GET" || method === "HEAD") && subpath.length === 1 && subpath[0] === "health") {
    json(response, await service.getHealth(), 200);
    return true;
  }

  if ((method === "GET" || method === "HEAD") && subpath.length === 1 && subpath[0] === "slots") {
    json(response, await service.listPublicSlots(), 200);
    return true;
  }

  if ((method === "GET" || method === "HEAD") && subpath.length === 2 && subpath[0] === "slots") {
    const slot = await service.getPublicSlot(subpath[1]);
    if (!slot) {
      notFound(response);
      return true;
    }
    json(response, slot, 200);
    return true;
  }

  if (method === "POST" && subpath.length === 2 && subpath[0] === "debug" && subpath[1] === "text") {
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object") {
      json(response, { error: "invalid_json" }, 400);
      return true;
    }
    const payload = body as Record<string, unknown>;
    if (typeof payload.slotId !== "string" || !payload.slotId.trim()) {
      json(response, { error: "missing_slotId" }, 400);
      return true;
    }
    if (typeof payload.text !== "string" || !payload.text.trim()) {
      json(response, { error: "missing_text" }, 400);
      return true;
    }
    const job = await service.submitTextJob(payload.slotId.trim(), payload.text);
    if (!job) {
      notFound(response);
      return true;
    }
    json(response, { jobId: job.id, status: "running" }, 200);
    return true;
  }

  if (method === "POST" && subpath.length === 2 && subpath[0] === "audio" && subpath[1] === "utterance") {
    const slotId = url.searchParams.get("slotId")?.trim() ?? "";
    if (!slotId) {
      json(response, { status: "failed", errorCode: "missing_slotId", message: "Missing slotId" }, 400);
      return true;
    }
    const slot = await service.getPublicSlot(slotId);
    if (!slot) {
      notFound(response);
      return true;
    }
    const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.split(";")[0].trim().match(/^audio\/(?:wav|wave|x-wav)$/)) {
      json(response, { status: "failed", errorCode: "unsupported_media_type", message: "Content-Type must be audio/wav" }, 415);
      return true;
    }
    const body = await readBinaryBody(request, AUDIO_MAX_BYTES);
    if (body.tooLarge) {
      json(response, { status: "failed", errorCode: "payload_too_large", message: "WAV body is too large" }, 413);
      return true;
    }
    try {
      const audioJob = await service.receiveAudio(slotId, body.buffer);
      if (!audioJob) {
        notFound(response);
        return true;
      }
      json(response, {
        jobId: audioJob.jobId,
        status: audioJob.status,
        slotId: audioJob.slotId,
        bytes: audioJob.bytes,
        format: {
          container: "wav",
          sampleRate: audioJob.wav.sampleRate,
          bitsPerSample: audioJob.wav.bitsPerSample,
          channels: audioJob.wav.channels,
          durationMs: audioJob.wav.durationMs,
        },
        message: "Audio received",
      }, 200);
    } catch (error) {
      const wavError = error instanceof WavValidationError ? error : new WavValidationError("invalid_wav", "Invalid WAV header");
      json(response, { status: "failed", errorCode: wavError.code, message: wavError.message }, wavError.code === "too_long" ? 400 : 400);
    }
    return true;
  }

  if ((method === "GET" || method === "HEAD") && subpath.length === 2 && subpath[0] === "jobs") {
    const job = await service.getPublicJob(subpath[1]);
    if (!job) {
      notFound(response);
      return true;
    }
    json(response, job, 200);
    return true;
  }

  if ((method === "GET" || method === "HEAD") && subpath.length === 2 && subpath[0] === "audio") {
    const job = await service.getPublicAudioJob(subpath[1]);
    if (!job) {
      notFound(response);
      return true;
    }
    json(response, job, 200);
    return true;
  }

  if (method === "POST" && subpath.length === 3 && subpath[0] === "audio" && subpath[2] === "transcribe") {
    const body = await readJsonBody(request, true);
    const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const language = typeof payload.language === "string" ? payload.language : undefined;
    const force = payload.force === true;
    const result = await service.submitAudioTranscriptionJob(subpath[1], { language, force });
    if (!result) {
      notFound(response);
      return true;
    }
    json(response, {
      jobId: result.job.id,
      status: result.job.status,
      audioJobId: result.job.audioJobId,
      slotId: result.job.slotId,
      ...(result.job.status === "done" ? {
        transcript: result.job.transcript,
        screenTranscript: result.job.screenTranscript,
      } : {}),
      ...(result.job.status === "failed" ? {
        errorMessage: result.job.errorMessage,
      } : {}),
    }, 200);
    return true;
  }

  if (method === "POST" && subpath.length === 2 && subpath[0] === "codex" && subpath[1] === "send") {
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object") {
      json(response, { error: "invalid_json" }, 400);
      return true;
    }
    const payload = body as Record<string, unknown>;
    const slotId = typeof payload.slotId === "string" ? payload.slotId.trim() : "";
    const transcript = typeof payload.transcript === "string" ? payload.transcript.trim() : "";
    if (!slotId) {
      json(response, { error: "missing_slotId" }, 400);
      return true;
    }
    if (!transcript) {
      json(response, { error: "missing_transcript" }, 400);
      return true;
    }
    if (transcript.length > TRANSCRIPT_MAX_CHARS) {
      json(response, { error: "transcript_too_long" }, 400);
      return true;
    }
    const job = await service.submitCodexSendJob(
      slotId,
      transcript,
      typeof payload.sourceAudioJobId === "string" ? payload.sourceAudioJobId : null,
      typeof payload.sourceSttJobId === "string" ? payload.sourceSttJobId : null,
    );
    if (!job) {
      notFound(response);
      return true;
    }
    json(response, { jobId: job.id, status: job.status }, 200);
    return true;
  }

  notFound(response);
  return true;
}

export function publicSlot(slot: DeckSlot): PublicDeckSlot {
  return {
    id: slot.id,
    title: slot.title,
    subtitle: slot.subtitle,
    status: slot.status,
    lastSummary: redactDeckPublicText(slot.lastSummary),
  };
}

export function publicJob(job: DeckJob): PublicDeckJob {
  return {
    jobId: job.id,
    type: job.type,
    status: job.status,
    slotId: job.slotId,
    screenReply: redactDeckPublicText(job.screenReply),
    fullReplyAvailable: Boolean(job.fullReplyPath),
    errorMessage: job.errorMessage ? redactDeckPublicText(job.errorMessage) : null,
    audioJobId: validAudioJobId(job.audioJobId) ? job.audioJobId : null,
    transcript: truncateText(redactDeckPublicText(job.transcript), TRANSCRIPT_MAX_CHARS),
    screenTranscript: truncateScreenTranscript(redactDeckPublicText(job.screenTranscript || job.transcript)),
    sourceAudioJobId: validAudioJobId(job.sourceAudioJobId) ? job.sourceAudioJobId : null,
    sourceSttJobId: validSttJobId(job.sourceSttJobId) ? job.sourceSttJobId : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function publicAudioJob(job: DeckAudioJob): PublicDeckAudioJob {
  return {
    jobId: job.jobId,
    status: "audio_received",
    slotId: job.slotId,
    bytes: job.bytes,
    durationMs: job.wav.durationMs,
    sampleRate: job.wav.sampleRate,
    channels: job.wav.channels,
    bitsPerSample: job.wav.bitsPerSample,
    createdAt: job.createdAt,
    transcript: publicAudioTranscript(job.transcript),
  };
}

export function publicAudioTranscript(transcript: DeckAudioTranscript): DeckAudioTranscript {
  return {
    status: transcript.status,
    text: truncateText(redactDeckPublicText(transcript.text), 4_000),
    language: transcript.language,
    engine: transcript.engine,
    confidence: transcript.confidence,
    errorMessage: transcript.errorMessage ? shortError(transcript.errorMessage) : null,
    createdAt: transcript.createdAt,
    updatedAt: transcript.updatedAt,
  };
}

export function maskToken(token: string): string {
  if (token.length <= 8) {
    return "****";
  }
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

export function wrapPrompt(slot: Pick<DeckSlot, "id" | "title" | "subtitle">, text: string, source: "debug" | "voice" = "debug"): string {
  if (slot.id === "general") {
    return `你是我的桌面快速问答助手。
请只用简短文字回答。
除非我明确要求你操作仓库、修改文件或运行命令，否则不要执行工程操作。
回答适配 172x640 小屏：
- 先给一句结论
- 再给最多 3 条要点
- 总长度尽量控制在 300 个中文字符以内

用户输入如下：

${text}`;
  }
  const taskKind = source === "voice" ? "语音任务" : "任务";
  const inputLabel = source === "voice" ? "用户语音转写如下：" : "用户输入如下：";
  return `这是来自我的桌面 Codex Deck 的${taskKind}。
目标槽位：${slot.title}
槽位说明：${slot.subtitle}

请先理解任务。
如果这是项目开发任务，请遵循当前 Codex 会话和仓库上下文。
如果需要实际修改文件或运行命令，请按 Codex 的正常安全策略执行。
回复需要包含一个适合 172x640 小屏显示的简短摘要。

${inputLabel}

${text}`;
}

export function truncateScreenReply(text: string): string {
  return truncateText(text, containsCjk(text) ? 300 : 600);
}

export function truncateScreenTranscript(text: string): string {
  return truncateText(text, containsCjk(text) ? SCREEN_TRANSCRIPT_MAX_CHARS : 900);
}

export function truncateSlotSummary(text: string): string {
  return truncateText(text, containsCjk(text) ? 80 : 160);
}

export function redactDeckPublicText(text: string): string {
  return text
    .replace(/~\/\.codex\/auth\.json/gi, "[redacted-auth-file]")
    .replace(/\.codex\/auth\.json/gi, "[redacted-auth-file]")
    .replace(/auth\.json/gi, "[redacted-auth-file]")
    .replace(/OpenAI\s+API\s*key/gi, "OpenAI [redacted-key]")
    .replace(/OAuth\s+token/gi, "OAuth [redacted-token]")
    .replace(/Cookie/gi, "[redacted-cookie]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9+/_=-]{48,}/g, "[redacted]");
}

function defaultSlot(defaults: Pick<DeckSlot, "id" | "title" | "subtitle">, now: string): DeckSlot {
  return {
    ...defaults,
    activeThreadId: null,
    lastSummary: "",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeSlot(
  input: Partial<DeckSlot>,
  defaults: Pick<DeckSlot, "id" | "title" | "subtitle"> | null,
  now: string,
): DeckSlot {
  const id = defaults?.id ?? (typeof input.id === "string" ? input.id : "");
  const fallback = DEFAULT_DECK_SLOTS.find((slot) => slot.id === id);
  return {
    id,
    title: defaults?.title ?? fallback?.title ?? (typeof input.title === "string" ? input.title : id.toUpperCase()),
    subtitle: defaults?.subtitle ?? fallback?.subtitle ?? (typeof input.subtitle === "string" ? input.subtitle : ""),
    activeThreadId: typeof input.activeThreadId === "string" && input.activeThreadId ? input.activeThreadId : null,
    lastSummary: typeof input.lastSummary === "string" ? truncateSlotSummary(redactDeckPublicText(input.lastSummary)) : "",
    status: isSlotStatus(input.status) ? input.status : "idle",
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now,
  };
}

function normalizeJob(input: Partial<DeckJob>): DeckJob | null {
  if (typeof input.id !== "string" || !JOB_ID_PATTERN.test(input.id)) {
    return null;
  }
  if (typeof input.slotId !== "string" || !input.slotId) {
    return null;
  }
  const now = new Date().toISOString();
  const transcript = typeof input.transcript === "string" ? truncateText(redactDeckPublicText(input.transcript), TRANSCRIPT_MAX_CHARS) : "";
  return {
    id: input.id,
    type: input.type === "stt" ? "stt" : "codex",
    slotId: input.slotId,
    status: isJobStatus(input.status) ? input.status : "failed",
    inputText: typeof input.inputText === "string" ? input.inputText : "",
    wrappedPrompt: typeof input.wrappedPrompt === "string" ? input.wrappedPrompt : "",
    screenReply: typeof input.screenReply === "string" ? truncateScreenReply(redactDeckPublicText(input.screenReply)) : "",
    fullReplyPath: typeof input.fullReplyPath === "string" && input.fullReplyPath.startsWith("jobs/") ? input.fullReplyPath : "",
    errorMessage: typeof input.errorMessage === "string" ? shortError(input.errorMessage) : null,
    audioJobId: validAudioJobId(input.audioJobId) ? input.audioJobId : null,
    transcript,
    screenTranscript: typeof input.screenTranscript === "string" ? truncateScreenTranscript(redactDeckPublicText(input.screenTranscript)) : truncateScreenTranscript(transcript),
    sourceAudioJobId: validAudioJobId(input.sourceAudioJobId) ? input.sourceAudioJobId : null,
    sourceSttJobId: validSttJobId(input.sourceSttJobId) ? input.sourceSttJobId : null,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now,
  };
}

function isSlotStatus(value: unknown): value is DeckSlotStatus {
  return value === "idle" || value === "running" || value === "waiting_approval" || value === "error";
}

function isJobStatus(value: unknown): value is DeckJobStatus {
  return value === "queued" || value === "running" || value === "waiting_approval" || value === "done" || value === "failed";
}

function randomJobId(): string {
  return `job_${randomBytes(JOB_ID_BYTES).toString("hex")}`;
}

function randomSttJobId(): string {
  return `stt_job_${randomBytes(JOB_ID_BYTES).toString("hex")}`;
}

function randomCodexJobId(): string {
  return `codex_job_${randomBytes(JOB_ID_BYTES).toString("hex")}`;
}

function randomAudioJobId(): string {
  return `audio_job_${randomBytes(JOB_ID_BYTES).toString("hex")}`;
}

function validAudioJobId(value: unknown): value is string {
  return typeof value === "string" && AUDIO_JOB_ID_PATTERN.test(value);
}

function validSttJobId(value: unknown): value is string {
  return typeof value === "string" && STT_JOB_ID_PATTERN.test(value);
}

function validCodexJobId(value: unknown): value is string {
  return typeof value === "string" && CODEX_JOB_ID_PATTERN.test(value);
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/\r?\n/)[0] ?? "Deck job failed";
  return truncateText(redactDeckPublicText(redactLogLine(firstLine)), 180) || "Deck job failed";
}

export class WavValidationError extends Error {
  constructor(
    readonly code: "invalid_wav" | "too_long",
    message: string,
  ) {
    super(message);
  }
}

export function parsePcmWav(buffer: Buffer): DeckWavFormat {
  if (buffer.length < 44) {
    throw new WavValidationError("invalid_wav", "WAV file is too short");
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new WavValidationError("invalid_wav", "Invalid WAV header");
  }

  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + size > buffer.length) {
      throw new WavValidationError("invalid_wav", "Invalid WAV chunk size");
    }
    if (id === "fmt ") {
      if (size < 16) {
        throw new WavValidationError("invalid_wav", "Invalid WAV fmt chunk");
      }
      fmt = {
        audioFormat: buffer.readUInt16LE(dataOffset),
        channels: buffer.readUInt16LE(dataOffset + 2),
        sampleRate: buffer.readUInt32LE(dataOffset + 4),
        bitsPerSample: buffer.readUInt16LE(dataOffset + 14),
      };
    } else if (id === "data") {
      dataSize = size;
    }
    offset = dataOffset + size + (size % 2);
  }

  if (!fmt || dataSize <= 0) {
    throw new WavValidationError("invalid_wav", "Invalid WAV header");
  }
  if (fmt.audioFormat !== 1) {
    throw new WavValidationError("invalid_wav", "Only PCM WAV is supported");
  }
  if (!Number.isFinite(fmt.sampleRate) || fmt.sampleRate <= 0 || fmt.sampleRate > 192_000) {
    throw new WavValidationError("invalid_wav", "Invalid WAV sample rate");
  }
  if (fmt.channels < 1 || fmt.channels > 2) {
    throw new WavValidationError("invalid_wav", "Invalid WAV channel count");
  }
  if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
    throw new WavValidationError("invalid_wav", "Invalid WAV bit depth");
  }
  const bytesPerSample = fmt.bitsPerSample / 8;
  const durationMs = Math.round((dataSize / (fmt.sampleRate * fmt.channels * bytesPerSample)) * 1000);
  if (!Number.isFinite(durationMs) || durationMs < AUDIO_MIN_DURATION_MS) {
    throw new WavValidationError("invalid_wav", "WAV file is too short");
  }
  if (durationMs > AUDIO_MAX_DURATION_MS) {
    throw new WavValidationError("too_long", "WAV duration is too long");
  }

  return {
    container: "wav",
    audioFormat: fmt.audioFormat,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    dataSize,
    durationMs,
  };
}

async function readJsonBody(request: IncomingMessage, allowEmpty = false): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > REQUEST_MAX_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim() && allowEmpty) {
    return {};
  }
  return safeJsonParse(text);
}

async function readBinaryBody(request: IncomingMessage, maxBytes: number): Promise<{ buffer: Buffer; tooLarge: boolean }> {
  const length = Number(request.headers["content-length"] ?? "");
  if (Number.isFinite(length) && length > maxBytes) {
    for await (const _ of request) {
      // Drain request body so the socket can be reused.
    }
    return { buffer: Buffer.alloc(0), tooLarge: true };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      return { buffer: Buffer.alloc(0), tooLarge: true };
    }
    chunks.push(buffer);
  }
  return { buffer: Buffer.concat(chunks), tooLarge: false };
}

function normalizeAudioJob(input: Partial<DeckAudioJob>): DeckAudioJob | null {
  if (typeof input.jobId !== "string" || !AUDIO_JOB_ID_PATTERN.test(input.jobId)) {
    return null;
  }
  if (typeof input.slotId !== "string" || !input.slotId) {
    return null;
  }
  const wav = input.wav;
  if (!wav || typeof wav !== "object") {
    return null;
  }
  const now = new Date().toISOString();
  return {
    jobId: input.jobId,
    slotId: input.slotId,
    status: "audio_received",
    createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
    bytes: typeof input.bytes === "number" && Number.isFinite(input.bytes) ? input.bytes : 0,
    sha256: typeof input.sha256 === "string" ? input.sha256 : "",
    wav: {
      container: "wav",
      audioFormat: typeof wav.audioFormat === "number" ? wav.audioFormat : 1,
      channels: typeof wav.channels === "number" ? wav.channels : 0,
      sampleRate: typeof wav.sampleRate === "number" ? wav.sampleRate : 0,
      bitsPerSample: typeof wav.bitsPerSample === "number" ? wav.bitsPerSample : 0,
      dataSize: typeof wav.dataSize === "number" ? wav.dataSize : 0,
      durationMs: typeof wav.durationMs === "number" ? wav.durationMs : 0,
    },
    transcript: normalizeAudioTranscript(input.transcript),
  };
}

function defaultAudioTranscript(): DeckAudioTranscript {
  return {
    status: "not_started",
    text: "",
    language: null,
    engine: null,
    confidence: null,
    errorMessage: null,
    createdAt: null,
    updatedAt: null,
  };
}

function normalizeAudioTranscript(input: unknown): DeckAudioTranscript {
  if (!input || typeof input !== "object") {
    return defaultAudioTranscript();
  }
  const value = input as Partial<DeckAudioTranscript>;
  return {
    status: isAudioTranscriptStatus(value.status) ? value.status : "not_started",
    text: typeof value.text === "string" ? truncateText(redactDeckPublicText(value.text), 4_000) : "",
    language: typeof value.language === "string" && value.language ? value.language : null,
    engine: typeof value.engine === "string" && value.engine ? value.engine : null,
    confidence: typeof value.confidence === "number" && Number.isFinite(value.confidence) ? value.confidence : null,
    errorMessage: typeof value.errorMessage === "string" && value.errorMessage ? shortError(value.errorMessage) : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function isAudioTranscriptStatus(value: unknown): value is DeckAudioTranscriptStatus {
  return value === "not_started" ||
    value === "transcribing" ||
    value === "done" ||
    value === "failed" ||
    value === "unconfigured";
}

function json(response: ServerResponse, value: unknown, statusCode: number): void {
  const body = `${JSON.stringify(value)}\n`;
  response.setHeader("Cache-Control", CACHE_CONTROL);
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.setHeader("Content-Security-Policy", CSP);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(response.req.method === "HEAD" ? undefined : body);
}

function notFound(response: ServerResponse): void {
  response.setHeader("Cache-Control", CACHE_CONTROL);
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.setHeader("Content-Security-Policy", CSP);
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(response.req.method === "HEAD" ? undefined : "Not Found\n");
}

interface AppServerTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message?: string } | null;
  items: Array<Record<string, unknown>>;
}

interface TurnCollector {
  waitForCompletion(turnId: string): Promise<AppServerTurn>;
  textFor(turnId: string): string;
  dispose(): void;
}

function extractThreadId(response: unknown): string {
  const record = asRecord(response);
  const thread = asRecord(record?.thread);
  if (typeof thread?.id !== "string" || !thread.id) {
    throw new Error("Codex thread response did not include thread id");
  }
  return thread.id;
}

function extractTurn(response: unknown): AppServerTurn {
  const record = asRecord(response);
  const turn = asRecord(record?.turn);
  if (!turn) {
    throw new Error("Codex turn response did not include turn");
  }
  return normalizeTurn(turn);
}

function normalizeTurn(turn: Record<string, unknown>): AppServerTurn {
  if (typeof turn.id !== "string" || !turn.id) {
    throw new Error("Codex turn is missing id");
  }
  const status = turn.status === "completed" || turn.status === "interrupted" || turn.status === "failed" || turn.status === "inProgress"
    ? turn.status
    : "failed";
  return {
    id: turn.id,
    status,
    error: asRecord(turn.error) as { message?: string } | null,
    items: Array.isArray(turn.items) ? turn.items.filter(isRecord) : [],
  };
}

function extractAssistantText(turn: AppServerTurn): string {
  const agentMessages = turn.items.filter((item) => item.type === "agentMessage" && typeof item.text === "string");
  const final = lastMatching(agentMessages, (item) => item.phase === "final_answer");
  const selected = final ?? agentMessages.at(-1);
  return typeof selected?.text === "string" ? selected.text.trim() : "";
}

function lastMatching<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return items[index];
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
