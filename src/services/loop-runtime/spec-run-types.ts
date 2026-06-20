import { z } from "zod";

import { loopBuildContractSchema } from "../loop-engine/build-contract.js";
import { noSlopSpecSnapshotSchema } from "../loop-engine/spec-contracts.js";
import {
  LOOP_DEFINITION_VERSION,
  LOOP_ENGINE_VERSION,
  loopDefinitionSchema,
  type LoopDefinition,
} from "../loop-executor/types.js";
import type { ToolContract } from "../tool-spec/types.js";
export type SpecRunDefinition = LoopDefinition;

function outputArtifactKind(renderer: unknown): string | undefined {
  if (renderer === "canvas.preview") return "canvas_preview";
  if (renderer === "canvas.email") return "canvas_email";
  if (typeof renderer === "string" && renderer.trim()) return "structured_output";
  return undefined;
}

function slugifyDefinitionId(name: string, index: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base || `agent_${index + 1}`;
}

type ArtifactTemplate = {
  id: string;
  name: string;
  templateId: string;
  subject: string;
  html: string;
  text?: string;
  reactEmailSource?: string;
};

export function definitionFromApprovedSpec(input: {
  snapshot: z.infer<typeof noSlopSpecSnapshotSchema>;
  buildContract?: z.infer<typeof loopBuildContractSchema>;
  discoveredToolContracts?: ToolContract[];
  artifacts?: {
    mode: string;
    templates: ArtifactTemplate[];
    structure?: string;
  };
  cron: string;
  timezone: string;
  workspaceId?: string | null;
  builderSessionId?: string;
}): LoopDefinition {
  const buildContract = input.buildContract ?? input.snapshot.buildContract ?? input.snapshot.specJson.buildContract;
  const noSlop = input.snapshot.specJson;
  return loopDefinitionSchema.parse({
    definitionVersion: LOOP_DEFINITION_VERSION,
    goal: input.snapshot.specJson.purpose,
    schedule: { cron: input.cron, timezone: input.timezone },
    schedulerTarget: "internal",
    allowedIntegrations: ["internal"],
    ceo: {
      name: "Tallei Orchestrator",
      task: `Coordinate the loop: ${input.snapshot.specJson.purpose}`,
      policy: noSlop.guardrails.length > 0
        ? noSlop.guardrails.join("\n")
        : "Run the configured agents in order and preserve declared approvals.",
    },
    draftPolicy: {
      requireDraftBeforeExternalAction: true,
      approvalRequiredFor: ["publish", "send", "external_action"],
    },
    deliveryType: noSlop.delivery.provider,
    delivery: noSlop.delivery.provider && noSlop.delivery.provider !== "none"
      ? { provider: noSlop.delivery.provider }
      : undefined,
    connectorPolicy: noSlop.connectorPolicy,
    inputRequirements: noSlop.inputRequirements,
    buildContract,
    engineVersion: LOOP_ENGINE_VERSION,
    agentGraph: {
      parent: {
        id: "orchestrator",
        name: "Tallei Orchestrator",
        task: `Coordinate agents for ${input.snapshot.title}.`,
        policy: noSlop.successCriteria.length > 0
          ? noSlop.successCriteria.join("\n")
          : "Complete the configured workflow.",
      },
      children: noSlop.agents.map((agent, index) => {
        const id = slugifyDefinitionId(agent.name, index);
        const outputArtifactKindValue = outputArtifactKind(agent.outputContract?.renderer);
        return {
          id,
          name: agent.name,
          nodeKind: agent.nodeKind,
          task: agent.goal,
          goal: agent.goal,
          tools: (agent.tools ?? []).map((ref) => ({ ref })),
          guardrails: agent.guardrails ?? [],
          failureModes: agent.failureModes ?? [],
          doneCriteria: agent.doneCriteria ?? agent.doneWhen ?? [],
          inputContract: agent.inputContract,
          outputContract: agent.outputContract,
          handoffBindings: agent.handoffBindings,
          gate: agent.gate,
          artifactRole: agent.artifactRole,
          outputArtifactId: `${id}_output`,
          ...(outputArtifactKindValue ? { outputArtifactKind: outputArtifactKindValue } : {}),
          persona: agent.persona,
        };
      }),
    },
    builderMeta: {
      designedBy: "loop_architect",
      engineVersion: LOOP_ENGINE_VERSION,
      preApproved: true,
      noSlopSpec: input.snapshot,
      discoveredToolContracts: input.discoveredToolContracts,
      ...(input.builderSessionId ? { workflowBuilderSessionId: input.builderSessionId } : {}),
    },
  });
}

export function parseLoopDefinition(metadata: unknown): LoopDefinition | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (record.loopDefinition) return loopDefinitionSchema.parse(record.loopDefinition);
  const direct = loopDefinitionSchema.safeParse(metadata);
  return direct.success ? direct.data : null;
}

export function parseLoopDefinitionSnapshot(snapshot: unknown): LoopDefinition | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const record = snapshot as Record<string, unknown>;
  if (record.loopDefinition) return loopDefinitionSchema.parse(record.loopDefinition);
  const direct = loopDefinitionSchema.safeParse(snapshot);
  if (direct.success) return direct.data;
  return null;
}

export function discoveredContractsFromDefinition(definition: LoopDefinition): ToolContract[] {
  return (definition.builderMeta?.discoveredToolContracts ?? [])
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
    .filter((value) => typeof value.toolRef === "string") as unknown as ToolContract[];
}
