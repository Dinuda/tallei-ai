import { randomUUID } from "crypto";

import type { AuthContext } from "../../domain/auth/index.js";
import { classifyMemory } from "./memory-classification.js";
import type { MemoryType } from "./memory-types.js";

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

export type ChatGptImportMode = "json_export" | "paste";

export interface ChatGptImportRequest {
  input: string;
  apply?: boolean;
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
  accepted: number;
  duplicates: number;
  conflicts: number;
  invalid: number;
  persisted: number;
}

export interface ChatGptImportResult {
  batchId: string;
  mode: ChatGptImportMode;
  summary: ChatGptImportSummary;
  preview: ChatGptImportCandidate[];
  conflicts: ChatGptImportConflict[];
  duplicates: ChatGptImportDuplicate[];
  warnings: string[];
}

interface ParsedImportItem {
  raw: string;
  detectedKey: string | null;
  detectedValue: string;
  normalized: string;
  sourceDateTime: string | null;
}

interface ParsedInputResult {
  mode: ChatGptImportMode;
  items: ParsedImportItem[];
  invalid: number;
  warnings: string[];
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
    sourceDateTime: string | null;
    importDetectedCategory: string | null;
    importEntityKey: string | null;
  }): Promise<{ memoryId: string; deduped?: boolean }>;
}

interface RawImportCandidate {
  text: string;
  sourceDateTime: string | null;
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
    "createdAt",
    "updated_at",
    "updatedAt",
    "timestamp",
    "date",
    "observed_at",
    "observedAt",
  ]) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return normalizeWhitespace(value);
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
      };
    });
}

function isDateTimeKey(key: string): boolean {
  return /^(?:date|datetime|dateTime|timestamp|created_at|createdAt|updated_at|updatedAt|observed_at|observedAt|source_datetime|sourceDateTime)$/i.test(key);
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
  const cleaned = input
    .replace(/```(?:json)?\s*\n?/gi, "")
    .replace(/```\s*$/g, "")
    .trim();
  return cleaned;
}

function fixTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, "$1");
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
  // Pure structural tokens
  if (/^[\[\]{}]+$/.test(stripped)) return true;
  if (stripped === "{" || stripped === "}" || stripped === "[]" || stripped === "{}") return true;
  // Object separators like  },  or  },
  if (/^},?$/.test(stripped)) return true;
  // Bare JSON property lines like  "memory": "..."  or  "datetime": "..."
  // They start with a quote, contain a colon, and have no braces/brackets
  if (/^["']/.test(line) && line.includes(":") && !/[{}\[\]]/.test(line)) {
    return true;
  }
  return false;
}

export function parseChatGptImportInput(input: string): ParsedInputResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { mode: "paste", items: [], invalid: 1, warnings: ["Input is empty."] };
  }

  let mode: ChatGptImportMode = "paste";
  let invalid = 0;
  const warnings: string[] = [];
  let rawItems: RawImportCandidate[] = [];

  const cleaned = stripMarkdownCodeBlocks(trimmed);
  
  try {
    // Try to parse as-is first
    let parsed = JSON.parse(cleaned) as unknown;
    mode = "json_export";
    rawItems = collectStringCandidates(parsed);
    if (rawItems.length === 0) {
      invalid += 1;
      warnings.push("No importable string candidates found in JSON payload.");
    }
  } catch (firstError) {
    // If that fails, try fixing trailing commas
    try {
      const fixed = fixTrailingCommas(cleaned);
      const parsed = JSON.parse(fixed) as unknown;
      mode = "json_export";
      rawItems = collectStringCandidates(parsed);
      if (rawItems.length === 0) {
        invalid += 1;
        warnings.push("No importable string candidates found in JSON payload.");
      }
    } catch {
      const recovered = salvageJsonLikeObjects(cleaned);
      if (recovered.length > 0) {
        mode = "json_export";
        rawItems = recovered;
        warnings.push("Found JSON-like block but could not parse it as strict JSON. Recovered candidates from object lines.");
      } else {
        // Fall back to line-by-line parsing
        mode = "paste";
        rawItems = cleaned
          .split(/\r?\n/)
          .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
          .filter((line) => line.length > 0 && !isStructuralJsonLine(line))
          .map((line) => ({ text: line, sourceDateTime: null }));
      }
    }
  }

  const items = normalizeParsedItems(rawItems);
  if (items.length === 0 && invalid > 0) {
    warnings.push("No importable memory candidates found in input.");
  }
  return { mode, items, invalid, warnings };
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

export class ChatGptMemoryImportUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(auth: AuthContext, request: ChatGptImportRequest): Promise<ChatGptImportResult> {
    const batchId = randomUUID();
    const apply = request.apply === true;
    const parsed = parseChatGptImportInput(request.input);

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
    const warnings = [...parsed.warnings];

    const seenInBatch = new Set<string>();

    for (const candidate of parsed.items) {
      const classification = classifyMemory(candidate.raw);
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
        ...candidate,
        memoryType: classification.memoryType,
        category: classification.category,
        isPinned: classification.isPinned,
        preferenceKey: classification.preferenceKey,
        status: "accepted",
      };

      if (!apply) {
        preview.push(acceptedCandidate);
        continue;
      }

      const persistedRow = await this.deps.persistMemory({
        auth,
        content: candidate.raw,
        memoryType: classification.memoryType,
        category: classification.category,
        isPinned: classification.isPinned,
        preferenceKey: classification.preferenceKey,
        sourceImportBatchId: batchId,
        sourceImportMode: parsed.mode,
        sourceDateTime: candidate.sourceDateTime,
        importDetectedCategory: classification.category,
        importEntityKey: entityKey,
      });

      if (persistedRow.deduped) {
        duplicates += 1;
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
        continue;
      }

      persisted += 1;
    }

    const summary: ChatGptImportSummary = {
      parsed: parsed.items.length,
      accepted,
      duplicates,
      conflicts,
      invalid: parsed.invalid,
      persisted,
    };

    return {
      batchId,
      mode: parsed.mode,
      summary,
      preview: apply ? [] : preview,
      conflicts: conflictRows,
      duplicates: duplicateRows,
      warnings,
    };
  }
}
