/**
 * critic.ts — Enforcing design critic for the loop architect output.
 */

import { getLoopTool, isKnownLoopToolRef } from "../loop-executor/tool-catalog.js";
import { isDeliveryConfigInputKey } from "../loop-runtime/memory.js";
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
  isArchitectStandaloneReviewAgent,
  writesEmailLikeCopy,
} from "./critic-helpers.js";

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

function policyToolRef(policy: { toolkit: string; actionSlug: string }): string {
  return `composio.${policy.toolkit.toLowerCase()}.action.${policy.actionSlug.toLowerCase()}`;
}

function isDraftOnlyPolicy(policy: { toolkit: string; actionSlug: string; description?: string }): boolean {
  const text = `${policy.toolkit} ${policy.actionSlug} ${policy.description ?? ""}`.toLowerCase();
  return /\bdraft\b|create[_ -]?draft|email[_ -]?draft/.test(text);
}

function isShortCircuitToolRef(toolRef: string): boolean {
  return toolRef === "internal.web_search"
    || toolRef === "internal.memory_search"
    || /^composio\.[a-z0-9_-]+\.search$/i.test(toolRef);
}

function isWebSearchToolRef(toolRef: string): boolean {
  return toolRef === "internal.web_search" || /^composio\.[a-z0-9_-]+\.search$/i.test(toolRef);
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

export function critiqueLoopDesign(
  design: LoopArchitectOutput,
  noSlopSpec?: NoSlopSpecSnapshot,
): WorkflowCriticResult {
  const issues: string[] = [];
  const requiredFixes: string[] = [];

  if (design.delivery.target !== "none" || design.delivery.provider !== "none") {
    const writePolicies = noSlopSpec?.specJson.connectorPolicy.allowedWriteActions ?? [];
    if (writePolicies.length === 0) {
      requiredFixes.push("Outbound delivery requires an approved no-slop spec connector write policy.");
    } else {
      const provider = design.delivery.provider.toLowerCase();
      const approvedRefs = new Set(writePolicies.map(policyToolRef));
      if (!approvedRefs.has(provider)) {
        requiredFixes.push(`Delivery provider "${design.delivery.provider}" must be one of the approved connector write actions: ${[...approvedRefs].join(", ")}.`);
      }
      if (design.delivery.target === "subscriber_list") {
        const selected = writePolicies.find((policy) => policyToolRef(policy) === provider);
        if (!selected || selected.risk !== "send" || isDraftOnlyPolicy(selected)) {
          requiredFixes.push("Subscriber-list delivery requires an approved send-capable connector action, not a draft action.");
        }
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

    if (!isKnownLoopToolRef(agent.tool)) {
      requiredFixes.push(`Agent "${agent.name}" uses unknown tool: ${agent.tool}`);
    }

    if (noSlopSpec) {
      const policy = noSlopSpec.specJson.connectorPolicy;
      const toolRef = agent.tool.toLowerCase();

      if (toolRef.startsWith("internal.")) {
        const approvedRead = policy.approvedInternalTools.readToolRefs.map((r) => r.toLowerCase());
        const approvedWrite = policy.approvedInternalTools.writeToolRefs.map((r) => r.toLowerCase());
        if (!approvedRead.includes(toolRef) && !approvedWrite.includes(toolRef)) {
          requiredFixes.push(`Agent "${agent.name}" uses unapproved internal tool: ${agent.tool}. Approved internal tools: ${[...approvedRead, ...approvedWrite].join(", ")}.`);
        }
      } else if (toolRef.startsWith("composio.") && toolRef.includes(".search")) {
        const toolkit = toolRef.split(".")[1];
        const approvedToolkits = policy.approvedComposioToolkits.map((t) => t.toLowerCase());
        if (!approvedToolkits.includes(toolkit)) {
          requiredFixes.push(`Agent "${agent.name}" uses unapproved Composio toolkit: ${toolkit}. Approved toolkits: ${approvedToolkits.join(", ")}.`);
        }
      } else if (toolRef.startsWith("composio.") && toolRef.includes(".action.")) {
        const approvedRead = policy.allowedReadActions.map((a) => policyToolRef(a).toLowerCase());
        const approvedWrite = policy.allowedWriteActions.map((a) => policyToolRef(a).toLowerCase());
        if (!approvedRead.includes(toolRef) && !approvedWrite.includes(toolRef)) {
          requiredFixes.push(`Agent "${agent.name}" uses unapproved Composio action: ${agent.tool}.`);
        }
      }
    }

    const tool = getLoopTool(agent.tool) as ReturnType<typeof getLoopTool> & { actionRisk?: string } | null;
    if (tool?.requiresApproval || tool?.actionRisk === "write" || tool?.actionRisk === "send" || tool?.actionRisk === "destructive") {
      const allowed = noSlopSpec?.specJson.connectorPolicy.allowedWriteActions.some((policy) =>
        policyToolRef(policy) === agent.tool.toLowerCase()
        && policy.requiresPreSendApproval
      );
      if (!allowed) {
        requiredFixes.push(`Agent "${agent.name}" uses unapproved mutating connector action: ${agent.tool}.`);
      }
      if (agent.gate?.type !== "pre_send") {
        requiredFixes.push(`Agent "${agent.name}" must use a pre_send gate before ${agent.tool}.`);
      }
    }

    if (agent.tool === "canvas.email") {
      requiredFixes.push(`Agent "${agent.name}" uses canvas.email as a tool; use renderTarget instead.`);
    }

    if (writesEmailLikeCopy(agent) && agent.tool === "internal.llm_only") {
      if (!agent.renderTarget) {
        requiredFixes.push(`Agent "${agent.name}" writes email/newsletter copy and must set renderTarget "canvas.email".`);
      }
      if (agent.gate?.type !== "draft_review") {
        requiredFixes.push(`Agent "${agent.name}" must use gate.type "draft_review" so the operator can approve or edit the draft in the canvas.`);
      }
      if (agent.artifactRole && agent.artifactRole !== "draft_body" && agent.artifactRole !== "final_preview") {
        requiredFixes.push(`Agent "${agent.name}" should set artifactRole "draft_body" when producing the newsletter/email canvas.`);
      }
    }

    if (isArchitectStandaloneReviewAgent(agent)) {
      requiredFixes.push(
        `Agent "${agent.name}" is a standalone approval/QA reviewer. Remove it and put draft_review + canvas.email on the writer agent instead.`,
      );
    }

    if (isWebSearchToolRef(agent.tool) && agent.gate?.type !== "source_confirmation") {
      requiredFixes.push(`Agent "${agent.name}" uses web search and must use gate.type "source_confirmation".`);
    }

    if (isShortCircuitToolRef(agent.tool) && agent.gate?.type === "draft_review") {
      requiredFixes.push(`Agent "${agent.name}" uses a short-circuit research tool; remove draft_review gate (use source_confirmation or memory_confirmation).`);
    }

    if (agent.gate?.type === "pre_send" && !/^composio\.[a-z0-9_-]+\.action\./i.test(agent.tool)) {
      requiredFixes.push(
        `Agent "${agent.name}" uses pre_send gate with ${agent.tool}; only connector delivery actions may use pre_send. Use draft_review for canvas drafts.`,
      );
    }

    if (agent.artifactRole === "delivery" && agent.gate?.type !== "pre_send") {
      requiredFixes.push(`Agent "${agent.name}" performs delivery and must use gate.type "pre_send".`);
    }

    if (agent.renderTarget === "canvas.preview" && agent.gate?.type !== "draft_review" && agent.gate?.type !== "pre_send") {
      requiredFixes.push(`Agent "${agent.name}" renders canvas.preview and should use draft_review or pre_send gate.`);
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

  if (noSlopSpec) {
    critiqueAgainstNoSlopSpec(design, noSlopSpec, requiredFixes);
  }

  for (const inputKey of design.inputsRequired) {
    if (isDeliveryConfigInputKey(inputKey)) {
      requiredFixes.push(
        `inputsRequired "${inputKey}" is delivery configuration. Remove it from inputsRequired and use connectorPolicy.recipientSource on the send agent instead.`,
      );
      continue;
    }
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
