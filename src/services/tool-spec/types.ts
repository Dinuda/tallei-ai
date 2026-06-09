import type { ConnectorActionRisk } from "../loop-engine/spec-contracts.js";

export interface ToolSpec {
  ref: string;
  label: string;
  provider: "internal" | "composio";
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
}

export interface ComposioActionSpec {
  slug: string;
  name: string;
  description: string;
  risk: ConnectorActionRisk;
  inputSchema?: Record<string, unknown>;
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
  useCases: ToolUseCase[];
  generatedAt: string;
}
