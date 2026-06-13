import type { ConnectorActionRisk } from "../loop-engine/spec-contracts.js";

export type ToolProvider = "internal" | "composio";
export type ToolSkillTag =
  | "search"
  | "retrieve"
  | "draft"
  | "summarize"
  | "transform"
  | "send"
  | "create"
  | "update"
  | "delete"
  | "schedule"
  | "notify"
  | "analyze";
export type ToolEffect = "none" | "read_external" | "write_external" | "irreversible_external";
export type ToolExecutionMode = "short_circuit" | "llm_assisted" | "approval_executed";
export type ToolContractSource = "static" | "composio_sdk" | "llm_contract" | "reviewed_override";
export type ToolRenderTarget = "canvas.email" | "canvas.preview";

export interface ToolRenderRecommendation {
  target: ToolRenderTarget;
  reason: string;
  strength: "weak" | "medium" | "strong";
}

export interface ToolContract {
  toolRef: string;
  provider: ToolProvider;
  name: string;
  description: string;
  skillTags: ToolSkillTag[];
  effect: ToolEffect;
  resources: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  executionMode: ToolExecutionMode;
  approval: {
    required: boolean;
    suggestedGate?: "memory_confirmation" | "source_confirmation" | "missing_input" | "draft_review" | "pre_send";
    reason?: string;
  };
  renderRecommendations: ToolRenderRecommendation[];
  constraints: Record<string, unknown>;
  source: ToolContractSource;
  readiness?: import("./action-readiness.js").ConnectorActionReadinessContract;
  semanticAnnotation?: Record<string, unknown>;
  /** Action-specific planner guidance attached when the contract is loaded. */
  planningHints?: string[];
}

export interface ToolSpec {
  ref: string;
  label: string;
  provider: ToolProvider;
  description: string;
  shortCircuits: boolean;
  outputDescription: string;
  outputSchema: Record<string, unknown>;
  handoffFormat: string;
  useCases: string[];
  limitations: string[];
  risk: "none" | ConnectorActionRisk;
  requiresConnector: boolean;
  requiresPreSendApproval: boolean;
  toolkit?: string;
  actions?: ComposioActionSpec[];
  contract?: ToolContract;
}

export interface ComposioActionSpec {
  slug: string;
  name: string;
  description: string;
  risk: ConnectorActionRisk;
  inputSchema?: Record<string, unknown>;
  contract?: ToolContract;
}

export interface ToolUseCase {
  name: string;
  description: string;
  requiredTools: string[];
  outcome: string;
  category: "research" | "communication" | "automation" | "data";
}

export interface ToolSpecRegistry {
  internalTools: ToolSpec[];
  composioToolkits: ToolSpec[];
  toolContracts: ToolContract[];
  useCases: ToolUseCase[];
  generatedAt: string;
}
