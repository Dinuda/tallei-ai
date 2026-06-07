/**
 * run-memory.ts — Per-run accumulated operator inputs and approved memories.
 */

import type { LoopRunContext } from "../loop-executor/run-context.js";
import { loadArtifact, upsertEngineArtifact } from "../loop-executor/run-store.js";
import type { LoopDefinition, LoopRunAgent } from "../loop-executor/types.js";
import type { LoopGateType } from "../loop-executor/types.js";

export const RUN_MEMORY_ARTIFACT_ID = "run_memory";

export type ApprovedMemory = {
  id: string;
  excerpt: string;
};

export type RunMemory = {
  inputs: Record<string, string>;
  approvedMemories: ApprovedMemory[];
  updatedAt: string;
};

export function emptyRunMemory(): RunMemory {
  return { inputs: {}, approvedMemories: [], updatedAt: new Date().toISOString() };
}

export function isInputValidationAgent(agent: { id: string; name?: string }): boolean {
  const label = `${agent.id} ${agent.name ?? ""}`.toLowerCase();
  return label.includes("validator") || label.includes("input_gate");
}

/** Resolve required input keys from definition, design diagnostics, agent graph, or gate fields. */
export function resolveRequiredInputKeys(
  definition: LoopDefinition,
  gateFields?: Array<{ key: string }>,
): string[] {
  if (definition.inputsRequired?.length) return [...definition.inputsRequired];

  const diagnostics = definition.builderMeta?.designDiagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    const required = (diagnostics as Record<string, unknown>).inputsRequired;
    if (Array.isArray(required) && required.every((key) => typeof key === "string")) {
      return required as string[];
    }
  }

  const fromGraph: string[] = [];
  for (const child of definition.agentGraph?.children ?? []) {
    const schema = child.inputContract?.schema;
    if (!schema || typeof schema !== "object") continue;
    const provided = (schema as Record<string, unknown>).provided;
    if (provided && typeof provided === "object" && !Array.isArray(provided)) {
      for (const key of Object.keys(provided as Record<string, unknown>)) {
        fromGraph.push(key.replace(/\?$/, ""));
      }
    }
  }
  if (fromGraph.length > 0) return [...new Set(fromGraph)];

  if (gateFields?.length) return gateFields.map((field) => field.key);

  return ["sprint_notes"];
}

export function hasRequiredRunInputs(
  definition: LoopDefinition,
  runMemory: RunMemory,
  gateFields?: Array<{ key: string }>,
): boolean {
  const keys = resolveRequiredInputKeys(definition, gateFields);
  if (keys.length === 0) return Object.keys(runMemory.inputs).length > 0;
  return keys.every((key) => Boolean(runMemory.inputs[key]?.trim()));
}

function parseRunMemoryData(data: unknown): RunMemory {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const inputsRaw = root.inputs && typeof root.inputs === "object" && !Array.isArray(root.inputs)
    ? root.inputs as Record<string, unknown>
    : {};
  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputsRaw)) {
    if (typeof value === "string" && value.trim()) inputs[key] = value;
  }

  const approvedMemories: ApprovedMemory[] = [];
  for (const row of Array.isArray(root.approvedMemories) ? root.approvedMemories : []) {
    const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const id = typeof item.id === "string" ? item.id : "";
    const excerpt = typeof item.excerpt === "string" ? item.excerpt : "";
    if (id && excerpt) approvedMemories.push({ id, excerpt });
  }

  return {
    inputs,
    approvedMemories,
    updatedAt: typeof root.updatedAt === "string" ? root.updatedAt : new Date().toISOString(),
  };
}

export async function loadRunMemory(context: LoopRunContext): Promise<RunMemory> {
  const artifact = await loadArtifact(context, RUN_MEMORY_ARTIFACT_ID);
  if (!artifact) return emptyRunMemory();
  if (artifact.data_json) return parseRunMemoryData(artifact.data_json);
  if (typeof artifact.body === "string" && artifact.body.trim()) {
    try {
      return parseRunMemoryData(JSON.parse(artifact.body));
    } catch {
      return emptyRunMemory();
    }
  }
  return emptyRunMemory();
}

export async function mergeRunMemory(
  context: LoopRunContext,
  patch: Partial<Pick<RunMemory, "inputs" | "approvedMemories">>,
): Promise<RunMemory> {
  const current = await loadRunMemory(context);
  const merged: RunMemory = {
    inputs: { ...current.inputs, ...(patch.inputs ?? {}) },
    approvedMemories: patch.approvedMemories ?? current.approvedMemories,
    updatedAt: new Date().toISOString(),
  };

  await upsertEngineArtifact({
    context,
    artifactId: RUN_MEMORY_ARTIFACT_ID,
    kind: "run_memory",
    label: "Run memory",
    body: JSON.stringify(merged, null, 2),
    data: merged as unknown as Record<string, unknown>,
    stageId: "run",
  });

  return merged;
}

export function applyGateDecisionToRunMemory(input: {
  gateType: LoopGateType;
  decision: Record<string, unknown>;
  definition: LoopDefinition;
  gateFields?: Array<{ key: string }>;
}): Partial<Pick<RunMemory, "inputs" | "approvedMemories">> {
  if (input.gateType === "missing_input" && typeof input.decision.value === "string") {
    const value = input.decision.value.trim();
    if (!value) return {};
    const keys = resolveRequiredInputKeys(input.definition, input.gateFields);
    const inputs: Record<string, string> = {};
    for (const key of keys.length > 0 ? keys : ["sprint_notes"]) {
      inputs[key] = value;
    }
    return { inputs };
  }

  if (input.gateType === "memory_confirmation" && Array.isArray(input.decision.items)) {
    const approvedMemories = input.decision.items
      .map((row) => {
        const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
        const id = typeof item.id === "string" ? item.id : "";
        const excerpt = typeof item.excerpt === "string" ? item.excerpt : "";
        const include = item.include !== false;
        if (!id || !excerpt || !include) return null;
        return { id, excerpt };
      })
      .filter((row): row is ApprovedMemory => row !== null);
    return { approvedMemories };
  }

  return {};
}

export function buildAgentHandoff(
  agentSpec: LoopRunAgent,
  runMemory: RunMemory,
  priorAgentArtifacts: Record<string, unknown>,
): Record<string, unknown> {
  const handoff: Record<string, unknown> = { ...priorAgentArtifacts };

  for (const [key, value] of Object.entries(runMemory.inputs)) {
    handoff[key] = value;
  }

  if (runMemory.approvedMemories.length > 0) {
    handoff.approved_memories = runMemory.approvedMemories;
    handoff.memories = runMemory.approvedMemories;
  }

  if (Object.keys(runMemory.inputs).length > 0) {
    handoff.operator_input = { inputs: runMemory.inputs };
  }

  if (agentSpec.id && handoff[agentSpec.id]) {
    delete handoff[agentSpec.id];
  }

  return handoff;
}
