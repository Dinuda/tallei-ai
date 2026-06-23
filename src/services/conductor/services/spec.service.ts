import type { AuthContext } from "../../../domain/auth/index.js";
import {
  noSlopSpecDraftSchema,
  noSlopSpecSchema,
  noSlopSpecSnapshotSchema,
  noSlopSpecStatusSchema,
  type NoSlopSpec,
  type NoSlopSpecSnapshot,
  type NoSlopSpecStatus,
} from "../contracts/spec-contracts.js";
import { loopIntentContextSchema, type LoopIntentContext } from "../contracts/intent-context.js";
import { listComposioToolkits } from "../../connectors/composio.js";
import {
  findLoopSpecRow,
  listLoopSpecRows,
  repairLoopSpecRow,
  type LoopSpecRow,
} from "../data/spec.repository.js";
export type { LoopSpecRow } from "../data/spec.repository.js";
import {
  compileEnrichedRuntimeSpecSnapshot,
  compileRuntimeSpecSnapshotAsync,
  persistApprovedLoopSpecSnapshot,
  renderSpecMarkdown,
  specSemanticIssues,
  buildRunnerSpecFromBuildContract,
} from "./compile.service.js";
import { specAtomicityIssues } from "./conductor.service.js";

export type LoopSpecView = {
  id: string;
  slug: string;
  title: string;
  status: NoSlopSpecStatus;
  version: number;
  sourcePrompt: string;
  intentContext?: LoopIntentContext;
  bodyMarkdown: string;
  specJson: NoSlopSpec;
  approvedAt: string | null;
  approvedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export {
  compileEnrichedRuntimeSpecSnapshot,
  compileRuntimeSpecSnapshotAsync,
  persistApprovedLoopSpecSnapshot,
  renderSpecMarkdown,
  specSemanticIssues,
  buildRunnerSpecFromBuildContract,
  specAtomicityIssues,
};

function normalizeSpecJson(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (!trimmed) return input;
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

function toIsoTimestamp(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function providerMentionPattern(value: string): RegExp | null {
  const words = value.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(`\\b${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^a-z0-9]+")}\\b`, "i");
}

async function explicitAvailableProvider(intent: string): Promise<string> {
  const toolkits = await listComposioToolkits().catch(() => []);
  const matches = toolkits.filter((toolkit) =>
    [toolkit.slug, toolkit.name].some((value) => providerMentionPattern(value)?.test(intent)));
  return matches.length === 1 ? matches[0]!.slug : "";
}

async function hydrateLoopSpecJson(
  auth: AuthContext,
  rawSpec: unknown,
  options?: { mode?: "draft" | "approved"; intent?: string; validateSemantics?: boolean },
): Promise<NoSlopSpec> {
  const mode = options?.mode ?? "approved";
  const normalized = normalizeSpecJson(rawSpec);
  const schema = mode === "draft" ? noSlopSpecDraftSchema : noSlopSpecSchema;
  const parsed = schema.parse(normalized);
  if (mode === "approved" && options?.validateSemantics) {
    const semanticIssues = specSemanticIssues(parsed, await explicitAvailableProvider(options.intent ?? ""));
    if (semanticIssues.length > 0) {
      throw new Error(`Spec contains implementation details that cannot be approved: ${semanticIssues.join("; ")}`);
    }
  }
  return parsed;
}

async function mapSpecRow(
  auth: AuthContext,
  row: LoopSpecRow,
  options?: { persistRepair?: boolean },
): Promise<LoopSpecView> {
  const intentContext = row.intent_context_json
    ? loopIntentContextSchema.parse(row.intent_context_json)
    : undefined;
  const specJson = await hydrateLoopSpecJson(auth, row.spec_json, {
    mode: row.status === "approved" ? "approved" : "draft",
    intent: intentContext?.resolvedIntent ?? row.source_prompt,
  });
  if (options?.persistRepair) {
    const repaired = JSON.stringify(specJson);
    const stored = typeof row.spec_json === "string" ? row.spec_json : JSON.stringify(row.spec_json);
    const rendered = renderSpecMarkdown(specJson);
    if (repaired !== stored || rendered !== row.body_markdown) {
      await repairLoopSpecRow(auth, row.id, repaired, rendered);
    }
  }

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: noSlopSpecStatusSchema.parse(row.status),
    version: row.version,
    sourcePrompt: row.source_prompt,
    ...(intentContext ? { intentContext } : {}),
    bodyMarkdown: renderSpecMarkdown(specJson),
    specJson,
    approvedAt: toIsoTimestamp(row.approved_at),
    approvedByUserId: row.approved_by_user_id,
    createdAt: toIsoTimestamp(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoTimestamp(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function mapLoopSpecRowForTest(row: LoopSpecRow): LoopSpecView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: noSlopSpecStatusSchema.parse(row.status),
    version: row.version,
    sourcePrompt: row.source_prompt,
    ...(row.intent_context_json ? { intentContext: loopIntentContextSchema.parse(row.intent_context_json) } : {}),
    bodyMarkdown: row.body_markdown,
    specJson: noSlopSpecSchema.parse(row.spec_json),
    approvedAt: toIsoTimestamp(row.approved_at),
    approvedByUserId: row.approved_by_user_id,
    createdAt: toIsoTimestamp(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoTimestamp(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export async function listLoopSpecs(auth: AuthContext): Promise<LoopSpecView[]> {
  const rows = await listLoopSpecRows(auth);
  return Promise.all(rows.map((row) => mapSpecRow(auth, row)));
}

export async function getLoopSpec(auth: AuthContext, specId: string): Promise<LoopSpecView | null> {
  const row = await findLoopSpecRow(auth, specId);
  return row ? mapSpecRow(auth, row, { persistRepair: true }) : null;
}

export function approvedSpecSnapshot(spec: LoopSpecView): NoSlopSpecSnapshot {
  if (spec.status !== "approved" || !spec.approvedAt) {
    throw new Error("Loop spec must be approved before generation");
  }
  return noSlopSpecSnapshotSchema.parse({
    id: spec.id,
    slug: spec.slug,
    version: spec.version,
    title: spec.title,
    bodyMarkdown: spec.bodyMarkdown,
    specJson: spec.specJson,
    ...(spec.intentContext ? { intentContext: spec.intentContext } : {}),
    ...(spec.specJson.buildContract ? { buildContract: spec.specJson.buildContract } : {}),
    approvedAt: spec.approvedAt,
  });
}
