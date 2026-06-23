import type { NoSlopSpec } from "../contracts/spec-contracts.js";
import {
  selectedArtifactContract,
  selectedConnectorSelections,
  selectedConnectorAgentPlan,
  selectedLoopTrigger,
  type LoopBuildContract,
} from "../domain/build-contract.js";
import {
  catalogInputContract,
  deliveryOutputContract,
  evidenceOutputContract,
} from "../runtime/agent-contract-catalog.js";
import { reportLoopBuilderProgress } from "../utils/progress.js";
import { slugifyAgentId } from "../services/personas/agent-personas.js";
import type { AccessRef, PlanContext, PlanStep } from "./types.js";
import { normalizeToolRef } from "../../tool-spec/tool-contracts.js";

const GLOBAL_GUARDRAILS = [
  "Use finalizeAgent for structured step output.",
  "Mutating external actions require operator approval gates.",
];

const GLOBAL_FAILURE = "Pause for operator input when required runtime data is missing.";

export function buildConnectorPolicy(buildContract: LoopBuildContract, approvalModel?: string): NoSlopSpec["connectorPolicy"] {
  const allowedReadActions: NonNullable<NoSlopSpec["connectorPolicy"]>["allowedReadActions"] = [];
  const allowedWriteActions: NonNullable<NoSlopSpec["connectorPolicy"]>["allowedWriteActions"] = [];
  const planRoles = new Map<string, "read" | "draft" | "publish">();
  for (const parent of selectedConnectorAgentPlan(buildContract)?.parentAgents ?? []) {
    for (const subAgent of parent.subAgents) {
      for (const operation of subAgent.operations) {
        planRoles.set(operation.toolRef, operation.plannerRole);
      }
    }
  }

  for (const selection of selectedConnectorSelections(buildContract)) {
    for (const actionSlug of selection.actionSlugs) {
      const toolRef = `composio.${selection.toolkit}.action.${actionSlug}`;
      const plannerRole = planRoles.get(toolRef) ?? "publish";
      const isAutomatic = approvalModel?.toLowerCase().trim() === "automatic";
      const preSendApproval = plannerRole !== "read" && !isAutomatic;
      const policy = {
        toolkit: selection.toolkit,
        actionSlug,
        risk: plannerRole === "read" ? "read" as const : "send" as const,
        description: `Selected ${selection.toolkit} action ${actionSlug}.`,
        requiresPreSendApproval: preSendApproval,
      };
      if (plannerRole === "read") allowedReadActions.push(policy);
      else allowedWriteActions.push({ ...policy, requiresPreSendApproval: preSendApproval });
    }
  }

  return { allowedReadActions, allowedWriteActions };
}

export function atomicityIssues(spec: Pick<NoSlopSpec, "agents">): string[] {
  const issues: string[] = [];
  for (const agent of spec.agents) {
    const tools = agent.tools ?? [];
    const hasLlmOnly = tools.includes("internal.llm_only");
    const hasConnector = tools.some((tool) => tool.startsWith("composio."));
    if (hasLlmOnly && hasConnector) {
      issues.push(`${agent.name} mixes connector tools with internal.llm_only.`);
    }
  }
  return issues;
}

