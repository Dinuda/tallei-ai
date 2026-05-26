import { randomUUID } from "crypto";

import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import type { BulkIngestDocument, BulkIngestSummary } from "./chatgpt-bulk-ingest.js";
import {
  extractBulkConversationBundles,
  extractClaudeConversationBundles,
  looksLikeBinaryText,
  type BulkConversationBundle,
} from "./chatgpt-bulk-parser.js";
import {
  extractHighSignalImportMemories,
  mapExtractTypeToMemoryType,
  type ExtractedImportMemory,
  type ExtractHighSignalMemoriesOptions,
  type ExtractHighSignalMemoriesResult,
} from "./chatgpt-import-extract.usecase.js";
import { extractHighSignalImportMemoriesHeuristic } from "./chatgpt-import-heuristic-extract.usecase.js";
import {
  bundlesToImportConversations,
  classifyBulkImportCandidates,
  type ClassifiedImportConversations,
  type ScoredImportConversation,
} from "./chatgpt-import-signal.usecase.js";
import { promoteWeakSignals } from "./chatgpt-import-weak-signal.usecase.js";
import { classifyMemory } from "./memory-classification.js";
import type { MemoryType } from "./memory-types.js";
import {
  buildStreamIngestWarnings,
  readProfileDocumentFromZip,
  streamConversationsFromBulkFile,
  streamConversationsFromJsonFiles,
  streamStatsToIngestSummary,
  type StreamIngestSkipStats,
} from "./chatgpt-bulk-stream-ingest.js";
import { resolveStoragePath } from "../../services/chatgpt-import-storage.js";
import { basename } from "node:path";
import { extractProfileImportItems } from "./chatgpt-bulk-parser.js";

export type ChatGptImportStatus =
  | "accepted"
  | "duplicate"
  | "conflict"
  | "invalid";

export type ChatGptImportReasonCode =
  | "intra_batch_duplicate"
  | "exact_duplicate_existing"
  | "contradictory_value"
  | "invalid_input"
  | "deduped_on_persist";

export type ChatGptImportMode = "json_export" | "paste" | "bulk_export" | "claude_export";

export type ChatGptImportProgressStage =
  | "ingesting"
  | "filtering"
  | "aggregating"
  | "extracting"
  | "promoting"
  | "persisting";

export interface ChatGptImportProgress {
  stage: ChatGptImportProgressStage;
  message?: string;
}

export type ChatGptImportProfile = "curated" | "inclusive";
export type MemoryImportSource = "chatgpt" | "claude";

export interface ChatGptImportRequest {
  mode?: "bulk_file" | "conversation_json_files";
  storageRef?: string;
  storageRefs?: string[];
  originalFilename?: string;
  originalFilenames?: string[];
  importProfile?: ChatGptImportProfile;
  importSource?: MemoryImportSource;
  input?: string;
  apply?: boolean;
  modeHint?: ChatGptImportMode;
  bulkDocuments?: BulkIngestDocument[];
  ingestSummary?: BulkIngestSummary;
  ingestWarnings?: string[];
  onProgress?: (progress: ChatGptImportProgress) => void | Promise<void>;
}

export interface ChatGptImportCandidate {
  raw: string;
  normalized: string;
  detectedKey: string | null;
  detectedValue: string;
  sourceDateTime: string | null;
  memoryType: MemoryType;
  category: string | null;
  isPinned: boolean;
  preferenceKey: string | null;
  status: ChatGptImportStatus;
  reason?: ChatGptImportReasonCode;
  extractConfidence?: number;
  extractStability?: number;
  extractType?: string;
  sourceReason?: string;
}

export interface ChatGptImportConflict {
  reason: "contradictory_value";
  candidate: {
    raw: string;
    memoryType: MemoryType;
    category: string | null;
    isPinned: boolean;
    entityKey: string;
    sourceDateTime: string | null;
    preferenceKey: string | null;
    detectedKey: string | null;
    detectedValue: string;
  };
  existing: {
    memoryId: string;
    text: string;
    memoryType: MemoryType;
    preferenceKey: string | null;
    category: string | null;
    detectedValue: string;
  };
}

export interface ChatGptImportDuplicate {
  reason: Exclude<ChatGptImportReasonCode, "contradictory_value">;
  candidate: {
    raw: string;
    normalized: string;
    sourceDateTime: string | null;
    memoryType: MemoryType;
    category: string | null;
    preferenceKey: string | null;
    detectedKey: string | null;
  };
  existingMemoryId?: string;
}

export interface ChatGptImportSummary {
  parsed: number;
  selected: number;
  skipped: number;
  hardDropped: number;
  keepHigh: number;
  keepWeak: number;
  dropped: number;
  extracted: number;
  accepted: number;
  duplicates: number;
  conflicts: number;
  invalid: number;
  persisted: number;
  embedded: number;
}

export interface ChatGptImportResult {
  batchId: string;
  mode: ChatGptImportMode;
  importSource: MemoryImportSource;
  summary: ChatGptImportSummary;
  preview: ChatGptImportCandidate[];
  conflicts: ChatGptImportConflict[];
  duplicates: ChatGptImportDuplicate[];
  warnings: string[];
  ingestSummary?: BulkIngestSummary;
}

interface ParsedImportItem {
  raw: string;
  detectedKey: string | null;
  detectedValue: string;
  normalized: string;
  sourceDateTime: string | null;
  sourceFile: string | null;
  memoryTypeOverride?: MemoryType;
  categoryOverride?: string | null;
  extractConfidence?: number;
  extractStability?: number;
  extractType?: string;
  sourceReason?: string;
}

interface ParsedInputResult {
  mode: ChatGptImportMode;
  items: ParsedImportItem[];
  bundles: BulkConversationBundle[];
  useBulkPipeline: boolean;
  useBulkFilePipeline: boolean;
  useConversationJsonFilesPipeline: boolean;
  importProfileOverride?: ChatGptImportProfile;
  invalid: number;
  warnings: string[];
}

interface BulkPipelineStats {
  parsedConversations: number;
  hardDropped: number;
  keepHigh: number;
  keepWeak: number;
  dropped: number;
  extracted: number;
  sentToExtractor: number;
}

interface ExistingMemory {
  id: string;
  text: string;
  memoryType: MemoryType;
  preferenceKey: string | null;
  category: string | null;
}

interface UseCaseDeps {
  listExistingMemories(auth: AuthContext): Promise<ExistingMemory[]>;
  persistMemory(input: {
    auth: AuthContext;
    content: string;
    memoryType: MemoryType;
    category: string | null;
    isPinned: boolean;
    preferenceKey: string | null;
    sourceImportBatchId: string;
    sourceImportMode: ChatGptImportMode;
    sourceImportPlatform: MemoryImportSource;
    sourceDateTime: string | null;
    importDetectedCategory: string | null;
    importEntityKey: string | null;
    skipSummary?: boolean;
  }): Promise<{ memoryId: string; deduped?: boolean }>;
  extractHighSignalMemories?: (
    conversations: ScoredImportConversation[],
    options?: ExtractHighSignalMemoriesOptions
  ) => Promise<ExtractHighSignalMemoriesResult>;
}

