import { randomUUID } from "crypto";

import type { AuthContext } from "../../../domain/auth/index.js";
import {
  noSlopSpecSnapshotSchema,
  type NoSlopSpec,
  type NoSlopSpecSnapshot,
} from "../contracts/spec-contracts.js";
import { loopIntentContextSchema, type LoopIntentContext } from "../contracts/intent-context.js";
import { loopBuildContractSchema, type LoopBuildContract } from "../domain/build-contract.js";
import { normalizeProviderIdentity } from "../domain/spec-required-connectors.js";
import type { ToolContract } from "../../tool-spec/types.js";
import { reportLoopBuilderProgress } from "../utils/progress.js";
import { enrichSpecAgentsWithPersonas } from "../services/personas/enrichment.js";
import { inferActionLabelsFromToolRefs, slugifyAgentId } from "../services/personas/agent-personas.js";
import { upsertApprovedLoopSpecRow } from "../data/spec.repository.js";
import { buildRunnerSpecFromBuildContract } from "./runner.js";
import { renderSpecMarkdown } from "./markdown.js";

function specSlug(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  return slug || "loop-spec";
}

function titleFromPurpose(purpose: string): string {
  const normalized = purpose.trim().replace(/\s+/g, " ");
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized || "Loop spec";
}

function reportAgents(agents: NoSlopSpec["agents"]): void {
  for (const [index, agent] of agents.entries()) {
    reportLoopBuilderProgress({
      stage: "agent_spawn",
      message: `Assigning ${agent.name}…`,
      status: "running",
      details: {
        agentIndex: index,
        agentId: slugifyAgentId(agent.name, index),
        agentName: agent.name,
        goal: agent.goal,
        inferredActions: inferActionLabelsFromToolRefs(agent.tools ?? []),
      },
    });
  }
}

export async function compileRuntimeSpecSnapshotAsync(input: {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
  artifactBundle?: unknown;
}): Promise<NoSlopSpecSnapshot> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const intentContext = input.intentContext ? loopIntentContextSchema.parse(input.intentContext) : undefined;
  const buildContract = loopBuildContractSchema.parse(input.buildContract);

  reportLoopBuilderProgress({
    stage: "agent_spawn",
    message: "Compiling runtime spec…",
    status: "running",
  });

  const specJson = await buildRunnerSpecFromBuildContract({
    prompt,
    intentContext,
    buildContract,
    discoveredToolContracts: input.discoveredToolContracts ?? [],
    artifactBundle: input.artifactBundle,
  });
  reportAgents(specJson.agents);

  const specTitle = titleFromPurpose(specJson.purpose);
  return noSlopSpecSnapshotSchema.parse({
    id: randomUUID(),
    slug: `${specSlug(specTitle)}-${Date.now().toString(36)}`,
    version: 1,
    title: specTitle,
    bodyMarkdown: renderSpecMarkdown(specJson),
    specJson,
    ...(intentContext ? { intentContext } : {}),
    buildContract,
    approvedAt: new Date().toISOString(),
  });
}

export async function compileEnrichedRuntimeSpecSnapshot(input: {
  auth: AuthContext;
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
  artifactBundle?: unknown;
}): Promise<NoSlopSpecSnapshot> {
  const snapshot = await compileRuntimeSpecSnapshotAsync(input);
  const enrichedSpecJson = await enrichSpecAgentsWithPersonas({
    auth: input.auth,
    specId: snapshot.id,
    specJson: snapshot.specJson,
  });
  return noSlopSpecSnapshotSchema.parse({
    ...snapshot,
    bodyMarkdown: renderSpecMarkdown(enrichedSpecJson),
    specJson: enrichedSpecJson,
  });
}

export async function persistApprovedLoopSpecSnapshot(
  auth: AuthContext,
  snapshot: NoSlopSpecSnapshot,
): Promise<void> {
  const parsed = noSlopSpecSnapshotSchema.parse(snapshot);
  const sourcePrompt = parsed.intentContext?.resolvedIntent?.trim()
    || parsed.specJson.purpose.trim()
    || parsed.title;
  await upsertApprovedLoopSpecRow(auth, parsed, sourcePrompt);
}

export function specSemanticIssues(spec: NoSlopSpec, expectedProvider = ""): string[] {
  const expectedIdentity = normalizeProviderIdentity(expectedProvider);
  if (!expectedIdentity || normalizeProviderIdentity(spec.delivery.provider) === expectedIdentity) return [];
  return [
    `delivery.provider must preserve the explicitly requested available provider ${expectedProvider}; received ${spec.delivery.provider}.`,
  ];
}
