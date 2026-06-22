import type { AuthContext } from "../../domain/auth/index.js";
import type { AnyLoopBuildContract, LoopBuildContract } from "../loop-engine/build-contract.js";
import type { LoopDefinition } from "../loop-executor/types.js";
import { expandSlimLoopDefinition, isSlimLoopDefinition } from "./definition-slim.js";
import { discoveredContractsFromDefinition } from "./spec-run-types.js";
import type { ToolContract } from "../tool-spec/types.js";

/** Canonical build contract lives on the persisted loop definition. */
export function resolveBuildContract(definition: LoopDefinition): LoopBuildContract | AnyLoopBuildContract | null {
  return definition.buildContract ?? null;
}

export function resolveDiscoveredToolContracts(definition: LoopDefinition): ToolContract[] {
  return discoveredContractsFromDefinition(definition);
}

/** Expand slim persisted shape in-memory; does not fetch builder sessions or loop_specs. */
export async function hydrateDefinitionForExecution(
  _auth: AuthContext,
  _workflowId: string,
  definition: LoopDefinition,
): Promise<LoopDefinition> {
  if (!isSlimLoopDefinition(definition)) return definition;
  return expandSlimLoopDefinition(definition);
}
