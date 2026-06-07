/**
 * critic.ts — Enforcing design critic for the loop architect output.
 */

import { listLoopTools } from "../loop-executor/tool-catalog.js";
import {
  ENGINE_MAX_AGENTS,
  deliveryProviderMatchesTarget,
  type LoopArchitectOutput,
  workflowCriticResultSchema,
  type WorkflowCriticResult,
} from "./contracts.js";

const KNOWN_TOOL_REFS = new Set(listLoopTools().map((tool) => tool.ref));

export function critiqueLoopDesign(design: LoopArchitectOutput): WorkflowCriticResult {
  const issues: string[] = [];
  const requiredFixes: string[] = [];

  if (design.delivery.target !== "none" || design.delivery.provider !== "none") {
    requiredFixes.push('Outbound delivery is disabled. Use delivery provider "none" and target "none".');
  }

  if (design.agents.length > ENGINE_MAX_AGENTS) {
    requiredFixes.push(`Reduce agent count to at most ${ENGINE_MAX_AGENTS}.`);
  }

  if (design.agents.length < 2) {
    requiredFixes.push("Design at least 2 specialist agents.");
  }

  const agentIds = new Set<string>();
  for (const agent of design.agents) {
    if (agentIds.has(agent.id)) {
      requiredFixes.push(`Duplicate agent id: ${agent.id}`);
    }
    agentIds.add(agent.id);

    if (!agent.goal?.trim()) {
      requiredFixes.push(`Agent "${agent.name}" is missing a goal.`);
    }

    if (!KNOWN_TOOL_REFS.has(agent.tool)) {
      requiredFixes.push(`Agent "${agent.name}" uses unknown tool: ${agent.tool}`);
    }

    if (agent.tool === "canvas.email") {
      requiredFixes.push(`Agent "${agent.name}" uses canvas.email as a tool; use renderTarget instead.`);
    }

    if (
      /email|newsletter/i.test(`${agent.name} ${agent.goal} ${agent.task}`)
      && !agent.renderTarget
      && agent.tool === "internal.llm_only"
    ) {
      issues.push(`Agent "${agent.name}" writes email-like copy but does not set renderTarget.`);
    }

    if (!agent.inputContract?.description?.trim() || !agent.outputContract?.description?.trim()) {
      requiredFixes.push(`Agent "${agent.name}" must declare input and output contracts.`);
    }

    if (agent.doneCriteria.length === 0) {
      requiredFixes.push(`Agent "${agent.name}" must include doneCriteria.`);
    }
  }

  if (!deliveryProviderMatchesTarget(design.delivery.provider, design.delivery.target)) {
    requiredFixes.push(
      `Delivery provider "${design.delivery.provider}" does not match target "${design.delivery.target}".`,
    );
  }

  if (design.delivery.target !== "none" && !design.agents.some((a) => a.tool === design.delivery.provider)) {
    requiredFixes.push(`Add an agent with tool ${design.delivery.provider} for delivery target ${design.delivery.target}.`);
  }

  for (const inputKey of design.inputsRequired) {
    const covered = design.agents.some((agent) =>
      agent.task.toLowerCase().includes(inputKey.toLowerCase())
      || agent.goal.toLowerCase().includes(inputKey.toLowerCase())
      || agent.gate?.type === "missing_input",
    );
    if (!covered) {
      issues.push(`inputsRequired "${inputKey}" has no obvious producing agent or missing_input gate.`);
    }
  }

  const riskLevel = requiredFixes.length > 2 ? "high" : requiredFixes.length > 0 ? "medium" : "low";

  return workflowCriticResultSchema.parse({
    pass: requiredFixes.length === 0,
    riskLevel,
    issues,
    requiredFixes,
  });
}
