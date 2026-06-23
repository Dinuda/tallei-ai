import { randomUUID } from "crypto";

import type { AuthContext } from "../../../domain/auth/index.js";
import { reportLoopBuilderProgress } from "../utils/progress.js";
import { enrichSpecAgentsWithPersonas } from "./personas/enrichment.js";
import {
  noSlopSpecDraftSchema,
  noSlopSpecSnapshotSchema,
  type NoSlopSpec,
  type NoSlopSpecSnapshot,
} from "../contracts/spec-contracts.js";
import { loopIntentContextSchema, type LoopIntentContext } from "../contracts/intent-context.js";
import {
  loopBuildContractSchema,
  selectedArtifactContract,
  selectedExternalDataToolkits,
  selectedGroundingSources,
  selectedLoopTrigger,
  selectedStableInputs,
  type LoopBuildContract,
} from "../domain/build-contract.js";
import { normalizeProviderIdentity } from "../domain/spec-required-connectors.js";
import { listComposioToolkits } from "../../connectors/composio.js";
import { availableToolsForSpecDraft } from "./discovery.service.js";
import type { ToolContract } from "../../tool-spec/types.js";
import { parseConnectorActionToolRef } from "../../tool-spec/tool-contracts.js";
import {
  catalogInputContract,
  draftOutputContract,
} from "../runtime/agent-contract-catalog.js";
import { upsertApprovedLoopSpecRow } from "../data/spec.repository.js";
import {
  buildConductorAgents,
} from "./conductor.service.js";
import { inferActionLabelsFromToolRefs, slugifyAgentId } from "./personas/agent-personas.js";

function reportPlannedConductorAgents(agents: NoSlopSpec["agents"]): void {
  for (const [index, agent] of agents.entries()) {
    reportLoopBuilderProgress({
      stage: "agent_spawn",
      message: `Assigning ${agent.name}…`,
      status: "running",
      details: {
        agentIndex: index,
        agentId: slugifyAgentId(agent.name, index),
        agentName: agent.name,
        goal: agent.goal,
        inferredActions: inferActionLabelsFromToolRefs(agent.tools ?? []),
      },
    });
  }
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "loop-spec";
}

function titleFromPurpose(purpose: string): string {
  const normalized = purpose.trim().replace(/\s+/g, " ");
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized || "Loop spec";
}

export function renderSpecMarkdown(spec: NoSlopSpec): string {
  const lines = [
    `# ${titleFromPurpose(spec.purpose)}`,
    "",
    "## Purpose",
    spec.purpose,
    "",
    "## Agents",
  ];

  for (const agent of spec.agents) {
    lines.push("", `### ${agent.name}`, `- Goal: ${agent.goal}`);
    if (agent.tools.length > 0) {
      lines.push(`- Tools: ${agent.tools.join(", ")}`);
    }
    for (const guardrail of agent.guardrails) lines.push(`- Guardrail: ${guardrail}`);
    for (const done of agent.doneWhen) lines.push(`- Done when: ${done}`);
    for (const failure of agent.failureModes) lines.push(`- Failure mode: ${failure}`);
  }

  lines.push("", "## Guardrails");
  for (const guardrail of spec.guardrails.length ? spec.guardrails : ["No additional global guardrails."]) {
    lines.push(`- ${guardrail}`);
  }

  lines.push("", "## Success Criteria");
  for (const criterion of spec.successCriteria.length ? spec.successCriteria : ["The loop produces the requested reviewed artifact."]) {
    lines.push(`- ${criterion}`);
  }

  lines.push("", "## Failure Modes");
  for (const failure of spec.failureModes.length ? spec.failureModes : ["If required input is missing, pause for operator input."]) {
    lines.push(`- ${failure}`);
  }

  lines.push("", "## Delivery");
  if (spec.delivery.provider === "none") {
    lines.push("Dashboard only — no outbound delivery.");
  } else {
    lines.push(`Provider: ${spec.delivery.provider}`);
    lines.push(`Description: ${spec.delivery.description}`);
  }

  if (spec.delivery.provider !== "none") {
    lines.push("", "## Connector Policy");
    lines.push("- Runtime actions are bound from the approved Connected Apps configuration.");
    lines.push("- Mutating delivery actions require the configured operator approval before execution.");
  }

  if (spec.buildContract) {
    lines.push("", "## Approved Build Contract");
    for (const requirement of spec.buildContract.requirements) {
      lines.push(`- ${requirement.kind}: ${requirement.status}${requirement.provenance ? ` (${requirement.provenance.source})` : ""}`);
      for (const warning of requirement.warnings) lines.push(`- Warning: ${warning}`);
    }
    const groundingSources = selectedGroundingSources(spec.buildContract);
    const externalToolkits = selectedExternalDataToolkits(spec.buildContract);
    if (groundingSources.length > 0 || externalToolkits.length > 0) {
      lines.push("", "## Grounding Sources");
      for (const source of groundingSources) {
        if (source.type === "tallei_memory") lines.push("- Tallei internal memory");
        else if (source.type === "workspace_memory") lines.push("- Workspace memory (includes inter-loop history)");
        else if (source.type === "knowledge_base") lines.push(`- Knowledge base: ${source.id}`);
        else if (source.type === "google_doc") lines.push(`- Google Doc knowledge base: ${source.id}`);
      }
      for (const toolkit of externalToolkits) {
        lines.push(`- External product/user data: composio.${toolkit}.search`);
      }
    }
  }

  return lines.join("\n");
}