function bindingsFromAccess(access: AccessRef[]): NoSlopSpec["agents"][number]["handoffBindings"] {
  const bindings: NoSlopSpec["agents"][number]["handoffBindings"] = [];
  const seen = new Set<string>();

  for (const ref of access) {
    const paths = ref.paths?.length ? ref.paths : ["/"];
    for (const path of paths) {
      const key = `${ref.agentId}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const suffix = path === "/" ? "output" : path.replace(/^\//, "").replace(/\//g, "_");
      bindings.push({
        source: {
          kind: "agent_output",
          agentId: ref.agentId,
          path: "/",
        },
        targetPath: path === "/" ? `/from_${ref.agentId}` : `/${suffix}`,
        required: path === "/" || path === "/summary",
        provenance: "agent_output",
        transformation: "direct",
      });
    }
  }

  return bindings;
}

function baseIntent(ctx: PlanContext): string {
  return ctx.intentContext?.resolvedIntent?.trim() || ctx.purpose;
}

function structuredIntentSuffix(ctx: PlanContext): string {
  const normalized = ctx.intentContext?.analysis.normalizedIntent;
  if (!normalized) return "";
  const runtimeInputs = normalized.runtimeInputs.length > 0 ? normalized.runtimeInputs.join(", ") : "none";
  return ` Intent structure: outcome=${normalized.outcome}; approvalModel=${normalized.approvalModel}; runtimeInputs=${runtimeInputs}.`;
}

function withStructuredIntent(ctx: PlanContext, goal: string): string {
  return `${goal}${structuredIntentSuffix(ctx)}`;
}

function researcherGoal(ctx: PlanContext): string {
  const intent = ctx.intentContext?.resolvedIntent?.trim();
  const goal = intent
    ? `Gather grounded context needed for: ${intent}`
    : `Gather grounded context for: ${ctx.purpose}`;
  return withStructuredIntent(ctx, goal);
}

function writerGoal(ctx: PlanContext): string {
  const base = baseIntent(ctx);
  const goal = ctx.artifactStructure?.trim()
    ? `Draft the deliverable (${ctx.artifactStructure.trim()}) for: ${base}`
    : `Draft the deliverable for: ${base}`;
  return withStructuredIntent(ctx, goal);
}

function publisherGoal(ctx: PlanContext): string {
  return withStructuredIntent(ctx, `Deliver the approved output for: ${baseIntent(ctx)}`);
}

function approvalModelGuardrail(ctx: PlanContext): string | null {
  const model = ctx.intentContext?.analysis.normalizedIntent.approvalModel?.toLowerCase().trim();
  if (!model || model === "automatic") return null;
  if (model === "draft_review") return "Draft review required before publishing.";
  if (model === "full_approval") return "Operator approval required at every gate.";
  if (model === "operator_gate") return "Pause for operator input before each external mutation.";
  return null;
}

function runtimeInputsList(ctx: PlanContext): string[] {
  return ctx.intentContext?.analysis.normalizedIntent.runtimeInputs ?? [];
}

function coordinatorGoal(ctx: PlanContext): string {
  const trigger = selectedLoopTrigger(ctx.buildContract);
  const inputs = runtimeInputsList(ctx);
  const inputSuffix = inputs.length > 0
    ? ` Collect runtime inputs at run start: ${inputs.join(", ")}.`
    : "";
  if (trigger?.mode === "event") {
    return withStructuredIntent(ctx, `Coordinate each run started by ${trigger.toolkit}:${trigger.triggerSlug}.${inputSuffix}`);
  }
  if (trigger?.mode === "schedule") {
    return withStructuredIntent(ctx, `Coordinate each scheduled run at ${trigger.cron} (${trigger.timezone}).${inputSuffix}`);
  }
  return withStructuredIntent(ctx, `Coordinate each approved workflow run for: ${baseIntent(ctx)}${inputSuffix}`);
}

function classifierGoal(ctx: PlanContext): string {
  return withStructuredIntent(ctx, `Classify and route gathered work for: ${baseIntent(ctx)}`);
}

function plannerRoleForToolRef(ctx: PlanContext, ref: string): "read" | "draft" | "publish" {
  const tool = ctx.availableTools.find((entry) => normalizeToolRef(entry.toolRef) === normalizeToolRef(ref));
  if (tool?.plannerRole) return tool.plannerRole;
  if (tool?.effect === "read_external") return "read";
  return "publish";
}

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function needsClassification(ctx: PlanContext): boolean {
  const text = [
    ctx.purpose,
    ctx.intentContext?.resolvedIntent ?? "",
    ctx.intentContext?.analysis.normalizedIntent.outcome ?? "",
    ...(ctx.intentContext?.analysis.normalizedIntent.toolCategories ?? []),
    ...ctx.buildContract.requirements.flatMap((requirement) => [
      requirement.id,
      requirement.kind,
      requirement.question ?? "",
      requirement.reason ?? "",
      JSON.stringify(requirement.value ?? {}),
    ]),
  ].join(" ").toLowerCase();
  return includesAny(text, [
    /classif/,
    /\btriage\b/,
    /\bsort\b/,
    /\blabel\b/,
    /categor/,
    /\broute\b/,
  ]);
}

function addUnique(refs: string[], ref: string): void {
  if (!refs.includes(ref)) refs.push(ref);
}

function allocationIds(steps: PlanStep[]): Map<PlanStep["roleKey"], string> {
  return new Map(steps.map((step, index) => [step.roleKey, slugifyAgentId(step.name, index)]));
}

function connectorAgentPlanSteps(ctx: PlanContext): PlanStep[] {
  const plan = ctx.connectorAgentPlan;
  if (!plan || plan.parentAgents.length === 0) return [];
  const steps: PlanStep[] = [];
  const readRefs: string[] = [];
  const draftRefs: string[] = [];
  const publishRefs: string[] = [];
  const artifact = selectedArtifactContract(ctx.buildContract);
  const hasArtifact = Boolean(artifact && artifact.mode !== "none");

  for (const parent of plan.parentAgents) {
    const parentName = parent.name.trim() || "Connector Coordinator";
    if (!steps.some((step) => step.roleKey === "coordinator")) {
      steps.push({
        name: parentName,
        roleKey: "coordinator",
        toolDomain: "coordinate",
        allocationReason: "connector setup operation graph",
        goal: parent.goal,
        tools: [],
        access: [],
        guardrails: [parent.failurePolicy],
        doneWhen: parent.successCriteria.length > 0 ? parent.successCriteria : ["Connector parent goal is coordinated."],
      });
    }

    for (const subAgent of parent.subAgents) {
      for (const operation of subAgent.operations) {
        const bucket = plannerRoleForToolRef(ctx, operation.toolRef);
        if (bucket === "read") addUnique(readRefs, operation.toolRef);
        else if (bucket === "draft") addUnique(draftRefs, operation.toolRef);
        else addUnique(publishRefs, operation.toolRef);
      }
    }
  }

  if (hasArtifact && draftRefs.length === 0) addUnique(draftRefs, "internal.llm_only");

  if (readRefs.length > 0) {
    steps.push({
      name: "Researcher",
      roleKey: "researcher",
      toolDomain: "read",
      allocationReason: "connector setup read operations",
      goal: researcherGoal(ctx),
      tools: readRefs,
      access: [],
      guardrails: ["Gather connector context only; do not mutate external systems."],
      doneWhen: ["Grounded connector context is ready for downstream agents."],
    });
  }
  if (needsClassification(ctx)) {
    steps.push({
      name: "Classifier",
      roleKey: "classifier",
      toolDomain: "classify",
      allocationReason: "classification, triage, routing, or labeling language detected in build context",
      goal: classifierGoal(ctx),
      tools: ["internal.llm_only"],
      access: [],
      guardrails: ["Classify gathered work only; do not draft or deliver the final artifact."],
      doneWhen: ["Classification and routing decision is ready for downstream agents."],
    });
  }
  if (draftRefs.length > 0) {
    steps.push({
      name: "Writer",
      roleKey: "writer",
      toolDomain: "draft",
      allocationReason: "connector setup draft operations",
      goal: writerGoal(ctx),
      tools: draftRefs,
      access: [],
      guardrails: ["Prepare draft content only; external delivery belongs to the Publisher."],
      doneWhen: ["Draft output is ready for review or delivery."],
    });
  }
  if (publishRefs.length > 0) {
    steps.push({
      name: "Publisher",
      roleKey: "publisher",
      toolDomain: "deliver",
      allocationReason: "connector setup delivery operations",
      goal: publisherGoal(ctx),
      tools: publishRefs,
      access: [],
      guardrails: [
        "Do not mutate externally without operator approval gates.",
        ...(approvalModelGuardrail(ctx) ? [approvalModelGuardrail(ctx)!] : []),
      ],
      doneWhen: ["Approved output is delivered or an explicit no-action result is recorded."],
    });
  }

  const ids = allocationIds(steps);
  for (const step of steps) {
    if (step.roleKey === "researcher" && ids.has("coordinator")) {
      step.access = [{ agentId: ids.get("coordinator")!, paths: ["/run_context"] }];
    }
    if (step.roleKey === "writer") {
      if (ids.has("classifier")) step.access = [{ agentId: ids.get("classifier")!, paths: ["/classification"] }];
      else if (ids.has("researcher")) step.access = [{ agentId: ids.get("researcher")!, paths: ["/grounding"] }];
      else if (ids.has("coordinator")) step.access = [{ agentId: ids.get("coordinator")!, paths: ["/run_context"] }];
    }
    if (step.roleKey === "classifier" && ids.has("researcher")) {
      step.access = [{ agentId: ids.get("researcher")!, paths: ["/grounding"] }];
    }
    if (step.roleKey === "publisher") {
      if (ids.has("writer")) step.access = [{ agentId: ids.get("writer")!, paths: ["/draft_brief"] }];
      else if (ids.has("classifier")) step.access = [{ agentId: ids.get("classifier")!, paths: ["/classification"] }];
      else if (ids.has("researcher")) step.access = [{ agentId: ids.get("researcher")!, paths: ["/grounding"] }];
      else if (ids.has("coordinator")) step.access = [{ agentId: ids.get("coordinator")!, paths: ["/run_context"] }];
    }
  }

  return steps;
}

function planDeterministic(ctx: PlanContext): PlanStep[] {
  const connectorSteps = connectorAgentPlanSteps(ctx);
  if (connectorSteps.length > 0) {
    const artifact = selectedArtifactContract(ctx.buildContract);
    const hasArtifact = Boolean(artifact && artifact.mode !== "none");
    if (!hasArtifact) return connectorSteps;
    const lastConnector = connectorSteps[connectorSteps.length - 1]!;
    const lastConnectorId = slugifyAgentId(lastConnector.name, connectorSteps.length - 1);
    return [
      ...connectorSteps,
      {
        name: "Writer",
        roleKey: "writer",
        toolDomain: "draft",
        allocationReason: "artifact_contract requirement after connector agent setup",
        goal: writerGoal(ctx),
        tools: ["internal.llm_only"],
        access: [{ agentId: lastConnectorId, paths: ["/"] }],
        guardrails: ["Prepare draft content from connector handoff only; external delivery belongs to connector or Publisher agents."],
        doneWhen: ["Draft output is ready for review or delivery."],
      },
    ];
  }

  const readRefs: string[] = [];
  const draftRefs: string[] = [];
  const publishRefs: string[] = [];

  for (const ref of ctx.intakeRefs) addUnique(readRefs, ref);

  for (const ref of ctx.mutateRefs) {
    const plannerRole = plannerRoleForToolRef(ctx, ref);
    if (plannerRole === "draft") addUnique(draftRefs, ref);
    else if (plannerRole === "read") addUnique(readRefs, ref);
    else addUnique(publishRefs, ref);
  }

  const artifact = selectedArtifactContract(ctx.buildContract);
  const hasArtifact = Boolean(artifact && artifact.mode !== "none");
  if (hasArtifact && draftRefs.length === 0) addUnique(draftRefs, "internal.llm_only");

  const steps: PlanStep[] = [];
  if (selectedLoopTrigger(ctx.buildContract)) {
    steps.push({
      name: "Coordinator",
      roleKey: "coordinator",
      toolDomain: "coordinate",
      allocationReason: "trigger_schedule requirement",
      goal: coordinatorGoal(ctx),
      tools: [],
      access: [],
      guardrails: ["Start each run from the approved trigger context and stable configuration."],
      doneWhen: ["Run context is prepared for the next specialist."],
    });
  }

  if (readRefs.length > 0) {
    steps.push({
      name: "Researcher",
      roleKey: "researcher",
      toolDomain: "read",
      allocationReason: "connector and grounding read requirements",
      goal: researcherGoal(ctx),
      tools: readRefs,
      access: [],
      guardrails: ["Gather context only; do not produce or deliver the final artifact."],
      doneWhen: ["Grounded context is ready for downstream agents."],
    });
  }

  if (needsClassification(ctx)) {
    steps.push({
      name: "Classifier",
      roleKey: "classifier",
      toolDomain: "classify",
      allocationReason: "classification, triage, routing, or labeling language detected in build context",
      goal: classifierGoal(ctx),
      tools: ["internal.llm_only"],
      access: [],
      guardrails: ["Classify gathered work only; do not draft or deliver the final artifact."],
      doneWhen: ["Classification and routing decision is ready for downstream agents."],
    });
  }

  if (draftRefs.length > 0 || hasArtifact) {
    steps.push({
      name: "Writer",
      roleKey: "writer",
      toolDomain: "draft",
      allocationReason: hasArtifact ? "artifact_contract requirement" : "draft connector action",
      goal: writerGoal(ctx),
      tools: draftRefs,
      access: [],
      guardrails: ["Prepare draft content only; external delivery belongs to the Publisher."],
      doneWhen: ["Draft output is ready for review or delivery."],
    });
  }

  if (publishRefs.length > 0) {
    steps.push({
      name: "Publisher",
      roleKey: "publisher",
      toolDomain: "deliver",
      allocationReason: "send, post, publish, deliver, or destructive connector action",
      goal: publisherGoal(ctx),
      tools: publishRefs,
      access: [],
      guardrails: [
        "Do not mutate externally without operator approval gates.",
        ...(approvalModelGuardrail(ctx) ? [approvalModelGuardrail(ctx)!] : []),
      ],
      doneWhen: ["Approved output is delivered or an explicit no-action result is recorded."],
    });
  }

  const ids = allocationIds(steps);
  for (const step of steps) {
    if (step.roleKey === "researcher" && ids.has("coordinator")) {
      step.access = [{ agentId: ids.get("coordinator")!, paths: ["/run_context"] }];
    }
    if (step.roleKey === "classifier" && ids.has("researcher")) {
      step.access = [{ agentId: ids.get("researcher")!, paths: ["/grounding"] }];
    }
    if (step.roleKey === "writer") {
      if (ids.has("classifier")) step.access = [{ agentId: ids.get("classifier")!, paths: ["/classification"] }];
      else if (ids.has("researcher")) step.access = [{ agentId: ids.get("researcher")!, paths: ["/grounding"] }];
      else if (ids.has("coordinator")) step.access = [{ agentId: ids.get("coordinator")!, paths: ["/run_context"] }];
    }
    if (step.roleKey === "publisher") {
      if (ids.has("reviewer")) step.access = [{ agentId: ids.get("reviewer")!, paths: ["/reviewed_artifact"] }];
      else if (ids.has("writer")) step.access = [{ agentId: ids.get("writer")!, paths: ["/draft_brief"] }];
      else if (ids.has("classifier")) step.access = [{ agentId: ids.get("classifier")!, paths: ["/classification"] }];
      else if (ids.has("researcher")) step.access = [{ agentId: ids.get("researcher")!, paths: ["/grounding"] }];
      else if (ids.has("coordinator")) step.access = [{ agentId: ids.get("coordinator")!, paths: ["/run_context"] }];
    }
  }

  return steps.filter((step) => step.tools.length > 0 || step.roleKey === "coordinator");
}

export function compileAgentPlan(ctx: PlanContext, steps: PlanStep[]): NoSlopSpec["agents"] {
  return steps.map((step, index) => {
    const isFirst = index === 0;
    const isLast = index === steps.length - 1;
    const writerTemplateInput = step.roleKey === "writer" && ctx.artifactBundle != null
      ? " Approved artifact_template input is available as structured template data."
      : "";
    const outputContract = step.roleKey === "writer"
      ? ctx.outputContract
      : step.roleKey === "publisher"
        ? deliveryOutputContract()
        : isLast
          ? ctx.outputContract
          : evidenceOutputContract();
    return {
      name: step.name.trim(),
      roleKey: step.roleKey,
      toolDomain: step.toolDomain,
      ...(step.allocationReason ? { allocationReason: step.allocationReason } : {}),
      goal: step.goal.trim(),
      tools: step.tools,
      guardrails: step.guardrails?.length ? step.guardrails : GLOBAL_GUARDRAILS,
      doneWhen: step.doneWhen?.length ? step.doneWhen : [`${step.name} is complete.`],
      doneCriteria: step.doneWhen?.length ? step.doneWhen : [`${step.name} is complete.`],
      failureModes: [GLOBAL_FAILURE],
      inputContract: catalogInputContract(
        `${isFirst ? "Trigger payload, stable configuration, and connector reads." : "Outputs from agents listed in access."}${writerTemplateInput}`,
      ),
      outputContract,
      handoffBindings: bindingsFromAccess(step.access),
    };
  });
}

export async function planAgents(ctx: PlanContext): Promise<NoSlopSpec["agents"]> {
  reportLoopBuilderProgress({
    stage: "agent_spawn",
    message: "Compiling specialist agents…",
    status: "running",
  });

  return compileAgentPlan(ctx, planDeterministic(ctx));
}

/** @deprecated use planAgents */
