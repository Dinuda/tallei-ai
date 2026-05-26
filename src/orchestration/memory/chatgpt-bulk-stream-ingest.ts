import { createReadStream } from "node:fs";
import streamArray from "stream-json/streamers/stream-array.js";
import unzipper from "unzipper";

import { config } from "../../config/index.js";
import { resolveStoragePath } from "../../services/chatgpt-import/storage.js";
import type { BulkIngestDocument } from "./chatgpt-bulk-ingest.js";
import {
  conversationRecordToBundle,
  isConversationWithinImportWindow,
  readSourceDateTimeFromRecord,
  type BulkConversationBundle,
} from "./chatgpt-bulk-parser.js";

const CONVERSATIONS_JSON = /^conversations(?:-\d+)?\.json$/i;
const SHARED_CONVERSATIONS_JSON = /^shared_conversations\.json$/i;
const PROFILE_JSON = /^(user|user_settings)\.json$/i;
const SKIP_JSON = /^(message_feedback|model_comparisons|chat)\./i;

const MEDIA_EXTENSIONS = [
  ".dat",
  ".webp",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".mp3",
  ".mp4",
  ".wav",
  ".webm",
  ".mov",
  ".m4a",
  ".heic",
];

const MEDIA_PATH_PATTERNS = [
  /dalle-generations\//i,
  /\/audio\//i,
  /\/images?\//i,
  /\/video\//i,
  /^file-/i,
];

export interface StreamIngestSkipStats {
  skippedDatFiles: number;
  skippedMediaFiles: number;
  skippedOtherBinary: number;
  skippedOldConversations: number;
  parsedConversations: number;
  hasConversationsJson: boolean;
  sourcesParsed: string[];
}

export interface StreamIngestProfileDocument {
  path: string;
  data: unknown;
}

export type ZipEntryKind =
  | "conversations"
  | "profile"
  | "dat"
  | "media"
  | "skip"
  | "other_binary";

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? path;
}

function normalizedImportBasename(path: string): string {
  const name = basename(path);
  return name.replace(/^[a-f0-9]{32}_/i, "");
}

export function classifyZipEntryPath(path: string): ZipEntryKind {
  const name = normalizedImportBasename(path).toLowerCase();
  const normalizedPath = path.replace(/\\/g, "/").toLowerCase();

  if (name.endsWith(".dat")) return "dat";
  if (MEDIA_EXTENSIONS.some((ext) => name.endsWith(ext))) return "media";
  if (MEDIA_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath))) return "media";

  if (CONVERSATIONS_JSON.test(name) || SHARED_CONVERSATIONS_JSON.test(name)) return "conversations";
  if (PROFILE_JSON.test(name)) return "profile";
  if (name.endsWith(".json") && !SKIP_JSON.test(name)) return "skip";
  if (name.endsWith(".jsonl") || name.endsWith(".txt")) return "skip";
  if (name.endsWith(".html")) return "skip";
  return "other_binary";
}

export function createEmptyStreamIngestSkipStats(): StreamIngestSkipStats {
  return {
    skippedDatFiles: 0,
    skippedMediaFiles: 0,
    skippedOtherBinary: 0,
    skippedOldConversations: 0,
    parsedConversations: 0,
    hasConversationsJson: false,
    sourcesParsed: [],
  };
}

function recordSkip(stats: StreamIngestSkipStats, kind: ZipEntryKind): void {
  if (kind === "dat") stats.skippedDatFiles += 1;
  else if (kind === "media") stats.skippedMediaFiles += 1;
  else if (kind === "other_binary") stats.skippedOtherBinary += 1;
}

async function* streamJsonArrayFromReadable(
  readable: NodeJS.ReadableStream
): AsyncGenerator<unknown> {
  const pipeline = streamArray.withParserAsStream();
  readable.pipe(pipeline);
  for await (const item of pipeline as AsyncIterable<{ key: number; value: unknown }>) {
    if (item && typeof item === "object" && "value" in item) {
      yield item.value;
    }
  }
}

async function readJsonEntryBuffer(entry: unzipper.File): Promise<unknown> {
  const buffer = await entry.buffer();
  const decoded = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!decoded) throw new Error(`File "${entry.path}" is empty.`);
  if (basename(entry.path).toLowerCase().endsWith(".jsonl")) {
    return decoded
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  return JSON.parse(decoded) as unknown;
}

