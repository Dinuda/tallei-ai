import { z } from "zod";

import {
  loopDefinitionSchema,
  loopPlanSchema,
  loopRunAgentSchema,
  loopToolAssignmentSchema,
  type LoopAgentGraph,
  type LoopAgentGraphChild,
  type LoopDefinition,
  type LoopPlan,
  type LoopRunAgent,
  type LoopStage,
} from "./types.js";

function slugId(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function slugAgentId(name: string, index: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return slug ? `${slug}_${index + 1}` : `agent_${index + 1}`;
}

export function readLoopDefinition(metadata: unknown): LoopDefinition {
  const row = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return loopDefinitionSchema.parse(row.loopDefinition);
}

export function isDynamicPlanDefinition(definition: LoopDefinition): boolean {
  return Boolean(definition.plan?.stages?.length);
}

export function stageSeq(plan: LoopPlan, stageId: string): number {
  return plan.stages.findIndex((stage) => stage.id === stageId);
}

export function executableStageToAgent(stage: LoopStage): LoopRunAgent {
  if (stage.kind === "external_action") {
    return loopRunAgentSchema.parse({
      id: stage.id,
      name: stage.label,
      task: `Execute external action: ${stage.label}`,
      tools: [{ ref: stage.toolRef }],
    });
  }
  return loopRunAgentSchema.parse({
    id: stage.id,
    name: stage.name,
    task: stage.task,
    tools: stage.toolRef ? [{ ref: stage.toolRef }] : [],
  });
}

export function planStrategyText(plan: LoopPlan): string {
  const lines = plan.stages.map((stage, index) => {
    if (stage.kind === "agent") {
      return `${index + 1}. Agent: ${stage.name} (${stage.toolRef ?? "LLM only"}) -> ${stage.outputArtifactId ?? "comment"}`;
    }
    if (stage.kind === "approval_gate") {
      return `${index + 1}. Approval gate: ${stage.label} for ${stage.artifactId}`;
    }
    if (stage.kind === "input_gate") {
      return `${index + 1}. Input gate: ${stage.label} -> ${stage.outputArtifactId}`;
    }
    return `${index + 1}. External action: ${stage.label} via ${stage.toolRef}`;
  });
  return [
    "IntentAnalyzerAgent generated a dynamic one-thing stage plan.",
    `Goal: ${plan.goal}`,
    "",
    ...lines,
  ].join("\n");
}

export function normalizeRosterAgents(agents: LoopRunAgent[]): LoopRunAgent[] {
  const seen = new Set<string>();
  return agents.map((agent, index) => {
    const baseId = agent.id.trim() || slugAgentId(agent.name, index);
    const id = seen.has(baseId) ? `${baseId}_${index + 1}` : baseId;
    seen.add(id);
    return loopRunAgentSchema.parse({
      id,
      name: agent.name.trim(),
      task: agent.task.trim(),
      tools: agent.tools.map((tool) => loopToolAssignmentSchema.parse(tool)),
    });
  });
}

export function dynamicPlanRoster(plan: LoopPlan): LoopRunAgent[] {
  return normalizeRosterAgents(
    plan.stages
      .filter((stage) => stage.kind === "agent")
      .map((stage) => executableStageToAgent(stage))
  );
}

export function artifactDefinition(plan: LoopPlan, artifactId: string | null | undefined) {
  if (!artifactId) return null;
  return plan.artifacts.find((artifact) => artifact.id === artifactId) ?? null;
}

function childAgentToStage(child: LoopAgentGraphChild): LoopStage {
  return {
    kind: "agent",
    id: slugId(child.id, "agent"),
    name: child.name,
    task: child.task,
    toolRef: child.tools[0]?.ref ?? null,
    ...(child.outputArtifactId ? { outputArtifactId: child.outputArtifactId } : {}),
  };
}

function buildArtifacts(children: LoopAgentGraphChild[]): LoopPlan["artifacts"] {
  return children
    .map((child) => child.outputArtifactId
      ? {
          id: child.outputArtifactId,
          kind: child.outputArtifactKind ?? "agent_output",
          label: child.name,
        }
      : null)
    .filter((artifact): artifact is LoopPlan["artifacts"][number] => Boolean(artifact));
}

export function buildPlanFromAgentGraph(
  goal: string,
  graph: LoopAgentGraph,
  allowedIntegrations: string[]
): LoopPlan {
  if (graph.children.length === 0) {
    throw new Error("Cannot derive a loop plan from an agent graph without children");
  }
  const stages = graph.children.map(childAgentToStage);
  const allowedToolRefs = [...new Set(
    graph.children.flatMap((child) => child.tools.map((tool) => tool.ref.trim())).filter(Boolean)
  )];
  return loopPlanSchema.parse({
    goal,
    stages,
    artifacts: buildArtifacts(graph.children),
    allowedToolRefs,
    allowedIntegrations,
  });
}