interface ParseImportOptions {
  modeHint?: ChatGptImportMode;
}

interface RawImportCandidate {
  text: string;
  sourceDateTime: string | null;
}

const LEGACY_BULK_MAX_CANDIDATES = 5_000;
const IMPORT_PERSIST_CONCURRENCY = 8;

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      await fn(items[current]!);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, "")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeValue(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function parseKeyValue(raw: string): { key: string | null; value: string } {
  const compact = normalizeWhitespace(raw);
  const match = compact.match(/^([a-z0-9 _-]{2,60})\s*:\s*(.+)$/i);
  if (!match) {
    return { key: null, value: compact };
  }
  const key = normalizeKey(match[1]);
  const value = normalizeWhitespace(match[2] ?? "");
  return { key: key || null, value };
}

function readStringCandidate(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const row = item as Record<string, unknown>;
  for (const key of ["preference", "value", "text", "content", "memory", "fact", "note", "summary"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  if (typeof row["key"] === "string" && typeof row["value"] === "string") {
    return `${row["key"]}: ${row["value"]}`;
  }
  return null;
}

function readSourceDateTime(item: unknown): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const row = item as Record<string, unknown>;
  for (const key of [
    "datetime",
    "dateTime",
    "source_datetime",
    "sourceDateTime",
    "created_at",
    "create_time",
    "createdAt",
    "updated_at",
    "update_time",
    "updatedAt",
    "timestamp",
    "date",
    "observed_at",
    "observedAt",
  ]) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return normalizeWhitespace(value);
    if (typeof value === "number" && Number.isFinite(value)) {
      const asMs = value > 1e12 ? value : value * 1000;
      const date = new Date(asMs);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return null;
}

function stripInlineDateTime(raw: string): { text: string; sourceDateTime: string | null } {
  const compact = normalizeWhitespace(raw);
  const bracketed = compact.match(/^\[([^\]]{6,80})\]\s+(.+)$/);
  if (bracketed?.[1] && bracketed?.[2]) {
    return { sourceDateTime: bracketed[1].trim(), text: bracketed[2].trim() };
  }
  const isoPrefix = compact.match(/^(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)\s*[-:]\s+(.+)$/);
  if (isoPrefix?.[1] && isoPrefix?.[2]) {
    return { sourceDateTime: isoPrefix[1].trim(), text: isoPrefix[2].trim() };
  }
  return { sourceDateTime: null, text: compact };
}

function normalizeParsedItems(rawItems: RawImportCandidate[]): ParsedImportItem[] {
  return rawItems
    .map(({ text, sourceDateTime }) => {
      const inline = stripInlineDateTime(text);
      return {
        raw: inline.text,
        sourceDateTime: sourceDateTime ?? inline.sourceDateTime,
        sourceFile: null,
      };
    })
    .filter((item) => item.raw.length > 0)
    .map((item) => {
      const { key, value } = parseKeyValue(item.raw);
      return {
        raw: item.raw,
        detectedKey: key,
        detectedValue: value,
        normalized: normalizeValue(item.raw),
        sourceDateTime: item.sourceDateTime,
        sourceFile: item.sourceFile,
      };
    });
}

function isDateTimeKey(key: string): boolean {
  return /^(?:date|datetime|dateTime|timestamp|created_at|create_time|createdAt|updated_at|update_time|updatedAt|observed_at|observedAt|source_datetime|sourceDateTime)$/i.test(key);
}

function collectStringCandidates(value: unknown): RawImportCandidate[] {
  if (typeof value === "string") return [{ text: value, sourceDateTime: null }];
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectStringCandidates(item));
  if (typeof value !== "object") return [];

  const object = value as Record<string, unknown>;
  const direct = readStringCandidate(object);
  if (direct) return [{ text: direct, sourceDateTime: readSourceDateTime(object) }];

  const candidates: RawImportCandidate[] = [];
  for (const [key, nested] of Object.entries(object)) {
    if (isDateTimeKey(key)) continue;
    if (typeof nested === "string" && nested.trim().length > 0) {
      candidates.push({ text: `${key}: ${nested}`, sourceDateTime: readSourceDateTime(object) });
      continue;
    }
    if (Array.isArray(nested)) {
      candidates.push(...nested.flatMap((item) => collectStringCandidates(item)));
      continue;
    }
    if (typeof nested === "object" && nested !== null) {
      candidates.push(...collectStringCandidates(nested));
    }
  }
  return candidates;
}

function stripMarkdownCodeBlocks(input: string): string {
  return input
    .replace(/```(?:json)?\s*\n?/gi, "")
    .replace(/```\s*$/g, "")
    .trim();
}

function fixTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, "$1");
}

function tryParseImportJson(input: string): unknown | null {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    try {
      return JSON.parse(fixTrailingCommas(input)) as unknown;
    } catch {
      const chunks = input
        .split(/\n{2,}/)
        .map((chunk) => chunk.trim())
        .filter(Boolean);
      if (chunks.length <= 1) return null;

      const merged: unknown[] = [];
      for (const chunk of chunks) {
        const parsed = tryParseImportJson(chunk);
        if (parsed == null) return null;
        if (Array.isArray(parsed)) merged.push(...parsed);
        else merged.push(parsed);
      }
      return merged.length > 0 ? merged : null;
    }
  }
}

function applyParsedConversationPayload(
  parsed: unknown,
  options: ParseImportOptions | undefined,
  modeHint: ChatGptImportMode | undefined
): Pick<ParsedInputResult, "mode" | "items" | "bundles" | "useBulkPipeline" | "importProfileOverride" | "invalid" | "warnings"> {
  let mode: ChatGptImportMode = options?.modeHint ?? "json_export";
  let invalid = 0;
  const warnings: string[] = [];
  let rawItems: RawImportCandidate[] = [];
  let bundles: BulkConversationBundle[] = [];
  let useBulkPipeline = false;
  let importProfileOverride: ChatGptImportProfile | undefined;

  const claudeBundles = extractClaudeConversationBundles(parsed, "pasted-claude-export.json");
  if (claudeBundles.length > 0) {
    mode = "claude_export";
    bundles = claudeBundles;
    useBulkPipeline = true;
    importProfileOverride = "inclusive";
    return { mode, items: [], bundles, useBulkPipeline, importProfileOverride, invalid, warnings };
  }

  if (modeHint === "bulk_export" || options?.modeHint === "bulk_export") {
    mode = "bulk_export";
    bundles = bundlesFromParsedJson(parsed, "pasted-export.json");
    if (bundles.length > 0) {
      useBulkPipeline = true;
    } else {
      const conversationRows = collectConversationCandidates(parsed);
      if (conversationRows.length > 0) rawItems = conversationRows;
    }
  }

  if (!useBulkPipeline) {
    rawItems = collectStringCandidates(parsed);
  }
  if (!useBulkPipeline && rawItems.length === 0) {
    invalid += 1;
    warnings.push("No importable string candidates found in JSON payload.");
  }
  if (useBulkPipeline && bundles.length === 0) {
    invalid += 1;
    warnings.push("No importable conversations found in bulk export JSON.");
  }

  const items = normalizeParsedItems(rawItems);
  return { mode, items, bundles, useBulkPipeline, importProfileOverride, invalid, warnings };
}

