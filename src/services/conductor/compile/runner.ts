import {
  noSlopSpecDraftSchema,
  type NoSlopSpec,
} from "../contracts/spec-contracts.js";
import type { LoopIntentContext } from "../contracts/intent-context.js";
import type { LoopBuildContract } from "../domain/build-contract.js";
import { buildPlanContext } from "../plan/connector-tools.js";
import { planAgents } from "../plan/spec-compiler.js";
import type { PlanContext } from "../plan/types.js";
import { assembleSpec } from "./assemble.js";
import type { ToolContract } from "../../tool-spec/types.js";

function buildContext(input: {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
  artifactBundle?: unknown;
}): PlanContext {
  const buckets = buildPlanContext(input);
  return {
    ...buckets,
    intentContext: input.intentContext,
    buildContract: input.buildContract,
    discoveredToolContracts: input.discoveredToolContracts ?? [],
    artifactBundle: input.artifactBundle,
  };
}

function normalizeSpec(spec: NoSlopSpec): NoSlopSpec {
  return noSlopSpecDraftSchema.parse({
    ...spec,
    delivery: {
      ...spec.delivery,
      provider: spec.delivery.provider?.trim() || "none",
    },
    schedule: {
      ...spec.schedule,
      ...(spec.schedule.timezone?.trim() ? { timezone: spec.schedule.timezone.trim() } : {}),
    },
    inputRequirements: spec.inputRequirements ?? [],
    connectorPolicy: spec.connectorPolicy ?? { allowedReadActions: [], allowedWriteActions: [] },
  });
}

export async function buildRunnerSpecFromBuildContract(input: {
  prompt: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
  artifactBundle?: unknown;
}): Promise<NoSlopSpec> {
  const ctx = buildContext(input);
  const agents = await planAgents(ctx);
  if (agents.length === 0) {
    throw new Error(
      "Could not plan agents: resolve connector read and write tools in the build contract first.",
    );
  }
  return normalizeSpec(assembleSpec(ctx, agents, input.intentContext));
}
