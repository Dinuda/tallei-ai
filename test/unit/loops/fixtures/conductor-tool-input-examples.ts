export const CONDUCTOR_TOOL_INPUT_EXAMPLES = {
  analyzeIntent: {
    outcome: "Complete the requested recurring outcome.",
    trigger: "When the configured condition occurs.",
    executionOrder: [
      { role: "trigger", description: "When the configured condition occurs." },
      { role: "transform", description: "Complete the requested recurring outcome." },
      { role: "destination", description: "Deliver the configured result." },
    ],
    approval: { mode: "mixed", sensitiveRoles: ["destination"], sensitiveCapabilities: [] },
    decisions: [{ questionId: "approval", question: "When should approval be required?", answer: "Before sensitive actions" }],
  },
  askQuestion: {
    questionId: "preference",
    question: "Which behavior do you prefer?",
    options: [
      { id: "first", label: "First option", value: "first" },
      { id: "second", label: "Second option", value: "second" },
    ],
  },
  patchLoopSpec: {
    initialBlueprint: {
      taskBlueprint: {
        version: 1,
        summary: "Complete a configured outcome.",
        outcomes: [{ id: "result", role: "destination", description: "Deliver the configured result.", status: "pending" }],
      },
      agent: { instructions: "Complete the configured outcome." },
      approval: { mode: "mixed", sensitiveRoles: ["destination"], sensitiveCapabilities: [] },
    },
    connectorChoice: {
      taskBlueprint: {
        version: 1,
        summary: "Complete a configured outcome.",
        outcomes: [{ id: "result", role: "destination", description: "Deliver the configured result.", selectedConnector: "example", status: "chosen" }],
      },
    },
    triggerAndBindings: {
      trigger: { kind: "manual" },
      bindings: [{ capability: "records.read", connector: "example", role: "source" }],
      output: { kind: "none" },
    },
    confirmation: { intentDiscovery: { status: "confirmed", confirmedBriefHash: "a".repeat(64) } },
  },
  discoverConnectorsForBlueprint: {
    outcomes: [{ id: "result", role: "destination", description: "Deliver the configured result." }],
  },
  pickConnectorApp: { outcomeId: "result", role: "destination", question: "Which app should deliver the result?" },
  presentReplyOptions: {
    options: [
      { id: "continue", label: "Continue", message: "Continue." },
      { id: "change", label: "Change", message: "Make a change." },
    ],
  },
  presentAgentTeam: {
    groups: [
      { outcomeIds: ["trigger"], ownershipSummary: "Starts when a new message arrives" },
      { outcomeIds: ["transform"], ownershipSummary: "Processes the incoming request" },
      { outcomeIds: ["result"] },
    ],
    reviewerBeforeSpecialistIndex: 1,
  },
  listTriggers: { toolkit: "example" },
  listActions: { toolkit: "example" },
  discoverBindings: {
    toolkit: "example",
    outcomes: [{ id: "result", description: "Deliver the configured result.", role: "destination" }],
  },
  connectToolkit: { toolkit: "example", callbackUrl: "https://example.test/callback" },
  listWorkspaceConnectors: {},
  confirmOutcomeBrief: {
    briefHash: "b".repeat(64),
    question: "Does this configuration look right?",
    options: [
      { id: "confirm", label: "Looks good", value: "confirm" },
      { id: "other", label: "Change it", value: "other" },
    ],
  },
  compileLoop: {},
  testRunLoop: { scenario: { label: "Configured test scenario" } },
  activateLoop: {},
} as const;
