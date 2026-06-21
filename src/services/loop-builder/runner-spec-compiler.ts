import type { DataContract } from "../loop-engine/data-contract.js";
import {
  selectedArtifactContract,
  selectedConnectorActionSlugs,
  selectedExternalDataToolkits,
  selectedGroundingSources,
  selectedLoopTrigger,
  selectedReviewPolicy,
  selectedStableInputs,
  type LoopBuildContract,
} from "../loop-engine/build-contract.js";
import type { InputRequirement } from "../loop-engine/input-surfaces.js";
import type { LoopIntentContext } from "../loop-engine/intent-context.js";
import type { NoSlopSpec, NoSlopSpecAgent } from "../loop-engine/spec-contracts.js";
import { noSlopSpecDraftSchema } from "../loop-engine/spec-contracts.js";
import { parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";
import type { ToolContract } from "../tool-spec/types.js";
import { slugifyAgentId } from "./agent-personas.js";
import { availableToolsForSpecDraft, type SpecAvailableTool } from "./spec-available-tools.js";
import { operatorReviewRequired } from "../loop-runtime/spec-run-gate-policy.js";

export type CompileRunnerSpecInput = {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
  feedback?: string;
};

function contractActionSlug(contract: ToolContract): string {
  const configured = contract.constraints.actionSlug;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return contract.toolRef.split(".").pop() ?? contract.name;
}

function isSendLike(tool: SpecAvailableTool): boolean {
  if (tool.effect === "irreversible_external") return true;
  const text = `${tool.toolRef} ${tool.name} ${tool.description}`.toLowerCase();
  return /\bsend|sent|publish|post\b/.test(text) || tool.effect === "write_external" && /\bsend|publish|post\b/.test(text);
}

function selectedToolContracts(
  buildContract: LoopBuildContract,
  discoveredToolContracts: ToolContract[],
): ToolContract[] {
  const selectedSlugs = new Set(selectedConnectorActionSlugs(buildContract).map((slug) => slug.toUpperCase()));
  if (selectedSlugs.size === 0) return [];
  return discoveredToolContracts.filter((contract) => {
    if (contract.provider !== "composio") return false;
    return selectedSlugs.has(contractActionSlug(contract).toUpperCase());
  });
}

function evidenceOutputContract(): DataContract {
  return {
    description: "Structured evidence and context for downstream agents.",
    representation: "json",
    mediaType: "application/json",
    visibility: "internal",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ticket_found", "no_tickets_found"] },
        summary: { type: "string" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        ticket: {
          type: "object",
          properties: {
            subject: { type: "string" },
            body: { type: "string" },
            threadId: { type: "string" },
            messageId: { type: "string" },
          },
          required: ["subject", "body"],
          additionalProperties: true,
        },
        customer: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
          additionalProperties: true,
        },
        findings: { type: "array", items: { type: "string" } },
        context: { type: "object", additionalProperties: true },
      },
      required: ["summary", "status"],
      allOf: [{
        if: {
          properties: { status: { const: "ticket_found" } },
          required: ["status"],
        },
        then: { required: ["ticket"] },
      }],
      additionalProperties: true,
    },
  };
}

function draftOutputContract(renderer: "canvas.email" | "canvas.preview"): DataContract {
  if (renderer === "canvas.email") {
    return {
      description: "Operator-reviewable email draft matching the approved artifact contract, or an explicit no-action status when there is no support ticket to draft for.",
      representation: "json",
      mediaType: "application/json",
      visibility: "operator",
      renderer: "canvas.email",
      schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["draft_ready", "no_action_required"] },
          subject: { type: "string" },
          body: { type: "string" },
          html: { type: "string" },
          summary: { type: "string" },
        },
        required: ["status"],
        additionalProperties: false,
      },
    };
  }
  return {
    description: "Operator-reviewable preview artifact, or an explicit no-action status when there is nothing actionable to preview.",
    representation: "json",
    mediaType: "application/json",
    visibility: "operator",
    renderer: "canvas.preview",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["preview_ready", "no_action_required"] },
        title: { type: "string" },
        body: { type: "string" },
        summary: { type: "string" },
      },
      required: ["status"],
      additionalProperties: true,
    },
  };
}