export async function readProfileDocumentFromZip(
  absolutePath: string
): Promise<StreamIngestProfileDocument | null> {
  const lower = absolutePath.toLowerCase();
  if (!lower.endsWith(".zip")) {
    if (PROFILE_JSON.test(normalizedImportBasename(absolutePath))) {
      const { readFile } = await import("node:fs/promises");
      const decoded = (await readFile(absolutePath, "utf8")).replace(/^\uFEFF/, "").trim();
      return {
        path: basename(absolutePath),
        data: JSON.parse(decoded) as unknown,
      };
    }
    return null;
  }

  const directory = await unzipper.Open.file(absolutePath);
  for (const entry of directory.files) {
    if (entry.type !== "File") continue;
    if (classifyZipEntryPath(entry.path) !== "profile") continue;
    const data = await readJsonEntryBuffer(entry);
    return { path: basename(entry.path), data };
  }
  return null;
}

export async function inspectZipSkipStats(absolutePath: string): Promise<StreamIngestSkipStats> {
  const stats = createEmptyStreamIngestSkipStats();
  const lower = absolutePath.toLowerCase();
  if (!lower.endsWith(".zip")) {
    return stats;
  }

  const directory = await unzipper.Open.file(absolutePath);
  for (const entry of directory.files) {
    if (entry.type !== "File") continue;
    const kind = classifyZipEntryPath(entry.path);
    if (kind === "conversations") {
      stats.hasConversationsJson = stats.hasConversationsJson || CONVERSATIONS_JSON.test(basename(entry.path));
      continue;
    }
    if (kind === "profile" || kind === "skip") continue;
    recordSkip(stats, kind);
  }
  return stats;
}

export interface StreamConversationOptions {
  maxAgeDays?: number | null;
  stats?: StreamIngestSkipStats;
}

export async function* streamConversationsFromBulkFile(
  storageRef: string,
  options?: StreamConversationOptions
): AsyncGenerator<BulkConversationBundle> {
  const absolutePath = resolveStoragePath(storageRef);
  const stats = options?.stats ?? createEmptyStreamIngestSkipStats();
  const maxAgeDays = options?.maxAgeDays ?? config.importMaxAgeDays;
  const lower = absolutePath.toLowerCase();

  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) {
    const sourceFile = normalizedImportBasename(absolutePath);
    const kind = classifyZipEntryPath(sourceFile);
    if (kind === "profile" || kind === "skip" || kind === "dat" || kind === "media" || kind === "other_binary") {
      return;
    }

    stats.sourcesParsed.push(sourceFile);
    if (CONVERSATIONS_JSON.test(sourceFile)) stats.hasConversationsJson = true;

    let index = 0;
    try {
      for await (const value of streamJsonArrayFromReadable(createReadStream(absolutePath))) {
        yield* yieldConversationBundle(value, sourceFile, index, maxAgeDays, stats);
        index += 1;
      }
    } catch {
      index = 0;
    }

    if (index === 0) {
      const { readFile } = await import("node:fs/promises");
      const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
        yield* yieldConversationBundle(roots[rootIndex], sourceFile, rootIndex, maxAgeDays, stats);
      }
    }
    return;
  }

  if (!lower.endsWith(".zip")) {
    throw new Error("Unsupported bulk import file type. Upload a ChatGPT export ZIP or conversations.json.");
  }

  const directory = await unzipper.Open.file(absolutePath);
  for (const entry of directory.files) {
    if (entry.type !== "File") continue;
    const kind = classifyZipEntryPath(entry.path);
    if (kind === "conversations") {
      const sourceFile = basename(entry.path);
      if (!stats.sourcesParsed.includes(sourceFile)) stats.sourcesParsed.push(sourceFile);
      if (CONVERSATIONS_JSON.test(sourceFile)) stats.hasConversationsJson = true;

      let index = 0;
      for await (const value of streamJsonArrayFromReadable(entry.stream())) {
        yield* yieldConversationBundle(value, sourceFile, index, maxAgeDays, stats);
        index += 1;
      }
      if (index === 0) {
        const parsed = await readJsonEntryBuffer(entry);
        const roots = Array.isArray(parsed) ? parsed : [parsed];
        for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
          yield* yieldConversationBundle(roots[rootIndex], sourceFile, rootIndex, maxAgeDays, stats);
        }
      }
      continue;
    }
    if (kind === "profile" || kind === "skip") continue;
    recordSkip(stats, kind);
  }
}