function parseJsonLikeQuotedValue(value: string): string {
  const compact = value.trim().replace(/,\s*$/, "");
  if (!compact) return "";
  if ((compact.startsWith('"') && compact.endsWith('"')) || (compact.startsWith("'") && compact.endsWith("'"))) {
    const asJson = `"${compact.slice(1, -1).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    try {
      return JSON.parse(asJson) as string;
    } catch {
      return compact.slice(1, -1).trim();
    }
  }
  return compact;
}

function salvageJsonLikeObjects(input: string): RawImportCandidate[] {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  let sawObjectShape = false;
  const candidates: RawImportCandidate[] = [];
  let pendingMemory: string | null = null;
  let pendingDateTime: string | null = null;

  const flush = (): void => {
    if (!pendingMemory) return;
    candidates.push({ text: pendingMemory, sourceDateTime: pendingDateTime });
    pendingMemory = null;
    pendingDateTime = null;
  };

  for (const line of lines) {
    if (line === "{" || line === "}," || line === "}") {
      sawObjectShape = true;
      if (line === "}" || line === "},") flush();
      continue;
    }

    const pair = line.match(/^"([^"]+)"\s*:\s*(.+?)\s*,?$/);
    if (!pair) continue;

    sawObjectShape = true;
    const key = pair[1]?.trim() ?? "";
    const value = parseJsonLikeQuotedValue(pair[2] ?? "");
    if (!value) continue;

    if (/^(?:preference|value|text|content|memory|fact|note|summary)$/i.test(key)) {
      if (pendingMemory) flush();
      pendingMemory = value;
      continue;
    }

    if (isDateTimeKey(key)) {
      pendingDateTime = value;
    }
  }

  flush();
  if (!sawObjectShape || candidates.length === 0) return [];
  return candidates;
}

function isStructuralJsonLine(line: string): boolean {
  const stripped = line.replace(/\s/g, "");
  if (/^[\[\]{}]+$/.test(stripped)) return true;
  if (stripped === "{" || stripped === "}" || stripped === "[]" || stripped === "{}") return true;
  if (/^},?$/.test(stripped)) return true;
  if (/^["']/.test(line) && line.includes(":") && !/[{}\[\]]/.test(line)) {
    return true;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function messagePartToText(part: unknown): string[] {
  if (typeof part === "string") return [part];
  const record = asRecord(part);
  if (!record) return [];
  const text = record["text"];
  if (typeof text === "string") return [text];
  const segments = record["segments"];
  if (Array.isArray(segments)) {
    return segments.filter((value): value is string => typeof value === "string");
  }
  return [];
}

function splitLongLine(line: string): string[] {
  if (line.length <= 360) return [line];
  return line
    .split(/(?<=[.!?])\s+/)
    .map((part) => normalizeWhitespace(part))
    .filter((part) => part.length >= 12 && part.length <= 280);
}

function sanitizeConversationText(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= 8)
    .filter((line) => !/^[`"'[\]{}()<>]+$/.test(line))
    .flatMap((line) => splitLongLine(line));
}

function collectConversationCandidatesFromMapping(mapping: Record<string, unknown>): RawImportCandidate[] {
  const candidates: RawImportCandidate[] = [];
  for (const node of Object.values(mapping)) {
    const nodeRecord = asRecord(node);
    if (!nodeRecord) continue;
    const message = asRecord(nodeRecord["message"]);
    if (!message) continue;
    const content = asRecord(message["content"]);
    if (!content) continue;
    const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
    const sourceDateTime = readSourceDateTime(message) ?? readSourceDateTime(nodeRecord);
    for (const part of parts) {
      const partTexts = messagePartToText(part);
      for (const line of partTexts.flatMap((value) => sanitizeConversationText(value))) {
        candidates.push({ text: line, sourceDateTime });
      }
    }
  }
  return candidates;
}

function collectConversationCandidates(value: unknown): RawImportCandidate[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectConversationCandidates(item));
  const object = asRecord(value);
  if (!object) return [];

  const mapping = asRecord(object["mapping"]);
  if (mapping) {
    const fromMapping = collectConversationCandidatesFromMapping(mapping);
    if (fromMapping.length > 0) return fromMapping;
  }

  const messages = Array.isArray(object["messages"]) ? object["messages"] : null;
  if (messages) {
    const candidates: RawImportCandidate[] = [];
    for (const item of messages) {
      const row = asRecord(item);
      if (!row) continue;
      const sourceDateTime = readSourceDateTime(row);
      const content = row["content"];
      if (typeof content === "string") {
        for (const line of sanitizeConversationText(content)) {
          candidates.push({ text: line, sourceDateTime });
        }
        continue;
      }
      const contentObj = asRecord(content);
      if (contentObj && Array.isArray(contentObj["parts"])) {
        for (const part of contentObj["parts"]) {
          const lines = messagePartToText(part).flatMap((value) => sanitizeConversationText(value));
          for (const line of lines) candidates.push({ text: line, sourceDateTime });
        }
      }
    }
    if (candidates.length > 0) return candidates;
  }

  return [];
}

function bundlesFromParsedJson(parsed: unknown, sourceFile: string): BulkConversationBundle[] {
  return extractBulkConversationBundles([{
    path: sourceFile,
    role: "conversations",
    data: parsed,
  }]);
}

function extractedToParsedItem(row: ExtractedImportMemory): ParsedImportItem {
  const mapped = mapExtractTypeToMemoryType(row.type);
  const { key, value } = parseKeyValue(row.memory);
  return {
    raw: row.memory,
    detectedKey: key,
    detectedValue: value,
    normalized: normalizeValue(row.memory),
    sourceDateTime: row.sourceDateTime,
    sourceFile: row.sourceFile,
    memoryTypeOverride: mapped.memoryType,
    categoryOverride: mapped.category,
    extractConfidence: row.confidence,
    extractStability: row.stability,
    extractType: row.type,
    sourceReason: row.sourceReason,
  };
}

function resolveImportSource(
  request: ChatGptImportRequest,
  mode: ChatGptImportMode
): MemoryImportSource {
  if (request.importSource === "claude") return "claude";
  if (request.importSource === "chatgpt") return "chatgpt";
  if (mode === "claude_export") return "claude";
  return "chatgpt";
}

function resolveClassification(candidate: ParsedImportItem): ReturnType<typeof classifyMemory> {
  const heuristic = classifyMemory(candidate.raw);
  if (!candidate.memoryTypeOverride) {
    return heuristic;
  }
  return {
    memoryType: candidate.memoryTypeOverride,
    category: candidate.categoryOverride ?? heuristic.category,
    isPinned: heuristic.isPinned,
    preferenceKey: heuristic.preferenceKey,
    isIdentityFact: heuristic.isIdentityFact,
  };
}

