/**
 * ceo-designer.ts — Re-exports the agentic loop architect (preset-free design pipeline).
 */

export {
  designLoopFromIntent,
  channelsFromDesign,
  loopBuilderTraceSchema,
  type DesignLoopInput,
  type LoopBuilderTrace,
} from "../loop-engine/architect.js";

export type { DesignerTestOverrides } from "../loop-engine/architect.js";

/** @deprecated Legacy type alias — architect output shape changed in loop_engine_v3. */
export type CeoDesignOutput = import("../loop-engine/contracts.js").LoopArchitectOutput & {
  agentGraph: import("../loop-executor/types.js").LoopAgentGraph;
};

/** @deprecated Removed in loop_engine_v3 — delivery is LLM-chosen via definition.delivery. */
export type LoopDeliveryClassification = {
  deliveryType: "newsletter" | "plain" | "none";
  deliveryTarget: "subscriber_list" | "team_email" | "operator" | "none";
};

/** @deprecated Use WorkflowCriticResult from loop-engine/contracts. */
export type WorkflowCriticResult = import("../loop-engine/contracts.js").WorkflowCriticResult;

export type FinalizedLoopDesign = CeoDesignOutput & {
  designDiagnostics?: Record<string, unknown>;
  trace?: import("../loop-engine/architect.js").LoopBuilderTrace;
};
