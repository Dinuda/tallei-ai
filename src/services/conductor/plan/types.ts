import type { LoopBuildContract } from "../domain/build-contract.js";
import type { LoopIntentContext } from "../contracts/intent-context.js";
import type { AgentPersonaRoleKey, NoSlopSpec } from "../contracts/spec-contracts.js";
import type { SpecAvailableTool } from "../services/discovery.service.js";
import type { ConnectorAgentPlan } from "../contracts/connector-setup.js";
import type { ToolContract } from "../../tool-spec/types.js";

export type AccessRef = { agentId: string; paths?: string[] };
export type AgentToolDomain = "read" | "write" | "classify" | "draft" | "deliver" | "coordinate" | "review";

export type PlanStep = {
  name: string;
  roleKey: AgentPersonaRoleKey;
  toolDomain: AgentToolDomain;
  allocationReason?: string;
  goal: string;
  tools: string[];
  access: AccessRef[];
  guardrails?: string[];
  doneWhen?: string[];
};

export type PlanContext = {
  purpose: string;
  intentContext?: LoopIntentContext;
  buildContract: LoopBuildContract;
  discoveredToolContracts?: ToolContract[];
  availableTools: SpecAvailableTool[];
  intakeRefs: string[];
  mutateRefs: string[];
  connectorAgentPlan?: ConnectorAgentPlan | null;
  artifactStructure?: string;
  artifactBundle?: unknown;
  outputContract: NonNullable<NoSlopSpec["agents"][number]["outputContract"]>;
};