export function parseChatGptImportInput(input: string, options?: ParseImportOptions): ParsedInputResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      mode: options?.modeHint ?? "paste",
      items: [],
      bundles: [],
      useBulkPipeline: false,
      useBulkFilePipeline: false,
      useConversationJsonFilesPipeline: false,
      invalid: 1,
      warnings: ["Input is empty."],
    };
  }

  const cleaned = stripMarkdownCodeBlocks(trimmed);
  const parsed = tryParseImportJson(cleaned);
  if (parsed != null) {
    const applied = applyParsedConversationPayload(parsed, options, options?.modeHint);
    let items = applied.items;
    const warnings = [...applied.warnings];
    let invalid = applied.invalid;

    if (!applied.useBulkPipeline && applied.mode === "bulk_export" && items.length > LEGACY_BULK_MAX_CANDIDATES) {
      warnings.push(`Capped bulk export candidates at ${LEGACY_BULK_MAX_CANDIDATES} from ${items.length} detected rows.`);
      items = items.slice(0, LEGACY_BULK_MAX_CANDIDATES);
    }
    if (!applied.useBulkPipeline && items.length === 0 && invalid > 0) {
      warnings.push("No importable memory candidates found in input.");
    }
    if (applied.useBulkPipeline && applied.bundles.length === 0 && invalid === 0) {
      invalid = 1;
      warnings.push("No importable conversations found in bulk export.");
    }

    return {
      mode: applied.mode,
      items,
      bundles: applied.bundles,
      useBulkPipeline: applied.useBulkPipeline,
      useBulkFilePipeline: false,
      useConversationJsonFilesPipeline: false,
      ...(applied.importProfileOverride ? { importProfileOverride: applied.importProfileOverride } : {}),
      invalid,
      warnings,
    };
  }

  let mode: ChatGptImportMode = options?.modeHint ?? "paste";
  let invalid = 0;
  const warnings: string[] = [];
  let rawItems: RawImportCandidate[] = [];

  const recovered = salvageJsonLikeObjects(cleaned);
  if (recovered.length > 0) {
    mode = options?.modeHint ?? "json_export";
    rawItems = recovered;
    warnings.push("Found JSON-like block but could not parse it as strict JSON. Recovered candidates from object lines.");
  } else {
    mode = options?.modeHint ?? "paste";
    rawItems = cleaned
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
      .filter((line) => line.length > 0 && !isStructuralJsonLine(line))
      .filter((line) => mode !== "bulk_export" || !looksLikeBinaryText(line))
      .map((line) => ({ text: line, sourceDateTime: null }));
  }

  let items = normalizeParsedItems(rawItems);
  if (mode === "bulk_export" && items.length > LEGACY_BULK_MAX_CANDIDATES) {
    warnings.push(`Capped bulk export candidates at ${LEGACY_BULK_MAX_CANDIDATES} from ${items.length} detected rows.`);
    items = items.slice(0, LEGACY_BULK_MAX_CANDIDATES);
  }
  if (items.length === 0 && invalid > 0) {
    warnings.push("No importable memory candidates found in input.");
  }

  return { mode, items, bundles: [], useBulkPipeline: false, useBulkFilePipeline: false, useConversationJsonFilesPipeline: false, invalid, warnings };
}

function parseBulkDocuments(
  documents: BulkIngestDocument[],
  extraWarnings: string[] = []
): ParsedInputResult {
  const bundles = extractBulkConversationBundles(documents);
  const warnings = [...extraWarnings];
  if (bundles.length === 0) {
    warnings.push("No importable memory candidates found in bulk export JSON.");
  }
  return {
    mode: "bulk_export",
    items: [],
    bundles,
    useBulkPipeline: true,
    useBulkFilePipeline: false,
    useConversationJsonFilesPipeline: false,
    invalid: bundles.length === 0 ? 1 : 0,
    warnings,
  };
}

function resolveParsedInput(request: ChatGptImportRequest): ParsedInputResult {
  if (request.mode === "conversation_json_files" && request.storageRefs && request.storageRefs.length > 0) {
    return {
      mode: "bulk_export",
      items: [],
      bundles: [],
      useBulkPipeline: true,
      useBulkFilePipeline: false,
      useConversationJsonFilesPipeline: true,
      invalid: 0,
      warnings: request.ingestWarnings ?? [],
    };
  }
  if (request.mode === "bulk_file" && request.storageRef) {
    return {
      mode: "bulk_export",
      items: [],
      bundles: [],
      useBulkPipeline: true,
      useBulkFilePipeline: true,
      useConversationJsonFilesPipeline: false,
      invalid: 0,
      warnings: request.ingestWarnings ?? [],
    };
  }
  if (request.bulkDocuments && request.bulkDocuments.length > 0) {
    return parseBulkDocuments(request.bulkDocuments, request.ingestWarnings ?? []);
  }
  const pasted = (request.input ?? "").trim();
  if (!pasted && request.modeHint === "bulk_export") {
    return {
      mode: "bulk_export",
      items: [],
      bundles: [],
      useBulkPipeline: true,
      useBulkFilePipeline: false,
      useConversationJsonFilesPipeline: false,
      invalid: 1,
      warnings: [
        ...(request.ingestWarnings ?? []),
        request.ingestWarnings?.length
          ? "No importable memory candidates found in uploaded export files."
          : "No importable JSON found in upload.",
      ],
    };
  }
  return parseChatGptImportInput(request.input ?? "", { modeHint: request.modeHint });
}

function resolveEntityKey(candidate: {
  preferenceKey: string | null;
  detectedKey: string | null;
  memoryType: MemoryType;
  category: string | null;
}): string | null {
  if (candidate.preferenceKey) return `preference_key:${candidate.preferenceKey}`;
  if (candidate.detectedKey) return `detected_key:${candidate.detectedKey}`;
  if (candidate.memoryType === "preference" && candidate.category) return `preference_category:${candidate.category}`;
  return null;
}

function normalizeExisting(text: string): { normalizedRaw: string; detectedValue: string } {
  const compact = normalizeWhitespace(text);
  const parsed = parseKeyValue(compact);
  return {
    normalizedRaw: normalizeValue(compact),
    detectedValue: normalizeValue(parsed.value),
  };
}

function emptyPipelineStats(): BulkPipelineStats {
  return {
    parsedConversations: 0,
    hardDropped: 0,
    keepHigh: 0,
    keepWeak: 0,
    dropped: 0,
    extracted: 0,
    sentToExtractor: 0,
  };
}

function emptyClassifiedImport(): ClassifiedImportConversations {
  return {
    parsedConversations: 0,
    parsedMessages: 0,
    hardDropped: 0,
    keepHigh: [],
    keepWeak: [],
    dropped: [],
    warnings: [],
  };
}

