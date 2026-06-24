import type { BuilderState } from "../contracts/builder-types.js";
import { unresolvedBuildRequirements } from "../domain/build-contract.js";
import type { WorkflowBuilderSession } from "../services/session.service.js";

export type BuilderActionName =
  | "assistantMessage"
  | "repairPrompt"
  | "intentClarification"
  | "saveApproval"
  | "activationApproval"
  | "resolveIntent"
  | "appSelection"
  | "getAvailableTools"
  | "resolveBuildRequirement"
  | "connectorSetup"
  | "scheduleSetup"
  | "knowledgeBaseSetup"
  | "renderType"
  | "artifactSetup"
  | "requirementSetup"
  | "previewAgentPlan"
  | "saveLoop"
  | "runBuilderTest"
  | "runVerification"
  | "confirmActivation";

export type BuilderActionKind = "server_action" | "client_action" | "assistant_message";

export type BuilderActionResult = {
  kind: BuilderActionKind;
  name: BuilderActionName;
  output?: Record<string, unknown>;
};

export function stateFromSession(session: WorkflowBuilderSession): BuilderState {
  if (session.error || session.builderState === "failed") return "failed";
  return session.builderState;
}

export function recoverBuilderState(session: WorkflowBuilderSession): BuilderState {
  if (session.error || session.builderState === "failed") return "failed";
  return session.builderState;
}

export function allowedActionsForState(state: BuilderState): BuilderActionName[] {
  switch (state) {
    case "intent.collecting":
      return ["intentClarification", "resolveIntent"];
    case "intent.resolving":
      return ["resolveIntent"];
    case "requirements.selecting_apps":
      return ["appSelection", "getAvailableTools"];
    case "requirements.discovering_tools":
      return ["getAvailableTools"];
    case "requirements.resolving":
      return [
        "resolveBuildRequirement",
        "connectorSetup",
        "scheduleSetup",
        "knowledgeBaseSetup",
        "renderType",
        "artifactSetup",
        "requirementSetup",
      ];
    case "compile.previewing":
      return ["previewAgentPlan"];
    case "compile.awaiting_approval":
      return ["saveApproval", "saveLoop"];
    case "verification.testing":
      return ["runBuilderTest", "runVerification"];
    case "verification.awaiting_activation":
      return ["activationApproval", "confirmActivation"];
    case "complete":
    case "failed":
      return [];
  }
}

export function reduceBuilderState(
  state: BuilderState,
  result: BuilderActionResult,
  session: WorkflowBuilderSession,
): BuilderState {
  if (result.kind === "assistant_message" || result.kind === "client_action") return state;
  switch (result.name) {
    case "resolveIntent":
      return "requirements.selecting_apps";
    case "getAvailableTools":
      return "requirements.resolving";
    case "resolveBuildRequirement":
      if (!session.buildContract) return "requirements.resolving";
      return unresolvedBuildRequirements(session.buildContract).length === 0
        ? "compile.previewing"
        : "requirements.resolving";
    case "previewAgentPlan":
      return "compile.awaiting_approval";
    case "saveLoop":
      return "verification.testing";
    case "runBuilderTest":
    case "runVerification":
      return "verification.awaiting_activation";
    case "confirmActivation":
      return "complete";
    default:
      return state;
  }
}
