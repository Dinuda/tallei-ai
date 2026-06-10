/**
 * critic.ts — Enforcing design critic for the loop architect output.
 */

import { isKnownLoopToolRef } from "../loop-executor/tool-catalog.js";
import {
  ENGINE_MAX_AGENTS,
  deliveryProviderMatchesTarget,
  type NoSlopSpecSnapshot,
  type LoopArchitectOutput,
  workflowCriticResultSchema,
  type WorkflowCriticResult,
} from "./contracts.js";
import {
  designText,
  hasMeaningfulOverlap,
} from "./critic-helpers.js";
import {
  connectorActionToolRef,
  getStaticToolContract,
  isRenderTargetCompatible,
} from "../tool-spec/tool-contracts.js";

function agentDesignText(agent: LoopArchitectOutput["agents"][number]): string {
  return [
    agent.name,
    agent.goal,
    agent.task,
    agent.inputContract.description,
    agent.outputContract.description,
    JSON.stringify(agent.inputContract.schema),
    JSON.stringify(agent.outputContract.schema),
    ...(agent.doneCriteria ?? []),
    agent.gate?.question ?? "",
  ].join("\n");
}

function policyToolRefs(policy: { toolkit: string; actionSlug: string }): string[] {
  return [connectorActionToolRef(policy)];
}

function critiqueAgainstNoSlopSpec(
  design: LoopArchitectOutput,
  spec: NoSlopSpecSnapshot,
  requiredFixes: string[],
): void {
  const allDesignText = designText(design);

  for (const specAgent of spec.specJson.agents) {
    const represented = design.agents.some((agent) =>
      hasMeaningfulOverlap(agentDesignText(agent), `${specAgent.name} ${specAgent.goal}`),
    );
    if (!represented) {
      requiredFixes.push(`No generated agent clearly represents spec agent "${specAgent.name}".`);
    }

    for (const guardrail of specAgent.guardrails) {
      if (!hasMeaningfulOverlap(allDesignText, guardrail)) {
        requiredFixes.push(`Spec guardrail is not reflected in generated design: ${guardrail}`);
      }
    }

    for (const doneWhen of specAgent.doneWhen) {
      if (!hasMeaningfulOverlap(allDesignText, doneWhen)) {
        requiredFixes.push(`Spec done criterion is not reflected in generated design: ${doneWhen}`);
      }
    }
  }

  for (const guardrail of spec.specJson.guardrails) {
    if (!hasMeaningfulOverlap(allDesignText, guardrail)) {
      requiredFixes.push(`Spec guardrail is not reflected in generated design: ${guardrail}`);
    }
  }

  for (const criterion of spec.specJson.successCriteria) {
    if (!hasMeaningfulOverlap(allDesignText, criterion)) {
      requiredFixes.push(`Spec success criterion is not reflected in generated design: ${criterion}`);
    }
  }
}

function approvedToolRefsForSpec(spec: NoSlopSpecSnapshot): Set<string> {
  const policy = spec.specJson.connectorPolicy;
  return new Set([
    ...policy.approvedInternalTools.readToolRefs,
    ...policy.approvedInternalTools.writeToolRefs,
    ...policy.approvedComposioToolkits.map((toolkit) => `composio.${toolkit.toLowerCase()}.search`),
    ...policy.allowedReadActions.flatMap(policyToolRefs),
    ...policy.allowedWriteActions.flatMap(policyToolRefs),
  ].map((ref) => ref.toLowerCase()));
}

function approvedWriteRefsForSpec(spec?: NoSlopSpecSnapshot): Set<string> {
  return new Set((spec?.specJson.connectorPolicy.allowedWriteActions ?? [])
    .flatMap(policyToolRefs)
    .map((ref) => ref.toLowerCase()));
}

export function critiqueLoopDesign(
  design: LoopArchitectOutput,
  noSlopSpec?: NoSlopSpecSnapshot,
): WorkflowCriticResult {
  const issues: string[] = [];
  const requiredFixes: string[] = [];

  if (design.delivery.target !== "none" || design.delivery.provider !== "none") {
    const writePolicies = noSlopSpec?.specJson.connectorPolicy.allowedWriteActions ?? [];
    if (writePolicies.length === 0) {
      requiredFixes.push("External-effect provider requires an approved no-slop spec connector write policy.");
    } else {
      const provider = design.delivery.provider.toLowerCase();
      const approvedRefs = new Set(writePolicies.flatMap(policyToolRefs));
      if (!approvedRefs.has(provider)) {
        requiredFixes.push(`External-effect provider "${design.delivery.provider}" must be one of the approved connector write actions: ${[...approvedRefs].join(", ")}.`);
      }
    }
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

    const contract = getStaticToolContract(agent.tool);
    if (!contract || !isKnownLoopToolRef(agent.tool)) {
      requiredFixes.push(`Agent "${agent.name}" uses unknown tool: ${agent.tool}`);
    }

    if (noSlopSpec) {
      const toolRef = agent.tool.toLowerCase();
      const approvedRefs = approvedToolRefsForSpec(noSlopSpec);
      if (!approvedRefs.has(toolRef)) {
        requiredFixes.push(`Agent "${agent.name}" uses unapproved tool: ${agent.tool}.`);
      }
    }

    if (contract?.approval.required) {
      const allowed = approvedWriteRefsForSpec(noSlopSpec).has(agent.tool.toLowerCase());
      if (!allowed) {
        requiredFixes.push(`Agent "${agent.name}" uses unapproved external-effect tool: ${agent.tool}.`);
      }
      if (!agent.gate) {
        requiredFixes.push(`Agent "${agent.name}" must use an approval gate before ${agent.tool}.`);
      } else if (contract.approval.suggestedGate && agent.gate.type !== contract.approval.suggestedGate) {
        requiredFixes.push(`Agent "${agent.name}" uses gate ${agent.gate.type}; ${agent.tool} expects ${contract.approval.suggestedGate}.`);
      }
    }

    if (agent.tool === "canvas.email") {
      requiredFixes.push(`Agent "${agent.name}" uses canvas.email as a tool; use renderTarget instead.`);
    }

    if (agent.gate?.type === "pre_send" && !contract?.approval.required) {
      requiredFixes.push(
        `Agent "${agent.name}" uses pre_send gate with ${agent.tool}; pre_send is only valid on the exact approved external-effect tool. Use draft_review for LLM review agents, or move pre_send onto the approved connector action agent.`,
      );
    }

    if (agent.renderTarget && contract && !isRenderTargetCompatible(contract, agent.renderTarget)) {
      requiredFixes.push(`Agent "${agent.name}" uses renderTarget ${agent.renderTarget}, which is incompatible with ${agent.tool}'s output contract.`);
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

  if (
    design.delivery.target !== "none"
    && design.delivery.provider !== "none"
    && !design.agents.some((a) => a.tool.toLowerCase() === design.delivery.provider.toLowerCase())
  ) {
    requiredFixes.push(`Add an agent with tool ${design.delivery.provider} for delivery target ${design.delivery.target}.`);
  }

  if (noSlopSpec) {
    critiqueAgainstNoSlopSpec(design, noSlopSpec, requiredFixes);
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
