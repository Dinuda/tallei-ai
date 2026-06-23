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

export type BuilderToolName =
  | "getAvailableTools"
  | "resolveBuildRequirement"
  | "refreshConnectorAvailability"
  | "saveLoop"
  | "runBuilderTest"
  | "runVerification"
  | "confirmActivation";
