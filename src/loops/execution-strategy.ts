import { normalizeToolkitSlug } from "../integrations/composio/auth.js";
import type { ExecutionStrategy, LoopSpec, ResolvedTool } from "./spec.js";

export function buildExecutionStrategy(
  spec: LoopSpec,
  tools: ResolvedTool[],
): ExecutionStrategy {
  const blueprint = spec.taskBlueprint;
  if (!blueprint?.outcomes.length) {
    return { version: 1, mode: "agentic", steps: [] };
  }

  const steps: ExecutionStrategy["steps"] = [];
  for (const outcome of blueprint.outcomes) {
    if (outcome.status === "skipped" || outcome.role === "trigger") continue;
    if (outcome.role === "source" && spec.trigger.kind === "event"
      && outcome.selectedConnector
      && normalizeToolkitSlug(outcome.selectedConnector) === normalizeToolkitSlug(spec.trigger.source)) {
      continue;
    }
    if (outcome.role === "transform") {
      const previous = steps.at(-1)?.id;
      steps.push({
        id: `transform:${outcome.id}`,
        kind: "transform",
        role: "transform",
        description: outcome.description,
        dependsOn: previous ? [previous] : [],
        inputRefs: previous ? [`steps.${previous}.output`] : ["trigger"],
        outputArtifact: outcome.id,
        requiresApproval: false,
      });
      continue;
    }
    const matching = tools.find((tool) => tool.role === outcome.role
      && (!outcome.selectedConnector
        || normalizeToolkitSlug(tool.connector) === normalizeToolkitSlug(outcome.selectedConnector)));
    if (!matching) return { version: 1, mode: "agentic", blueprint, steps: [] };
    const previous = steps.at(-1)?.id;
    steps.push({
      id: `tool:${outcome.id}`,
      kind: "tool",
      role: outcome.role,
      toolId: matching.id,
      description: outcome.description,
      dependsOn: previous ? [previous] : [],
      inputRefs: previous ? [`steps.${previous}.output`] : ["trigger"],
      requiresApproval: matching.sensitive || spec.approval.mode === "ask",
    });
  }

  if (steps.length === 0) return { version: 1, mode: "agentic", blueprint, steps: [] };
  return {
    version: 1,
    mode: steps.some((step) => step.kind === "transform") ? "hybrid" : "deterministic",
    blueprint,
    steps,
  };
}
