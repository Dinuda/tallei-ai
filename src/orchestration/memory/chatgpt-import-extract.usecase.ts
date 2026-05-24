import { config } from "../../config/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { MemoryType } from "./memory-types.js";
import type { ScoredImportConversation } from "./chatgpt-import-signal.usecase.js";

export type ExtractedImportMemoryType =
  | "identity"
  | "preference"
  | "project"
  | "company"
  | "technical"
  | "decision"
  | "workflow"
  | "customer"
  | "other";

export interface ExtractedImportMemory {
  memory: string;
  type: ExtractedImportMemoryType;
  stability: number;
  reuseLikelihood: number;
  confidence: number;
  sourceReason: string;
  sourceConversationId: string;
  sourceDateTime: string | null;
  sourceFile: string;
}

export interface ExtractHighSignalMemoriesResult {
  extracted: ExtractedImportMemory[];
  sentToExtractor: number;
  warnings: string[];
}

export interface ExtractHighSignalMemoriesOptions {
  concurrency?: number;
  importProfile?: "curated" | "inclusive";
  onProgress?: (progress: { completed: number; total: number }) => void | Promise<void>;
}

interface RawExtractorMemory {
  memory?: unknown;
  type?: unknown;
  stability?: unknown;
  reuse_likelihood?: unknown;
  confidence?: unknown;
  source_reason?: unknown;
}

const STABILITY_MIN = 0.55;
const REUSE_MIN = 0.5;
const CONFIDENCE_MIN = 0.6;
const MEMORY_MIN_LENGTH = 20;
const MAX_INPUT_CHARS = 3_800;
const MAX_FACTS_PER_CONVERSATION = 8;
const SUPPORTED_TYPES = new Set<ExtractedImportMemoryType>([
  "identity",
  "preference",
  "project",
  "company",
  "technical",
  "decision",
  "workflow",
  "customer",
  "other",
]);

const SYSTEM_PROMPT = `You are extracting durable memory candidates from a ChatGPT export.

Extract only facts likely to be useful in future conversations.

Prioritize:
1. Stable user identity, preferences, writing style, tools, constraints
2. Company/product/project facts
3. Technical stack and architecture decisions
4. Business decisions, customer insights, positioning
5. Repeated workflows or recurring tasks

Do not extract:
- one-off factual questions
- temporary requests
- generic explanations
- assistant opinions not confirmed by the user
- duplicated facts
- facts only true inside this conversation
- simple rewrite instructions unless they reveal recurring preference

Return JSON only:
{"items":[{"memory":"...","type":"identity|preference|project|company|technical|decision|workflow|customer|other","stability":0.0,"reuse_likelihood":0.0,"confidence":0.0,"source_reason":"..."}]}`;

function clampScore(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeMemoryType(value: unknown): ExtractedImportMemoryType {
  if (typeof value !== "string") return "other";
  const lowered = value.trim().toLowerCase();
  if (SUPPORTED_TYPES.has(lowered as ExtractedImportMemoryType)) {
    return lowered as ExtractedImportMemoryType;
  }
  return "other";
}

function parseJsonItems(raw: string): RawExtractorMemory[] {
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed?.items)) return [];
    return parsed.items.filter((item): item is RawExtractorMemory => Boolean(item) && typeof item === "object");
  } catch {
    return [];
  }
}

function buildUserPayload(conversation: ScoredImportConversation): string {
  const payload = {
    conversation_id: conversation.id,
    source_file: conversation.sourceFile,
    source_datetime: conversation.sourceDateTime,
    title: conversation.title,
    score: conversation.score,
    reasons: conversation.reasons,
    signal_scores: conversation.signalScores,
    conversation_bundle: conversation.textBundle.slice(0, MAX_INPUT_CHARS),
  };
  return JSON.stringify(payload);
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current]!, current);
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export function mapExtractTypeToMemoryType(
  type: ExtractedImportMemoryType
): { memoryType: MemoryType; category: string | null } {
  switch (type) {
    case "identity":
      return { memoryType: "preference", category: "identity" };
    case "preference":
      return { memoryType: "preference", category: null };
    case "project":
      return { memoryType: "fact", category: "project" };
    case "company":
      return { memoryType: "fact", category: "company" };
    case "customer":
      return { memoryType: "fact", category: "customer" };
    case "technical":
      return { memoryType: "fact", category: "stack" };
    case "decision":
      return { memoryType: "decision", category: null };
    case "workflow":
      return { memoryType: "lesson", category: "workflow" };
    default:
      return { memoryType: "fact", category: null };
  }
}

async function extractConversationMemories(
  conversation: ScoredImportConversation,
  model: string,
  supportsCustomTemperature: boolean
): Promise<{ rows: ExtractedImportMemory[]; warning: string | null }> {
  try {
    const response = await aiProviderRegistry.chat({
      model,
      ...(supportsCustomTemperature ? { temperature: 0 } : {}),
      responseFormat: "json_object",
      maxTokens: 900,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPayload(conversation) },
      ],
    });

    const rows: ExtractedImportMemory[] = [];
    const parsedRows = parseJsonItems(response.text);
    for (const row of parsedRows.slice(0, MAX_FACTS_PER_CONVERSATION)) {
      const memory = typeof row.memory === "string" ? row.memory.trim() : "";
      if (memory.length < MEMORY_MIN_LENGTH) continue;
      const stability = clampScore(row.stability);
      const reuseLikelihood = clampScore(row.reuse_likelihood);
      const confidence = clampScore(row.confidence);
      if (stability < STABILITY_MIN || reuseLikelihood < REUSE_MIN || confidence < CONFIDENCE_MIN) continue;

      rows.push({
        memory,
        type: normalizeMemoryType(row.type),
        stability,
        reuseLikelihood,
        confidence,
        sourceReason: typeof row.source_reason === "string"
          ? row.source_reason.trim().slice(0, 240)
          : "",
        sourceConversationId: conversation.id,
        sourceDateTime: conversation.sourceDateTime,
        sourceFile: conversation.sourceFile,
      });
    }
    return { rows, warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      rows: [],
      warning: `Extractor failed for conversation ${conversation.id}: ${reason}`,
    };
  }
}

export async function extractHighSignalImportMemories(
  conversations: ScoredImportConversation[],
  options?: ExtractHighSignalMemoriesOptions
): Promise<ExtractHighSignalMemoriesResult> {
  if (conversations.length === 0) {
    return { extracted: [], sentToExtractor: 0, warnings: [] };
  }

  const warnings: string[] = [];
  const seen = new Set<string>();
  const extracted: ExtractedImportMemory[] = [];
  const model = config.importMemoryExtractModel;
  const supportsCustomTemperature = !model.toLowerCase().startsWith("gpt-5");
  const concurrency = options?.concurrency ?? config.importExtractConcurrency;
  const total = conversations.length;
  let completed = 0;

  const batchResults = await runWithConcurrency(
    conversations,
    concurrency,
    async (conversation) => {
      const result = await extractConversationMemories(conversation, model, supportsCustomTemperature);
      completed += 1;
      await options?.onProgress?.({ completed, total });
      return result;
    }
  );

  for (const result of batchResults) {
    if (result.warning) warnings.push(result.warning);
    for (const row of result.rows) {
      const dedupeKey = row.memory.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      extracted.push(row);
    }
  }

  if (extracted.length === 0) {
    warnings.push("No promoted memories met extractor quality thresholds.");
  }

  return {
    extracted,
    sentToExtractor: conversations.length,
    warnings,
  };
}
