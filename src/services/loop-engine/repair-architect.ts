import type { LoopArchitectOutput, NoSlopSpecSnapshot } from "./contracts.js";
import {
  connectorActionToolRef,
  getStaticToolContract,
  parseConnectorActionToolRef,
} from "../tool-spec/tool-contracts.js";

/**
 * Deterministic repairs for common architect LLM mistakes that the critic always rejects.
 * Does not rewrite agent goals or inject agents — only fixes tool/gate/delivery alignment.
 */
export function repairArchitectDesignForSpec(
  design: LoopArchitectOutput,
  noSlopSpec?: NoSlopSpecSnapshot,
): LoopArchitectOutput {
  if (!noSlopSpec) return design;

  const writeActions = noSlopSpec.specJson.connectorPolicy.allowedWriteActions ?? [];
  const approvedWriteRefs = new Set(writeActions.map((action) => connectorActionToolRef(action).toLowerCase()));
  const soleWriteRef = writeActions.length === 1 ? connectorActionToolRef(writeActions[0]!) : null;

  const agents = design.agents.map((agent) => {
    const contract = getStaticToolContract(agent.tool);
    let next = agent;

    if (next.gate?.type === "pre_send" && !contract?.approval.required) {
      next = {
        ...next,
        gate: { ...next.gate, type: "draft_review" },
      };
    }

    if (
      soleWriteRef
      && parseConnectorActionToolRef(agent.tool)
      && contract?.approval.required
      && !approvedWriteRefs.has(agent.tool.toLowerCase())
    ) {
      next = { ...next, tool: soleWriteRef };
    }

    return next;
  });

  let delivery = design.delivery;
  if (soleWriteRef && delivery.target !== "none") {
    const provider = delivery.provider.toLowerCase();
    if (delivery.provider === "none" || !approvedWriteRefs.has(provider)) {
      delivery = { ...delivery, provider: soleWriteRef };
    }
  }

  return { ...design, agents, delivery };
}
