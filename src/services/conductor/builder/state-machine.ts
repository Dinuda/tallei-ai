import type { BuilderState, WorkflowBuilderPhase } from "../contracts/builder-types.js";
import { unresolvedBuildRequirements } from "../domain/build-contract.js";
import type { WorkflowBuilderSession } from "../services/session.service.js";

export type BuilderActionName =
  | "assistantMessage"
  | "interactivePrompt"
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
  if (session.error || session.phase === "failed" || session.builderState === "failed") return "failed";
  if (session.builderState && session.builderState !== "intent.collecting") return session.builderState;
  if (session.phase === "saved") return "verification.testing";
  if (session.phase === "intent_resolved" || session.phase === "spec_drafted" || session.phase === "spec_approved") {
    return "compile.previewing";
  }
  if (session.phase === "resolving_requirements") {
    if (!session.buildContract) return "requirements.selecting_apps";
    const unresolved = unresolvedBuildRequirements(session.buildContract);
    if (unresolved.length === 0) return "compile.previewing";
    return session.discoveredToolContracts.length > 0 ? "requirements.resolving" : "requirements.selecting_apps";
  }
  return "intent.collecting";
}

export function legacyPhaseForState(state: BuilderState): WorkflowBuilderPhase | undefined {
  if (state === "failed") return "failed";
  if (state === "complete" || state === "verification.testing" || state === "verification.awaiting_activation") return "saved";
  if (state === "compile.previewing" || state === "compile.awaiting_approval") return "intent_resolved";
  if (state.startsWith("requirements.")) return "resolving_requirements";
  if (state === "intent.resolving") return "analyzing";
  if (state === "intent.collecting") return "new";
  return undefined;
}

export function allowedActionsForState(state: BuilderState): BuilderActionName[] {
  switch (state) {
    case "intent.collecting":
      return ["interactivePrompt", "resolveIntent"];
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
      return ["previewAgentPlan", "interactivePrompt"];
    case "compile.awaiting_approval":
      return ["saveLoop", "interactivePrompt"];
    case "verification.testing":
      return ["runBuilderTest", "runVerification", "interactivePrompt"];
    case "verification.awaiting_activation":
      return ["confirmActivation", "interactivePrompt"];
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