export async function compileEnrichedRuntimeSpecSnapshot(input: {
  auth: AuthContext;
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
}): Promise<NoSlopSpecSnapshot> {
  const snapshot = await compileRuntimeSpecSnapshotAsync({
    prompt: input.prompt,
    intentContext: input.intentContext,
    buildContract: input.buildContract,
    discoveredToolContracts: input.discoveredToolContracts,
  });
  const enrichedSpecJson = await enrichSpecAgentsWithPersonas({
    auth: input.auth,
    specId: snapshot.id,
    specJson: snapshot.specJson,
  });
  return noSlopSpecSnapshotSchema.parse({
    ...snapshot,
    bodyMarkdown: renderSpecMarkdown(enrichedSpecJson),
    specJson: enrichedSpecJson,
  });
}

export async function persistApprovedLoopSpecSnapshot(
  auth: AuthContext,
  snapshot: NoSlopSpecSnapshot,
): Promise<void> {
  const parsed = noSlopSpecSnapshotSchema.parse(snapshot);
  const sourcePrompt = parsed.intentContext?.resolvedIntent?.trim()
    || parsed.specJson.purpose.trim()
    || parsed.title;
  await upsertApprovedLoopSpecRow(auth, parsed, sourcePrompt);
}

export async function compileRuntimeSpecSnapshotAsync(input: {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
}): Promise<NoSlopSpecSnapshot> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const intentContext = input.intentContext ? loopIntentContextSchema.parse(input.intentContext) : undefined;
  const buildContract = loopBuildContractSchema.parse(input.buildContract);
  reportLoopBuilderProgress({
    stage: "agent_spawn",
    message: "Building runtime agent contract from approved configuration…",
    status: "running",
  });
  const specJson = normalizeGeneratedSpec(await buildRunnerSpecFromBuildContract({
    prompt,
    intentContext,
    buildContract,
    discoveredToolContracts: input.discoveredToolContracts ?? [],
  }));
  reportPlannedConductorAgents(specJson.agents);
  const title = titleFromPurpose(specJson.purpose);
  return noSlopSpecSnapshotSchema.parse({
    id: randomUUID(),
    slug: `${slugify(title)}-${Date.now().toString(36)}`,
    version: 1,
    title,
    bodyMarkdown: renderSpecMarkdown(specJson),
    specJson,
    ...(intentContext ? { intentContext } : {}),
    buildContract,
    approvedAt: new Date().toISOString(),
  });
}

export function specSemanticIssues(spec: NoSlopSpec, expectedProvider = ""): string[] {
  const expectedIdentity = normalizeProviderIdentity(expectedProvider);
  if (!expectedIdentity || normalizeProviderIdentity(spec.delivery.provider) === expectedIdentity) return [];
  return [
    `delivery.provider must preserve the explicitly requested available provider ${expectedProvider}; received ${spec.delivery.provider}.`,
  ];
}

