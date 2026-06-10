import type { LoopDeliveryTarget } from "../loop-executor/types.js";
import { isDraftOnlyComposioAction } from "../connectors/composio.js";
import {
  buildPolicyActionContract,
  connectorActionToolRef,
  contractSupportsExternalWrite,
} from "../tool-spec/tool-contracts.js";

export function policyToolRef(policy: { toolkit: string; actionSlug: string }): string {
  return connectorActionToolRef(policy);
}

export function isApprovedExternalEffectPolicy(action: {
  toolkit: string;
  actionSlug: string;
  description?: string;
  risk: string;
}): boolean {
  const contract = buildPolicyActionContract(action);
  if (!contractSupportsExternalWrite(contract)) return false;
  if (isDraftOnlyComposioAction({
    toolkit: action.toolkit,
    actionSlug: action.actionSlug,
    name: action.actionSlug,
    description: action.description ?? "",
  })) return false;
  return contract.skillTags.some((tag) => tag === "send" || tag === "notify");
}

export function scoreConnectorPolicyForDelivery(
  action: {
    toolkit: string;
    actionSlug: string;
    description?: string;
    risk: string;
  },
  target: LoopDeliveryTarget,
): number {
  if (target === "none") return 0;
  const contract = buildPolicyActionContract(action);
  if (!contractSupportsExternalWrite(contract)) return 0;
  if (!contract.skillTags.some((tag) => tag === "send" || tag === "notify")) return 0;
  return [
    contract.source === "reviewed_override" ? 40 : 0,
    contract.resources.length > 0 ? 10 : 0,
    contract.renderRecommendations.length > 0 ? 5 : 0,
    contract.effect === "write_external" ? 20 : 5,
  ].reduce((sum, value) => sum + value, 0);
}