function* yieldConversationBundle(
  value: unknown,
  sourceFile: string,
  rootIndex: number,
  maxAgeDays: number | null | undefined,
  stats: StreamIngestSkipStats
): Generator<BulkConversationBundle> {
  if (maxAgeDays != null && maxAgeDays > 0 && !isConversationWithinImportWindow(value, maxAgeDays)) {
    stats.skippedOldConversations += 1;
    return;
  }
  if (maxAgeDays == null || maxAgeDays <= 0) {
    const record = asRecord(value);
    if (!record || !asRecord(record["mapping"])) return;
  }
  const bundle = conversationRecordToBundle(value, sourceFile, rootIndex);
  if (!bundle) return;
  stats.parsedConversations += 1;
  yield bundle;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function* streamConversationsFromJsonFiles(
  storageRefs: string[],
  options?: StreamConversationOptions
): AsyncGenerator<BulkConversationBundle> {
  const stats = options?.stats ?? createEmptyStreamIngestSkipStats();
  const maxAgeDays = options?.maxAgeDays ?? null;

  for (const storageRef of storageRefs) {
    const sourceFile = normalizedImportBasename(resolveStoragePath(storageRef));
    const kind = classifyZipEntryPath(sourceFile);
    if (kind !== "conversations") continue;

    for await (const bundle of streamConversationsFromBulkFile(storageRef, { stats, maxAgeDays })) {
      yield bundle;
    }
  }
}

export function profileDocumentToBulkIngest(profile: StreamIngestProfileDocument | null): BulkIngestDocument | null {
  if (!profile) return null;
  return {
    path: profile.path,
    role: "profile",
    data: profile.data,
  };
}

export function streamStatsToIngestSummary(stats: StreamIngestSkipStats) {
  return {
    sourcesParsed: stats.sourcesParsed,
    skipped: {
      binaryDat: stats.skippedDatFiles,
      binaryDatSamples: [],
      libraryCatalog: 0,
      other: stats.skippedMediaFiles + stats.skippedOtherBinary,
      otherSamples: [],
    },
    dat: {
      inspected: stats.skippedDatFiles,
      extracted: 0,
      extractedSamples: [],
      metadataOnly: 0,
      metadataSamples: [],
      skipped: stats.skippedDatFiles,
    },
    hasConversationsJson: stats.hasConversationsJson,
    skippedDatFiles: stats.skippedDatFiles,
    skippedMediaFiles: stats.skippedMediaFiles,
    skippedOtherBinary: stats.skippedOtherBinary,
    skippedOldConversations: stats.skippedOldConversations,
  };
}

export function buildStreamIngestWarnings(stats: StreamIngestSkipStats): string[] {
  const warnings: string[] = [];
  const mediaSkipped = stats.skippedDatFiles + stats.skippedMediaFiles + stats.skippedOtherBinary;
  if (mediaSkipped > 0) {
    warnings.push(
      `Skipped ${mediaSkipped} media/binary file(s) (photos, audio, video, .dat uploads — text-only import).`
    );
  }
  if (stats.skippedOldConversations > 0) {
    warnings.push(
      `Skipped ${stats.skippedOldConversations} conversation(s) older than ${config.importMaxAgeDays} days.`
    );
  }
  if (!stats.hasConversationsJson && stats.sourcesParsed.length > 0) {
    warnings.push(
      "No conversations.json found in this archive. Only partial data will be imported. For full chat history, re-export from ChatGPT Settings → Data Controls → Export."
    );
  }
  return warnings;
}

export async function collectConversationBatchesFromBulkFile(
  storageRef: string,
  batchSize: number,
  options?: StreamConversationOptions
): Promise<{ batches: BulkConversationBundle[][]; stats: StreamIngestSkipStats }> {
  const stats = options?.stats ?? createEmptyStreamIngestSkipStats();
  const batches: BulkConversationBundle[][] = [];
  let current: BulkConversationBundle[] = [];

  for await (const bundle of streamConversationsFromBulkFile(storageRef, { ...options, stats })) {
    current.push(bundle);
    if (current.length >= batchSize) {
      batches.push(current);
      current = [];
    }
  }
  if (current.length > 0) batches.push(current);
  return { batches, stats };
}

export { readSourceDateTimeFromRecord };