function deriveInputRequirements(buildContract: LoopBuildContract): NoSlopSpec["inputRequirements"] {
  const requirements: NoSlopSpec["inputRequirements"] = [];
  for (const [name, value] of Object.entries(selectedStableInputs(buildContract))) {
    requirements.push({
      key: name,
      surface: "input.text",
      label: name.replace(/_/g, " "),
      required: true,
      when: "run_start",
      description: value,
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

function deliveryFromTools(sendTools: ReturnType<typeof availableToolsForSpecDraft>): NoSlopSpec["delivery"] {
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

function buildConductorInput(input: {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
}) {
  const buildContract = input.buildContract;
  const availableTools = availableToolsForSpecDraft(buildContract, input.discoveredToolContracts ?? []);
  const artifact = selectedArtifactContract(buildContract);
  const groundingSources = selectedGroundingSources(buildContract);
  const externalSearchToolkits = selectedExternalDataToolkits(buildContract);
  const connectorTools = availableTools.filter((tool) => !tool.toolRef.startsWith("internal."));
  const intakeTools = connectorTools.filter((tool) => tool.effect === "read_external");
  const mutatingTools = connectorTools.filter((tool) => tool.effect === "write_external" || tool.effect === "irreversible_external");
  const searchTools: string[] = [];
  if (groundingSources.some((source) => source.type === "tallei_memory" || source.type === "workspace_memory")) {
    searchTools.push("internal.memory_search");
  }
  for (const toolkit of externalSearchToolkits) {
    const ref = `composio.${toolkit}.search`;
    if (!searchTools.includes(ref)) searchTools.push(ref);
  }
  const intakeToolRefs = [...new Set([...intakeTools.map((tool) => tool.toolRef), ...searchTools])];
  const mutatingToolRefs = mutatingTools.map((tool) => tool.toolRef);
  const renderer = artifact?.mode === "supplied_template" ? "canvas.email" as const : "canvas.preview" as const;
  const outputContract = artifact
    ? draftOutputContract(renderer)
    : {
        description: "Structured workflow result.",
        representation: "json" as const,
        mediaType: "application/json" as const,
        visibility: "operator" as const,
        schema: {
          type: "object",
          properties: {
            status: { type: "string" },
            summary: { type: "string" },
          },
          required: ["summary"],
          additionalProperties: true,
        },
      };
  return {
    prompt: input.prompt,
    intentContext: input.intentContext,
    buildContract,
    availableTools,
    intakeToolRefs,
    mutatingToolRefs,
    artifactStructure: artifact?.structure,
    outputContract,
    renderer,
  };
}

function requireConductorAgents(agents: NoSlopSpec["agents"]): NoSlopSpec["agents"] {
  if (agents.length > 0) return agents;
  throw new Error(
    "Conductor could not decompose this workflow. Resolve connector read and write tools in the build contract before compiling.",
  );
}

function assembleSpecFromAgents(input: {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
  agents: NoSlopSpec["agents"];
}): NoSlopSpec {
  const buildContract = input.buildContract;
  const availableTools = availableToolsForSpecDraft(buildContract, input.discoveredToolContracts ?? []);
  const purpose = input.intentContext?.resolvedIntent?.trim() || input.prompt.trim();
  const schedule = scheduleDescription(buildContract);
  const outcome = input.intentContext?.analysis.normalizedIntent.outcome ?? purpose;

  return noSlopSpecDraftSchema.parse({
    purpose,
    agents: input.agents,
    guardrails: [
      "Use finalizeAgent for structured step output; do not narrate tool calls in prose.",
      "Mutating external actions require operator approval gates.",
    ],
    successCriteria: input.agents.flatMap((agent) => agent.doneWhen).length > 0
      ? input.agents.flatMap((agent) => agent.doneWhen)
      : [outcome],
    failureModes: [
      "Pause for operator input when required context is missing.",
      "Do not proceed after a failed connector probe or missing approval.",
    ],
    schedule,
    delivery: deliveryFromTools(availableTools.filter((tool) =>
      tool.effect === "write_external" || tool.effect === "irreversible_external",
    )),
    connectorPolicy: {
      allowedReadActions: [],
      allowedWriteActions: [],
    },
    inputRequirements: deriveInputRequirements(buildContract),
  });
}

export async function buildRunnerSpecFromBuildContract(input: {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
}): Promise<NoSlopSpec> {
  const conductorInput = buildConductorInput(input);
  const agents = requireConductorAgents(await buildConductorAgents(conductorInput));
  return assembleSpecFromAgents({ ...input, agents });
}

function normalizeGeneratedSpec(input: NoSlopSpec): NoSlopSpec {
  const provider = input.delivery.provider?.trim() || "none";
  const connectorPolicy = input.connectorPolicy ?? undefined;

  return noSlopSpecDraftSchema.parse({
    ...input,
    schedule: {
      ...input.schedule,
      ...(input.schedule.timezone?.trim() ? { timezone: input.schedule.timezone.trim() } : {}),
    },
    delivery: {
      ...input.delivery,
      provider,
    },
    successCriteria: input.successCriteria,
    failureModes: input.failureModes,
    inputRequirements: input.inputRequirements ?? [],
    connectorPolicy,
  });
}
