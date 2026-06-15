import { z } from "zod";

import { loopBuildContractSchema } from "../loop-engine/build-contract.js";
import { noSlopSpecSnapshotSchema } from "../loop-engine/spec-contracts.js";
import type { ToolContract } from "../tool-spec/types.js";

const runnableArtifactTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  templateId: z.string().min(1),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().optional(),
  reactEmailSource: z.string().optional(),
});

/** Stored on `workflows.definition_version` for spec-driven loops. */
export const LOOP_SPEC_DEFINITION_VERSION = "loop_spec_v1";

export const runnableSpecSchema = z.object({
  version: z.literal("v1"),
  goal: z.string().min(1),
  title: z.string().min(1),
  noSlopSpec: noSlopSpecSnapshotSchema,
  discoveredToolContracts: z.array(z.record(z.unknown())).default([]),
  schedule: z.object({
    cron: z.string().min(1),
    timezone: z.string().min(1),
  }),
  buildContract: loopBuildContractSchema.optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  builderSessionId: z.string().uuid().optional(),
  artifacts: z.object({
    mode: z.string().min(1),
    templates: z.array(runnableArtifactTemplateSchema).default([]),
    structure: z.string().optional(),
  }).optional(),
});

export type RunnableSpec = z.infer<typeof runnableSpecSchema>;

export function parseRunnableSpec(metadata: unknown): RunnableSpec | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (!record.runnableSpec) return null;
  return runnableSpecSchema.parse(record.runnableSpec);
}

export function discoveredContractsFromRunnable(spec: RunnableSpec): ToolContract[] {
  return spec.discoveredToolContracts
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
    .filter((value) => typeof value.toolRef === "string") as unknown as ToolContract[];
}
