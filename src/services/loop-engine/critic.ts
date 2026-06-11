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
  inputRequirementKeys,
  normalizeInputRequirements,
  isReviewInputSurface,
  isRecipientInputKey,
  canonicalizeInputRequirementsList,
  extractInputRequirementContext,
  requirementMatchesSpec,
  specRequiresRunStartContent,
} from "./input-surfaces.js";
import {
  designText,
  hasMeaningfulOverlap,
} from "./critic-helpers.js";
import {
  connectorActionToolRef,
  getStaticToolContract,
  isRenderTargetCompatible,
} from "../tool-spec/tool-contracts.js";
import { isInputValidationAgent } from "../loop-runtime/memory.js";

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

function critiqueInputRequirements(
  design: LoopArchitectOutput,
  spec: NoSlopSpecSnapshot,
  requiredFixes: string[],
  issues: string[],
): void {
  const designRequirements = normalizeInputRequirements({
    inputRequirements: design.inputRequirements,
    inputsRequired: design.inputsRequired,
  });
  const context = extractInputRequirementContext(spec.specJson as unknown as Record<string, unknown>);
  const specRequirements = canonicalizeInputRequirementsList(
    spec.specJson.inputRequirements ?? [],
    context,
  );
  const canonicalDesignRequirements = canonicalizeInputRequirementsList(designRequirements, context);
  const runStartRequirements = canonicalDesignRequirements.filter((req) => req.when === "run_start" && req.required);
  const specNeedsRunStart = specRequiresRunStartContent(spec.specJson);

  if (specNeedsRunStart && runStartRequirements.length === 0) {
    requiredFixes.push("Spec requires run_start operator content; declare matching inputRequirements and an Input Validator agent.");
  }

  if (!specNeedsRunStart && runStartRequirements.length > 0) {
    requiredFixes.push("Remove run_start content inputs (e.g. sprint_notes); this workflow sources content from research agents, not operator paste at run_start.");
  }

  for (const specRequirement of specRequirements) {
    const represented = canonicalDesignRequirements.some((req) => requirementMatchesSpec(req, specRequirement));
    if (!represented) {
      requiredFixes.push(`Missing inputRequirements entry for spec key "${specRequirement.key}" (${specRequirement.surface} @ ${specRequirement.when}).`);
    }
  }

  const recipientKind = spec.specJson.connectorPolicy.recipientSource.kind;
  for (const req of canonicalDesignRequirements.filter((row) => row.when === "before_send")) {
    if (isReviewInputSurface(req.surface)) continue;
    if (!isRecipientInputKey(req.key) && req.key !== "recipients" && req.key !== "audience_id") {
      issues.push(`before_send "${req.key}" should use confirm.send/review.email for approval checkpoints, not a recipient surface.`);
      continue;
    }
    if (recipientKind === "configured" && req.surface !== "input.audience_id") {
      requiredFixes.push(`before_send recipient requirement "${req.key}" must use input.audience_id for configured recipientSource.`);
    }
    if ((recipientKind === "uploaded" || recipientKind === "operator_input") && req.surface !== "input.contacts_csv") {
      requiredFixes.push(`before_send recipient requirement "${req.key}" must use input.contacts_csv for uploaded/operator recipientSource.`);
    }
  }

  if (runStartRequirements.length > 0) {
    const collectors = design.agents.filter((agent) => isInputValidationAgent(agent) || agent.gate?.type === "missing_input");
    if (collectors.length === 0) {
      requiredFixes.push("run_start inputRequirements require an Input Validator agent with missing_input gate as the first roster step.");
    } else {
      const first = design.agents[0];
      if (first && !isInputValidationAgent(first) && first.gate?.type !== "missing_input") {
        requiredFixes.push("Input Validator must be the first agent when run_start inputRequirements are declared.");
      }
    }
  }

  for (const agent of design.agents) {
    if ((agent.tool === "internal.web_search" || agent.tool === "internal.memory_search") && agent.gate?.type === "missing_input") {
      requiredFixes.push(`Agent "${agent.name}" is a search agent; use source_confirmation or no gate — never missing_input for content collection.`);
    }
    if (agent.gate?.type === "pre_send" && agent.tool.toLowerCase().includes("internal.llm_only")) {
      requiredFixes.push(`Agent "${agent.name}" must not use pre_send with internal.llm_only; use draft_review or an approved connector tool.`);
    }
    if (/pre-send review|paste.*upload|recipient upload/i.test(`${agent.name} ${agent.goal}`) && !isInputValidationAgent(agent)) {
      issues.push(`Avoid dedicated "${agent.name}" for runtime input collection unless it is an Input Validator for run_start requirements.`);
    }
  }

  if (designRequirements.length > 0 && design.inputsRequired.length === 0) {
    issues.push("inputsRequired should mirror inputRequirements keys for backward compatibility.");
  } else if (canonicalDesignRequirements.length > 0) {
    const keys = new Set(inputRequirementKeys(canonicalDesignRequirements));
    for (const key of design.inputsRequired) {
      if (!keys.has(key)) {
        issues.push(`inputsRequired "${key}" is not declared in inputRequirements.`);
      }
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

    if (agent.renderTarget === "canvas.email" || agent.renderTarget === "canvas.preview") {
      const schemaFormat = agent.outputContract?.schema?.format;
      const requestedOutputText = `${agent.outputContract?.description ?? ""} ${JSON.stringify(agent.outputContract?.schema ?? {})}`;
      if (schemaFormat !== "email_markdown") {
        requiredFixes.push(`Agent "${agent.name}" uses an email canvas and must declare outputContract.schema.format as "email_markdown".`);
      }
      if (/\b(html|html-friendly|alternate version|multiple versions|multiple representations)\b/i.test(requestedOutputText)) {
        requiredFixes.push(`Agent "${agent.name}" email output contract must not request HTML or alternate representations.`);
      }
    }

    if (agent.gate?.type === "source_confirmation" && agent.operatorSurface !== "review.sources") {
      requiredFixes.push(`Agent "${agent.name}" must use operatorSurface "review.sources" for source confirmation.`);
    }
    if (agent.gate?.type === "memory_confirmation" && agent.operatorSurface !== "review.memories") {
      requiredFixes.push(`Agent "${agent.name}" must use operatorSurface "review.memories" for memory confirmation.`);
    }
    if (agent.renderTarget === "canvas.email" && agent.operatorSurface !== "review.email") {
      requiredFixes.push(`Agent "${agent.name}" must use operatorSurface "review.email" with canvas.email.`);
    }
    if (agent.renderTarget === "canvas.preview" && agent.operatorSurface !== "review.preview" && agent.operatorSurface !== "confirm.send") {
      requiredFixes.push(`Agent "${agent.name}" uses read-only canvas.preview and must use operatorSurface "review.preview" or "confirm.send".`);
    }
    if (agent.operatorSurface === "review.sources" && agent.gate?.type !== "source_confirmation") {
      requiredFixes.push(`Agent "${agent.name}" uses operatorSurface "review.sources" and must use source_confirmation.`);
    }
    if (agent.operatorSurface === "review.memories" && agent.gate?.type !== "memory_confirmation") {
      requiredFixes.push(`Agent "${agent.name}" uses operatorSurface "review.memories" and must use memory_confirmation.`);
    }
    if (agent.operatorSurface === "review.email" && agent.renderTarget !== "canvas.email") {
      requiredFixes.push(`Agent "${agent.name}" uses operatorSurface "review.email" and must use renderTarget "canvas.email".`);
    }
    if ((agent.operatorSurface === "review.preview" || agent.operatorSurface === "confirm.send") && agent.renderTarget && agent.renderTarget !== "canvas.preview") {
      requiredFixes.push(`Agent "${agent.name}" uses operatorSurface "${agent.operatorSurface}" and must use renderTarget "canvas.preview" when a render target is declared.`);
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
    critiqueInputRequirements(design, noSlopSpec, requiredFixes, issues);
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
