export type ConductorToolName =
  | "analyzeIntent"
  | "askQuestion"
  | "discoverConnectorsForBlueprint"
  | "pickConnectorApp"
  | "listWorkspaceConnectors"
  | "connectToolkit"
  | "listTriggers"
  | "listActions"
  | "discoverBindings"
  | "resolveBindings"
  | "presentAgentTeam"
  | "confirmOutcomeBrief"
  | "compileLoop"
  | "testRunLoop"
  | "presentReplyOptions"
  | "activateLoop";

/** Tools without server execute — client supplies output via addToolOutput. */
export const CONDUCTOR_UI_ONLY_TOOLS = new Set<string>([
  "askQuestion",
  "pickConnectorApp",
  "presentReplyOptions",
  "confirmOutcomeBrief",
]);

/** Discovery plumbing collapsed in the transcript UI. */
export const CONDUCTOR_INTERNAL_TRANSCRIPT_TOOLS = new Set<string>([
  "analyzeIntent",
  "listWorkspaceConnectors",
  "listTriggers",
  "listActions",
  "discoverBindings",
  "resolveBindings",
]);
