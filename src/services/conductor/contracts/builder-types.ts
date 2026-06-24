export type BuilderState =
  | "intent.collecting"
  | "intent.resolving"
  | "requirements.selecting_apps"
  | "requirements.discovering_tools"
  | "requirements.resolving"
  | "compile.previewing"
  | "compile.awaiting_approval"
  | "verification.testing"
  | "verification.awaiting_activation"
  | "complete"
  | "failed";

export type BuilderToolName =
  | "resolveIntent"
  | "getAvailableTools"
  | "resolveBuildRequirement"
  | "refreshConnectorAvailability"
  | "previewAgentPlan"
  | "saveLoop"
  | "runBuilderTest"
  | "runVerification"
  | "confirmActivation";
