import type { AgentHandoffBinding, LoopRunAgent } from "../loop-executor/types.js";

export type HandoffResolution = {
  value: Record<string, unknown>;
  resolvedBindings: Array<{ binding: AgentHandoffBinding; resolved: boolean; provenanceValid: boolean }>;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function valueAtPath(value: unknown, path: string): unknown {
  if (path === "/") return value;
  return path.split("/").filter(Boolean).reduce<unknown>((current, segment) => {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      return Number.isFinite(index) ? current[index] : undefined;
    }
    return current && typeof current === "object"
      ? (current as Record<string, unknown>)[segment]
      : undefined;
  }, value);
}

function setAtPath(target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  if (path === "/") return asObject(value);
  const segments = path.split("/").filter(Boolean);
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    current[segment] = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
    current = current[segment] as Record<string, unknown>;
  }
  if (segments.length > 0) current[segments.at(-1)!] = value;
  return target;
}

function structuredAgentOutput(raw: unknown): unknown {
  const artifact = asObject(raw);
  const data = asObject(artifact.data);
  const nestedData = asObject(data.data);
  if ("structuredOutput" in nestedData) return nestedData.structuredOutput;
  if ("structuredOutput" in data) return data.structuredOutput;
  if ("structuredOutput" in artifact) return artifact.structuredOutput;
  return artifact;
}

export function resolveAgentHandoffBindings(input: {
  agent: Pick<LoopRunAgent, "handoffBindings">;
  priorOutputs: Record<string, unknown>;
  operatorInputs: Record<string, unknown>;
  stableConfig?: Record<string, unknown>;
}): HandoffResolution {
  let value: Record<string, unknown> = {};
  const resolvedBindings: HandoffResolution["resolvedBindings"] = [];
  for (const binding of input.agent.handoffBindings) {
    let source: unknown;
    if (binding.source.kind === "agent_output" && binding.source.agentId) {
      source = structuredAgentOutput(input.priorOutputs[`${binding.source.agentId}_output`]
        ?? input.priorOutputs[binding.source.agentId]);
    } else if (binding.source.kind === "operator_input" && binding.source.key) {
      source = input.operatorInputs[binding.source.key];
    } else if (binding.source.kind === "stable_config") {
      source = input.stableConfig ?? {};
    } else if (binding.source.kind === "artifact" && binding.source.key) {
      source = input.priorOutputs[binding.source.key];
    }
    const selected = valueAtPath(source, binding.source.path);
    const resolved = selected !== undefined && selected !== null;
    const expectedProvenance = binding.source.kind === "agent_output"
      ? "agent_output"
      : binding.source.kind;
    const provenanceValid = !binding.provenance
      || binding.provenance === expectedProvenance
      || (binding.provenance === "connector_output" && binding.source.kind === "agent_output");
    resolvedBindings.push({ binding, resolved, provenanceValid });
    if (resolved) value = setAtPath(value, binding.targetPath, selected);
  }
  return { value, resolvedBindings };
}
