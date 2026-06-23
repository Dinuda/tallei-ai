export type WorkflowBuilderPhase =
  | "new"
  | "analyzing"
  | "needs_clarification"
  | "resolving_requirements"
  | "intent_resolved"
  | "spec_drafted"
  | "spec_approved"
  | "graph_generated"
  | "saved"
  | "archived"
  | "failed";

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