function deliveryOutputContract(): DataContract {
  return {
    description: "Delivery package ready for operator approval.",
    representation: "json",
    mediaType: "application/json",
    visibility: "operator",
    schema: {
      type: "object",
      properties: {
        ready: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["ready", "summary"],
      additionalProperties: true,
    },
  };
}

function defaultInputContract(description: string): NoSlopSpecAgent["inputContract"] {
  return {
    description,
    schema: { type: "object", properties: {}, additionalProperties: true },
  };
}

function handoffFromAgent(agentId: string, targetPath = "/"): NoSlopSpecAgent["handoffBindings"][number] {
  return {
    source: { kind: "agent_output", agentId, path: "/" },
    targetPath,
    required: true,
    valuePolicy: "derivable",
    provenance: "agent_output",
    transformation: "direct",
  };
}

function resolveDraftRenderer(
  buildContract: LoopBuildContract,
  contracts: ToolContract[],
): "canvas.email" | "canvas.preview" {
  const artifact = selectedArtifactContract(buildContract);
  if (artifact?.mode === "supplied_template" && artifact.templates.length > 0) return "canvas.email";
  for (const contract of contracts) {
    if (contract.renderRecommendations.some((entry) => entry.target === "canvas.email" && entry.strength !== "weak")) {
      return "canvas.email";
    }
  }
  for (const contract of contracts) {
    if (contract.renderRecommendations.some((entry) => entry.target === "canvas.preview")) {
      return "canvas.preview";
    }
  }
  return "canvas.email";
}

function deriveInputRequirements(input: {
  buildContract: LoopBuildContract;
  draftRenderer: "canvas.email" | "canvas.preview" | null;
  hasSendTools: boolean;
  reviewPolicy: ReturnType<typeof selectedReviewPolicy>;
}): InputRequirement[] {
  const requirements: InputRequirement[] = [];
  for (const [name, value] of Object.entries(selectedStableInputs(input.buildContract))) {
    requirements.push({
      key: name,
      surface: "input.text",
      label: name.replace(/_/g, " "),
      required: true,
      when: "run_start",
      description: value,
    });
  }
  const grounding = selectedGroundingSources(input.buildContract);
  if (grounding.some((source) => source.type === "tallei_memory" || source.type === "workspace_memory")) {
    requirements.push({
      key: "source_review",
      surface: "review.sources",
      label: "Review sources",
      required: true,
      when: "before_step",
    });
  }
  if (input.draftRenderer === "canvas.email" && operatorReviewRequired(input.reviewPolicy)) {
    requirements.push({
      key: "draft_review",
      surface: "review.email",
      label: "Review email draft",
      required: true,
      when: "before_send",
    });
  } else if (input.draftRenderer === "canvas.preview" && operatorReviewRequired(input.reviewPolicy)) {
    requirements.push({
      key: "draft_review",
      surface: "review.preview",
      label: "Review preview",
      required: true,
      when: "before_send",
    });
  }
  if (input.hasSendTools && input.reviewPolicy !== "draft_only") {
    requirements.push({
      key: "confirm_send",
      surface: "confirm.send",
      label: "Confirm send",
      required: true,
      when: "before_send",
    });
  }
  return requirements;
}

function scheduleDescription(buildContract: LoopBuildContract): { description: string; cron?: string; timezone?: string } {
  const trigger = selectedLoopTrigger(buildContract);
  if (trigger?.mode === "schedule") {
    return {
      description: `Approved schedule: ${trigger.cron} (${trigger.timezone})`,
      cron: trigger.cron,
      timezone: trigger.timezone,
    };
  }
  if (trigger?.mode === "event") {
    return { description: `Event-triggered via ${trigger.toolkit}:${trigger.triggerSlug}` };
  }
  return { description: "Runs on the approved trigger." };
}

function deliveryFromTools(sendTools: SpecAvailableTool[]): NoSlopSpec["delivery"] {
  const sendTool = sendTools[0];
  if (!sendTool) {
    return { provider: "none", description: "Dashboard only; no outbound delivery." };
  }
  const parsed = parseConnectorActionToolRef(sendTool.toolRef);
  const provider = parsed?.toolkit ?? sendTool.toolRef.replace(/^composio\.([^.]+)\.action\..+$/i, "$1");
  return {
    provider,
    description: `Deliver through ${sendTool.name}.`,
  };
}

export function compileRunnerSpecFromBuildContract(input: CompileRunnerSpecInput): NoSlopSpec {
  const buildContract = input.buildContract;
  const availableTools = availableToolsForSpecDraft(buildContract, input.discoveredToolContracts ?? []);
  const contracts = selectedToolContracts(buildContract, input.discoveredToolContracts ?? []);
  const reviewPolicy = selectedReviewPolicy(buildContract);
  const requiresOperatorReview = operatorReviewRequired(reviewPolicy);
  const artifact = selectedArtifactContract(buildContract);
  const groundingSources = selectedGroundingSources(buildContract);
  const externalSearchToolkits = selectedExternalDataToolkits(buildContract);

  const readTools = availableTools.filter((tool) => tool.effect === "read_external");
  const writeTools = availableTools.filter((tool) =>
    tool.effect === "write_external" || tool.effect === "irreversible_external");
  const sendTools = reviewPolicy === "draft_only"
    ? []
    : writeTools.filter((tool) => isSendLike(tool));
  const draftTools = writeTools.filter((tool) => !sendTools.includes(tool));

  const searchTools: string[] = [];
  if (groundingSources.some((source) => source.type === "tallei_memory" || source.type === "workspace_memory")) {
    searchTools.push("internal.memory_search");
  }
  for (const toolkit of externalSearchToolkits) {
    const ref = `composio.${toolkit}.search`;
    if (!searchTools.includes(ref)) searchTools.push(ref);
  }

  const intakeToolRefs = [...new Set([
    ...readTools.map((tool) => tool.toolRef),
    ...searchTools,
  ])];
  const productionToolRefs = draftTools.length > 0
    ? draftTools.map((tool) => tool.toolRef)
    : (writeTools.length === 0 ? ["internal.llm_only"] : []);
  const deliveryToolRefs = sendTools.map((tool) => tool.toolRef);

  const purposeBase = input.intentContext?.resolvedIntent?.trim() || input.prompt.trim();
  const purpose = input.feedback?.trim()
    ? `${purposeBase}\n\nRefinement: ${input.feedback.trim()}`
    : purposeBase;

  const agents: NoSlopSpecAgent[] = [];
  const agentIds: string[] = [];
  const draftRenderer = productionToolRefs.some((ref) => ref !== "internal.llm_only")
    || artifact?.mode === "supplied_template"
    || artifact?.mode === "approved_generated_structure"
    ? resolveDraftRenderer(buildContract, contracts)
    : null;

  if (intakeToolRefs.length > 0) {
    const name = "Context Specialist";
    const agentId = slugifyAgentId(name, agents.length);
    agentIds.push(agentId);
    agents.push({
      name,
      goal: "Gather trigger context, search connected sources, and produce structured evidence for downstream agents.",
      tools: intakeToolRefs,
      guardrails: ["Use only approved read and search tools.", "Do not draft or send outbound messages."],
      doneWhen: ["Structured evidence is ready for the next agent."],
      doneCriteria: ["Evidence matches the intake output contract."],
      failureModes: ["Pause for operator input when required context is missing."],
      inputContract: defaultInputContract("Trigger payload and stable configuration."),
      outputContract: evidenceOutputContract(),
      handoffBindings: [],
      artifactRole: "source_evidence",
    });
  }

  const needsProduction = productionToolRefs.length > 0
    && !(productionToolRefs.length === 1 && productionToolRefs[0] === "internal.llm_only" && agents.length === 0);
  const includeProduction = needsProduction
    || draftRenderer !== null
    || (agents.length > 0 && writeTools.length > 0);

  if (includeProduction) {
    const name = draftRenderer === "canvas.email" ? "Draft Specialist" : "Production Specialist";
    const agentId = slugifyAgentId(name, agents.length);
    const priorAgentId = agentIds.at(-1);
    agentIds.push(agentId);
    agents.push({
      name,
      goal: artifact?.structure?.trim()
        ? `Produce the approved artifact: ${artifact.structure.trim()}`
        : "Produce the operator-reviewable draft defined by the output contract.",
      tools: productionToolRefs.filter((ref) => ref !== "internal.llm_only").length > 0
        ? productionToolRefs
        : ["internal.llm_only"],
      guardrails: ["Use finalizeAgent output that matches the declared output contract.", "Do not send or publish directly unless this agent owns delivery tools."],
      doneWhen: ["Draft output matches the declared contract, or status is no_action_required when upstream evidence has no actionable item."],
      doneCriteria: ["Output is ready for operator review or downstream delivery, unless status is no_action_required."],
      failureModes: ["Pause when required upstream evidence is missing."],
      inputContract: defaultInputContract(priorAgentId ? "Evidence from the prior agent." : "Trigger payload and stable configuration."),
      outputContract: draftOutputContract(draftRenderer ?? "canvas.preview"),
      handoffBindings: priorAgentId ? [handoffFromAgent(priorAgentId)] : [],
      ...(draftRenderer ? {
        ...(requiresOperatorReview ? {
          gate: {
            type: draftRenderer === "canvas.email" ? "draft_review" : "preview_review",
            question: draftRenderer === "canvas.email"
              ? "Review the email draft before continuing."
              : "Review the preview before continuing.",
          },
        } : {}),
        artifactRole: "draft_body" as const,
      } : {}),
    });
  }

  if (deliveryToolRefs.length > 0) {
    const name = "Delivery Specialist";
    const agentId = slugifyAgentId(name, agents.length);
    const priorAgentId = agentIds.at(-1);
    agentIds.push(agentId);
    agents.push({
      name,
      goal: "Deliver the operator-approved draft from upstream. Request confirmation only for external send actions — draft review already happened at the prior agent gate.",
      tools: deliveryToolRefs,
      guardrails: ["Never send without operator confirmation.", "Use requestApproval for mutating external actions."],
      doneWhen: ["Delivery package is ready for operator confirmation."],
      doneCriteria: ["Delivery output matches the declared contract."],
      failureModes: ["Pause when upstream draft or approval is missing."],
      inputContract: defaultInputContract(priorAgentId ? "Approved draft from the prior agent." : "Trigger payload and stable configuration."),
      outputContract: deliveryOutputContract(),
      handoffBindings: priorAgentId ? [handoffFromAgent(priorAgentId)] : [],
      artifactRole: "delivery",
      ...(requiresOperatorReview && reviewPolicy === "approve_each_action" ? {
        gate: {
          type: "pre_send",
          question: "Confirm delivery before sending.",
        },
      } : {}),
    });
  }

  if (agents.length === 0) {
    agents.push({
      name: "Loop Specialist",
      goal: purpose,
      tools: ["internal.llm_only"],
      guardrails: ["Follow the approved build contract."],
      doneWhen: ["The configured outcome is complete."],
      doneCriteria: ["Output matches the declared contract."],
      failureModes: ["Pause for operator input when required context is missing."],
      inputContract: defaultInputContract("Trigger payload and stable configuration."),
      outputContract: evidenceOutputContract(),
      handoffBindings: [],
    });
  }

  const schedule = scheduleDescription(buildContract);
  const outcome = input.intentContext?.analysis.normalizedIntent.outcome ?? purpose;

  return noSlopSpecDraftSchema.parse({
    purpose,
    agents,
    guardrails: [
      "Use finalizeAgent for structured step output; do not narrate tool calls in prose.",
      "Mutating external actions require operator approval gates.",
    ],
    successCriteria: [outcome],
    failureModes: [
      "Pause for operator input when required context is missing.",
      "Do not proceed after a failed connector probe or missing approval.",
    ],
    schedule,
    delivery: deliveryFromTools(sendTools),
    connectorPolicy: {
      allowedReadActions: [],
      allowedWriteActions: [],
    },
    inputRequirements: deriveInputRequirements({
      buildContract,
      draftRenderer,
      hasSendTools: deliveryToolRefs.length > 0,
      reviewPolicy,
    }),
    buildContract,
  });
}