function mergeClassifiedImport(
  left: ClassifiedImportConversations,
  right: ClassifiedImportConversations,
  maxKeepHigh: number
): ClassifiedImportConversations {
  const keepHigh = [...left.keepHigh, ...right.keepHigh]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, maxKeepHigh);
  return {
    parsedConversations: left.parsedConversations + right.parsedConversations,
    parsedMessages: left.parsedMessages + right.parsedMessages,
    hardDropped: left.hardDropped + right.hardDropped,
    keepHigh,
    keepWeak: [...left.keepWeak, ...right.keepWeak],
    dropped: [...left.dropped, ...right.dropped],
    warnings: [...left.warnings, ...right.warnings],
  };
}

function profileCandidatesToParsedItems(
  data: unknown,
  sourceFile: string
): ParsedImportItem[] {
  return extractProfileImportItems(data, sourceFile).map((row) => {
    const { key, value } = parseKeyValue(row.text);
    return {
      raw: row.text,
      detectedKey: key,
      detectedValue: value,
      normalized: normalizeValue(row.text),
      sourceDateTime: row.sourceDateTime,
      sourceFile: row.sourceFile,
    };
  });
}

export class ChatGptMemoryImportUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  private async runBulkFilePipeline(
    request: ChatGptImportRequest
  ): Promise<{
    items: ParsedImportItem[];
    stats: BulkPipelineStats;
    warnings: string[];
    ingestSummary: BulkIngestSummary;
  }> {
    const storageRef = request.storageRef;
    if (!storageRef) {
      throw new Error("Missing storage reference for bulk file import.");
    }

    const warnings: string[] = [];
    const stats = emptyPipelineStats();
    const streamStats: StreamIngestSkipStats = {
      skippedDatFiles: 0,
      skippedMediaFiles: 0,
      skippedOtherBinary: 0,
      skippedOldConversations: 0,
      parsedConversations: 0,
      hasConversationsJson: false,
      sourcesParsed: [],
    };
    const batchSize = Math.max(50, config.importBatchSize);
    const maxExtract = Math.max(1, config.importMaxExtractConversations);
    let classified = emptyClassifiedImport();
    let batchIndex = 0;
    let currentBatch: BulkConversationBundle[] = [];

    await request.onProgress?.({
      stage: "ingesting",
      message: "Streaming export from disk (skipping media and old chats)",
    });

    const profile = await readProfileDocumentFromZip(resolveStoragePath(storageRef));
    const profileItems = profile
      ? profileCandidatesToParsedItems(profile.data, profile.path)
      : [];

    const flushBatch = async (): Promise<void> => {
      if (currentBatch.length === 0) return;
      batchIndex += 1;
      await request.onProgress?.({
        stage: "filtering",
        message: `Filtering batch ${batchIndex} (${currentBatch.length} conversations)`,
      });
      const conversations = bundlesToImportConversations(currentBatch);
      const batchClassified = classifyBulkImportCandidates(conversations);
      classified = mergeClassifiedImport(classified, batchClassified, maxExtract);
      stats.parsedConversations += currentBatch.length;
      currentBatch = [];
    };

    for await (const bundle of streamConversationsFromBulkFile(storageRef, { stats: streamStats })) {
      currentBatch.push(bundle);
      if (currentBatch.length >= batchSize) {
        await flushBatch();
      }
    }
    await flushBatch();

    warnings.push(...buildStreamIngestWarnings(streamStats));
    const ingestSummary = streamStatsToIngestSummary(streamStats);

    if (stats.parsedConversations === 0 && profileItems.length === 0) {
      warnings.push("No importable conversations found in export after media and date filters.");
      return { items: [], stats, warnings, ingestSummary };
    }

    await request.onProgress?.({
      stage: "aggregating",
      message: "Aggregating cross-conversation style signals",
    });

    const promoted = promoteWeakSignals(classified);
    stats.hardDropped = promoted.hardDropped;
    stats.keepHigh = promoted.keepHigh.length;
    stats.keepWeak = promoted.keepWeak.length;
    stats.dropped = promoted.dropped.length;
    warnings.push(...promoted.warnings);

    if (promoted.keepHigh.length === 0) {
      warnings.push("No KEEP_HIGH conversations to promote into memories.");
      return { items: profileItems, stats, warnings, ingestSummary };
    }

    const rankedHigh = [...promoted.keepHigh].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const toExtract = rankedHigh.slice(0, maxExtract);
    if (toExtract.length < rankedHigh.length) {
      warnings.push(
        `Capped extraction to top ${toExtract.length}/${rankedHigh.length} KEEP_HIGH conversation(s) by score.`
      );
    }

    const extractStage = config.importExtractMode === "llm" ? "extracting" : "promoting";
    await request.onProgress?.({
      stage: extractStage,
      message: config.importExtractMode === "llm"
        ? `Extracting memories from ${toExtract.length} high-signal conversation(s) via LLM`
        : `Promoting memories from ${toExtract.length} high-signal conversation(s) (no LLM)`,
    });

    const extractOptions: ExtractHighSignalMemoriesOptions = {
      concurrency: config.importExtractConcurrency,
      onProgress: async ({ completed, total }) => {
        await request.onProgress?.({
          stage: extractStage,
          message: config.importExtractMode === "llm"
            ? `Extracting memories ${completed}/${total}`
            : `Promoting memories ${completed}/${total}`,
        });
      },
    };

    const extraction = config.importExtractMode === "llm"
      ? await (this.deps.extractHighSignalMemories ?? extractHighSignalImportMemories)(toExtract, extractOptions)
      : await extractHighSignalImportMemoriesHeuristic(toExtract, extractOptions);
    stats.sentToExtractor = extraction.sentToExtractor;
    stats.extracted = extraction.extracted.length;
    warnings.push(...extraction.warnings);

    const items = [...profileItems, ...extraction.extracted.map(extractedToParsedItem)];
    return { items, stats, warnings, ingestSummary };
  }

  private resolveBulkClassifyOptions(request: ChatGptImportRequest) {
    const importProfile = request.importProfile ?? "curated";
    const isInclusive = importProfile === "inclusive";
    return {
      importProfile,
      keepHighThreshold: isInclusive
        ? config.importInclusiveKeepHighThreshold
        : config.importKeepHighThreshold,
      keepWeakThreshold: isInclusive
        ? config.importInclusiveKeepWeakThreshold
        : config.importKeepWeakThreshold,
    };
  }

  private async runConversationJsonFilesPipeline(
    request: ChatGptImportRequest
  ): Promise<{
    items: ParsedImportItem[];
    stats: BulkPipelineStats;
    warnings: string[];
    ingestSummary: BulkIngestSummary;
  }> {
    const storageRefs = request.storageRefs;
    if (!storageRefs || storageRefs.length === 0) {
      throw new Error("Missing storage references for conversation JSON import.");
    }

    const importProfile = request.importProfile ?? "inclusive";
    const isInclusive = importProfile === "inclusive";
    const classifyOptions = this.resolveBulkClassifyOptions({ ...request, importProfile });
    const warnings: string[] = [];
    const stats = emptyPipelineStats();
    const streamStats: StreamIngestSkipStats = {
      skippedDatFiles: 0,
      skippedMediaFiles: 0,
      skippedOtherBinary: 0,
      skippedOldConversations: 0,
      parsedConversations: 0,
      hasConversationsJson: false,
      sourcesParsed: [],
    };
    const batchSize = Math.max(50, config.importBatchSize);
    const maxExtract = isInclusive
      ? Math.max(1, config.importInclusiveMaxExtractConversations)
      : Math.max(1, config.importMaxExtractConversations);
    let classified = emptyClassifiedImport();
    let batchIndex = 0;
    let currentBatch: BulkConversationBundle[] = [];

    const profileItems: ParsedImportItem[] = [];
    const originalFilenames = request.originalFilenames ?? [];
    for (let index = 0; index < storageRefs.length; index += 1) {
      const filename = originalFilenames[index] ?? basename(storageRefs[index]!);
      if (!/^(user|user_settings)\.json$/i.test(filename)) continue;
      try {
        const { readFile } = await import("node:fs/promises");
        const data = JSON.parse(await readFile(resolveStoragePath(storageRefs[index]!), "utf8")) as unknown;
        profileItems.push(...profileCandidatesToParsedItems(data, filename));
      } catch {
        warnings.push(`Could not parse profile file ${filename}.`);
      }
    }

    const conversationFileCount = storageRefs.filter((ref, index) => {
      const filename = originalFilenames[index] ?? basename(ref);
      return /^conversations(?:-\d+)?\.json$/i.test(filename) || /^shared_conversations\.json$/i.test(filename);
    }).length;

    await request.onProgress?.({
      stage: "ingesting",
      message: `Streaming ${conversationFileCount} conversation JSON file(s) (no date filter)`,
    });

    const flushBatch = async (): Promise<void> => {
      if (currentBatch.length === 0) return;
      batchIndex += 1;
      await request.onProgress?.({
        stage: "filtering",
        message: `Filtering batch ${batchIndex} (${currentBatch.length} conversations)`,
      });
      const conversations = bundlesToImportConversations(currentBatch);
      const batchClassified = classifyBulkImportCandidates(conversations, classifyOptions);
      classified = mergeClassifiedImport(classified, batchClassified, maxExtract);
      stats.parsedConversations += currentBatch.length;
      currentBatch = [];
    };

    for await (const bundle of streamConversationsFromJsonFiles(storageRefs, { stats: streamStats, maxAgeDays: null })) {
      currentBatch.push(bundle);
      if (currentBatch.length >= batchSize) {
        await flushBatch();
      }
    }
    await flushBatch();

    warnings.push(...buildStreamIngestWarnings(streamStats));
    const ingestSummary = streamStatsToIngestSummary(streamStats);

    if (stats.parsedConversations === 0 && profileItems.length === 0) {
      warnings.push("No importable conversations found in uploaded JSON files.");
      return { items: [], stats, warnings, ingestSummary };
    }

    await request.onProgress?.({
      stage: "aggregating",
      message: "Aggregating cross-conversation style signals",
    });

    const promoted = promoteWeakSignals(classified);
    stats.hardDropped = promoted.hardDropped;
    stats.keepHigh = promoted.keepHigh.length;
    stats.keepWeak = promoted.keepWeak.length;
    stats.dropped = promoted.dropped.length;
    warnings.push(...promoted.warnings);

    const extractionPool = isInclusive
      ? [...promoted.keepHigh, ...promoted.keepWeak]
      : promoted.keepHigh;
    if (extractionPool.length === 0) {
      warnings.push("No conversations matched inclusive filters for memory extraction.");
      return { items: profileItems, stats, warnings, ingestSummary };
    }

    const ranked = [...extractionPool].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const toExtract = ranked.slice(0, maxExtract);
    if (toExtract.length < ranked.length) {
      warnings.push(
        `Capped extraction to top ${toExtract.length}/${ranked.length} conversation(s) by score.`
      );
    }

    const extractStage = config.importExtractMode === "llm" ? "extracting" : "promoting";
    await request.onProgress?.({
      stage: extractStage,
      message: config.importExtractMode === "llm"
        ? `Extracting memories from ${toExtract.length} conversation(s) via LLM`
        : `Promoting memories from ${toExtract.length} conversation(s) (no LLM)`,
    });

    const extractOptions: ExtractHighSignalMemoriesOptions = {
      concurrency: config.importExtractConcurrency,
      importProfile,
      onProgress: async ({ completed, total }) => {
        await request.onProgress?.({
          stage: extractStage,
          message: config.importExtractMode === "llm"
            ? `Extracting memories ${completed}/${total}`
            : `Promoting memories ${completed}/${total}`,
        });
      },
    };

    const extraction = config.importExtractMode === "llm"
      ? await (this.deps.extractHighSignalMemories ?? extractHighSignalImportMemories)(toExtract, extractOptions)
      : await extractHighSignalImportMemoriesHeuristic(toExtract, extractOptions);
    stats.sentToExtractor = extraction.sentToExtractor;
    stats.extracted = extraction.extracted.length;
    warnings.push(...extraction.warnings);

    const items = [...profileItems, ...extraction.extracted.map(extractedToParsedItem)];
    return { items, stats, warnings, ingestSummary };
  }

  async persistImportPreview(
    auth: AuthContext,
    input: {
      preview: ChatGptImportCandidate[];
      batchId: string;
      mode: ChatGptImportMode;
      importSource: MemoryImportSource;
      onProgress?: (progress: ChatGptImportProgress) => void | Promise<void>;
    }
  ): Promise<{
    persisted: number;
    duplicates: number;
    duplicateRows: ChatGptImportDuplicate[];
  }> {
    const acceptedPreview = input.preview.filter((row) => row.status === "accepted");
    if (acceptedPreview.length === 0) {
      return { persisted: 0, duplicates: 0, duplicateRows: [] };
    }

    await input.onProgress?.({
      stage: "persisting",
      message: `Persisting ${acceptedPreview.length} preview memory(ies)`,
    });

    const duplicateRows: ChatGptImportDuplicate[] = [];

    await runWithConcurrency(acceptedPreview, IMPORT_PERSIST_CONCURRENCY, async (candidate) => {
      const entityKey = resolveEntityKey({
        preferenceKey: candidate.preferenceKey,
        detectedKey: candidate.detectedKey,
        memoryType: candidate.memoryType,
        category: candidate.category,
      });

      const persistedRow = await this.deps.persistMemory({
        auth,
        content: candidate.raw,
        memoryType: candidate.memoryType,
        category: candidate.category,
        isPinned: candidate.isPinned,
        preferenceKey: candidate.preferenceKey,
        sourceImportBatchId: input.batchId,
        sourceImportMode: input.mode,
        sourceImportPlatform: input.importSource,
        sourceDateTime: candidate.sourceDateTime,
        importDetectedCategory: candidate.category,
        importEntityKey: entityKey,
        skipSummary: true,
      });

      if (persistedRow.deduped) {
        duplicateRows.push({
          reason: "deduped_on_persist",
          existingMemoryId: persistedRow.memoryId,
          candidate: {
            raw: candidate.raw,
            normalized: candidate.normalized,
            sourceDateTime: candidate.sourceDateTime,
            memoryType: candidate.memoryType,
            category: candidate.category,
            preferenceKey: candidate.preferenceKey,
            detectedKey: candidate.detectedKey,
          },
        });
      }
    });

    const dedupedOnPersist = duplicateRows.filter((row) => row.reason === "deduped_on_persist").length;
    const persisted = acceptedPreview.length - dedupedOnPersist;

    return {
      persisted,
      duplicates: dedupedOnPersist,
      duplicateRows,
    };
  }

  private async runBulkPipeline(
    bundles: BulkConversationBundle[],
    request: ChatGptImportRequest
  ): Promise<{ items: ParsedImportItem[]; stats: BulkPipelineStats; warnings: string[] }> {
    const warnings: string[] = [];
    const stats = emptyPipelineStats();
    stats.parsedConversations = bundles.length;

    if (bundles.length === 0) {
      return { items: [], stats, warnings };
    }

    const importProfile = request.importProfile ?? "curated";
    const isInclusive = importProfile === "inclusive";
    const classifyOptions = this.resolveBulkClassifyOptions({ ...request, importProfile });

    await request.onProgress?.({ stage: "filtering", message: "Applying deterministic filters" });

    const conversations = bundlesToImportConversations(bundles);
    const classified = classifyBulkImportCandidates(conversations, classifyOptions);
    const promoted = promoteWeakSignals(classified);

    stats.hardDropped = promoted.hardDropped;
    stats.keepHigh = promoted.keepHigh.length;
    stats.keepWeak = promoted.keepWeak.length;
    stats.dropped = promoted.dropped.length;
    warnings.push(...promoted.warnings);

    const extractionPool = isInclusive
      ? [...promoted.keepHigh, ...promoted.keepWeak]
      : promoted.keepHigh;
    if (extractionPool.length === 0) {
      warnings.push(isInclusive
        ? "No conversations matched inclusive filters for memory extraction."
        : "No KEEP_HIGH conversations to send to memory extractor.");
      return { items: [], stats, warnings };
    }

    const maxExtract = isInclusive
      ? Math.max(1, config.importInclusiveMaxExtractConversations)
      : Math.max(1, config.importMaxExtractConversations);
    const ranked = [...extractionPool].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const toExtract = ranked.slice(0, maxExtract);
    if (toExtract.length < ranked.length) {
      warnings.push(
        `Capped extraction to top ${toExtract.length}/${ranked.length} conversation(s) by score.`
      );
    }

    const extractStage = config.importExtractMode === "llm" ? "extracting" : "promoting";
    await request.onProgress?.({
      stage: extractStage,
      message: config.importExtractMode === "llm"
        ? `Extracting memories from ${toExtract.length} conversation(s) via LLM`
        : `Promoting memories from ${toExtract.length} conversation(s) (no LLM)`,
    });

    const extractOptions: ExtractHighSignalMemoriesOptions = {
      concurrency: config.importExtractConcurrency,
      importProfile,
      onProgress: async ({ completed, total }) => {
        await request.onProgress?.({
          stage: extractStage,
          message: config.importExtractMode === "llm"
            ? `Extracting memories ${completed}/${total}`
            : `Promoting memories ${completed}/${total}`,
        });
      },
    };

    const extraction = config.importExtractMode === "llm"
      ? await (this.deps.extractHighSignalMemories ?? extractHighSignalImportMemories)(toExtract, extractOptions)
      : await extractHighSignalImportMemoriesHeuristic(toExtract, extractOptions);
    stats.sentToExtractor = extraction.sentToExtractor;
    stats.extracted = extraction.extracted.length;
    warnings.push(...extraction.warnings);

    const items = extraction.extracted.map(extractedToParsedItem);
    return { items, stats, warnings };
  }

  async execute(auth: AuthContext, request: ChatGptImportRequest): Promise<ChatGptImportResult> {
    const batchId = randomUUID();
    const apply = request.apply === true;
    const parsed = resolveParsedInput(request);
    const effectiveRequest: ChatGptImportRequest = parsed.importProfileOverride
      ? { ...request, importProfile: parsed.importProfileOverride }
      : request;
    const importSource = resolveImportSource(effectiveRequest, parsed.mode);
    const warnings = [...parsed.warnings];

    let activeItems = parsed.items;
    let pipelineStats = emptyPipelineStats();
    let ingestSummary = request.ingestSummary;

    if (parsed.useBulkFilePipeline) {
      const pipeline = await this.runBulkFilePipeline(request);
      activeItems = pipeline.items;
      pipelineStats = pipeline.stats;
      ingestSummary = pipeline.ingestSummary;
      warnings.push(...pipeline.warnings);
    } else if (parsed.useConversationJsonFilesPipeline) {
      const pipeline = await this.runConversationJsonFilesPipeline(request);
      activeItems = pipeline.items;
      pipelineStats = pipeline.stats;
      ingestSummary = pipeline.ingestSummary;
      warnings.push(...pipeline.warnings);
    } else if (parsed.useBulkPipeline) {
      const pipeline = await this.runBulkPipeline(parsed.bundles, effectiveRequest);
      activeItems = pipeline.items;
      pipelineStats = pipeline.stats;
      warnings.push(...pipeline.warnings);
    }

    const existingMemories = await this.deps.listExistingMemories(auth);
    const existingByNormalizedRaw = new Map<string, ExistingMemory>();
    const existingByEntity = new Map<string, Array<ExistingMemory & { normalizedValue: string }>>();

    for (const existing of existingMemories) {
      const normalized = normalizeExisting(existing.text);
      existingByNormalizedRaw.set(normalized.normalizedRaw, existing);

      const categoryNormalized = existing.category ? normalizeKey(existing.category) || null : null;
      const entityKey = resolveEntityKey({
        preferenceKey: existing.preferenceKey,
        detectedKey: null,
        memoryType: existing.memoryType,
        category: categoryNormalized,
      });
      if (!entityKey) continue;
      const bucket = existingByEntity.get(entityKey) ?? [];
      bucket.push({
        ...existing,
        normalizedValue: normalized.detectedValue,
      });
      existingByEntity.set(entityKey, bucket);
    }

    let accepted = 0;
    let duplicates = 0;
    let conflicts = 0;
    let persisted = 0;

    const preview: ChatGptImportCandidate[] = [];
    const conflictRows: ChatGptImportConflict[] = [];
    const duplicateRows: ChatGptImportDuplicate[] = [];
    const seenInBatch = new Set<string>();

    interface PersistTask {
      candidate: ParsedImportItem;
      classification: ReturnType<typeof classifyMemory>;
      entityKey: string | null;
      acceptedCandidate: ChatGptImportCandidate;
    }
    const persistTasks: PersistTask[] = [];

    for (const candidate of activeItems) {
      const classification = resolveClassification(candidate);
      const normalizedCategory = classification.category ? normalizeKey(classification.category) || null : null;
      const entityKey = resolveEntityKey({
        preferenceKey: classification.preferenceKey,
        detectedKey: candidate.detectedKey,
        memoryType: classification.memoryType,
        category: normalizedCategory,
      });
      const normalizedCandidateValue = normalizeValue(candidate.detectedValue);

      const dedupeKey = entityKey
        ? `${entityKey}::${normalizedCandidateValue}`
        : `raw::${candidate.normalized}`;
      if (seenInBatch.has(dedupeKey)) {
        duplicates += 1;
        duplicateRows.push({
          reason: "intra_batch_duplicate",
          candidate: {
            raw: candidate.raw,
            normalized: candidate.normalized,
            sourceDateTime: candidate.sourceDateTime,
            memoryType: classification.memoryType,
            category: classification.category,
            preferenceKey: classification.preferenceKey,
            detectedKey: candidate.detectedKey,
          },
        });
        continue;
      }
      seenInBatch.add(dedupeKey);

      const existingExact = existingByNormalizedRaw.get(candidate.normalized);
      if (existingExact) {
        duplicates += 1;
        duplicateRows.push({
          reason: "exact_duplicate_existing",
          existingMemoryId: existingExact.id,
          candidate: {
            raw: candidate.raw,
            normalized: candidate.normalized,
            sourceDateTime: candidate.sourceDateTime,
            memoryType: classification.memoryType,
            category: classification.category,
            preferenceKey: classification.preferenceKey,
            detectedKey: candidate.detectedKey,
          },
        });
        continue;
      }

      if (entityKey) {
        const existingMatches = existingByEntity.get(entityKey) ?? [];
        const exactEntityMatch = existingMatches.find((match) => match.normalizedValue === normalizedCandidateValue);
        if (exactEntityMatch) {
          duplicates += 1;
          duplicateRows.push({
            reason: "exact_duplicate_existing",
            existingMemoryId: exactEntityMatch.id,
            candidate: {
              raw: candidate.raw,
              normalized: candidate.normalized,
              sourceDateTime: candidate.sourceDateTime,
              memoryType: classification.memoryType,
              category: classification.category,
              preferenceKey: classification.preferenceKey,
              detectedKey: candidate.detectedKey,
            },
          });
          continue;
        }
        const conflicting = existingMatches.find((match) => match.normalizedValue !== normalizedCandidateValue);
        if (conflicting) {
          conflicts += 1;
          conflictRows.push({
            reason: "contradictory_value",
            candidate: {
              raw: candidate.raw,
              memoryType: classification.memoryType,
              category: classification.category,
              isPinned: classification.isPinned,
              entityKey,
              sourceDateTime: candidate.sourceDateTime,
              preferenceKey: classification.preferenceKey,
              detectedKey: candidate.detectedKey,
              detectedValue: candidate.detectedValue,
            },
            existing: {
              memoryId: conflicting.id,
              text: conflicting.text,
              memoryType: conflicting.memoryType,
              preferenceKey: conflicting.preferenceKey,
              category: conflicting.category,
              detectedValue: conflicting.normalizedValue,
            },
          });
          continue;
        }
      }

      accepted += 1;
      const acceptedCandidate: ChatGptImportCandidate = {
        raw: candidate.raw,
        normalized: candidate.normalized,
        detectedKey: candidate.detectedKey,
        detectedValue: candidate.detectedValue,
        sourceDateTime: candidate.sourceDateTime,
        memoryType: classification.memoryType,
        category: classification.category,
        isPinned: classification.isPinned,
        preferenceKey: classification.preferenceKey,
        status: "accepted",
        extractConfidence: candidate.extractConfidence,
        extractStability: candidate.extractStability,
        extractType: candidate.extractType,
        sourceReason: candidate.sourceReason,
      };

      if (!apply) {
        preview.push(acceptedCandidate);
        continue;
      }

      persistTasks.push({
        candidate,
        classification,
        entityKey,
        acceptedCandidate,
      });
    }

    if (apply && persistTasks.length > 0) {
      await request.onProgress?.({
        stage: "persisting",
        message: `Persisting ${persistTasks.length} extracted memory(ies)`,
      });

      await runWithConcurrency(persistTasks, IMPORT_PERSIST_CONCURRENCY, async (task) => {
        const { candidate, classification, entityKey } = task;
        const persistedRow = await this.deps.persistMemory({
          auth,
          content: candidate.raw,
          memoryType: classification.memoryType,
          category: classification.category,
          isPinned: classification.isPinned,
          preferenceKey: classification.preferenceKey,
          sourceImportBatchId: batchId,
          sourceImportMode: parsed.mode,
          sourceImportPlatform: importSource,
          sourceDateTime: candidate.sourceDateTime,
          importDetectedCategory: classification.category,
          importEntityKey: entityKey,
          skipSummary: true,
        });

        if (persistedRow.deduped) {
          duplicateRows.push({
            reason: "deduped_on_persist",
            existingMemoryId: persistedRow.memoryId,
            candidate: {
              raw: candidate.raw,
              normalized: candidate.normalized,
              sourceDateTime: candidate.sourceDateTime,
              memoryType: classification.memoryType,
              category: classification.category,
              preferenceKey: classification.preferenceKey,
              detectedKey: candidate.detectedKey,
            },
          });
          warnings.push(`Candidate deduped at persist time: "${candidate.raw.slice(0, 80)}"`);
        }
      });

      const postPersistDedupes = duplicateRows.filter((d) => d.reason === "deduped_on_persist").length;
      persisted = persistTasks.length - postPersistDedupes;
      duplicates += postPersistDedupes;
    }

    const parsedCount = parsed.useBulkPipeline ? pipelineStats.parsedConversations : parsed.items.length;
    const skippedCount = parsed.useBulkPipeline
      ? pipelineStats.keepWeak + pipelineStats.dropped
      : Math.max(0, parsed.items.length - activeItems.length);

    const summary: ChatGptImportSummary = {
      parsed: parsedCount,
      selected: activeItems.length,
      skipped: skippedCount,
      hardDropped: pipelineStats.hardDropped,
      keepHigh: pipelineStats.keepHigh,
      keepWeak: pipelineStats.keepWeak,
      dropped: pipelineStats.dropped,
      extracted: pipelineStats.extracted,
      accepted,
      duplicates,
      conflicts,
      invalid: parsed.invalid,
      persisted,
      embedded: persisted,
    };

    return {
      batchId,
      mode: parsed.mode,
      importSource,
      summary,
      preview: apply ? [] : preview,
      conflicts: conflictRows,
      duplicates: duplicateRows,
      warnings,
      ...(ingestSummary ? { ingestSummary } : {}),
    };
  }
}

export type { ClassifiedImportConversations, BulkPipelineStats };
