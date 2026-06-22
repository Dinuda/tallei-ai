import { planningHintsForContract } from "../tool-spec/contract-planning-guidance.js";
import type { ToolContract } from "../tool-spec/types.js";

export type CompactPlannerContract = Pick<
  ToolContract,
  "toolRef" | "provider" | "name" | "description" | "effect" | "inputSchema" | "outputSchema" | "executionMode" | "approval"
> & {
  planningHints?: string[];
};

export function compactPlannerContracts(contracts: ToolContract[]): CompactPlannerContract[] {
  return contracts.map((contract) => ({
    toolRef: contract.toolRef,
    provider: contract.provider,
    name: contract.name,
    description: contract.description,
    effect: contract.effect,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    executionMode: contract.executionMode,
    approval: contract.approval,
    planningHints: planningHintsForContract(contract),
  }));
}
