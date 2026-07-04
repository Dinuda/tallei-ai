export const CONDUCTOR_TOOL_INPUT_EXAMPLES = {
  analyzeIntent: {
    outcome: "Complete the requested recurring outcome.",
    trigger: "When the configured condition occurs.",
    executionOrder: [
      { role: "trigger", description: "When the configured condition occurs." },
      { role: "transform", description: "Complete the requested recurring outcome." },
      { role: "destination", description: "Deliver the configured result." },
    ],
    questions: [{
      id: "confirm-outcome",
      question: "Does this outcome match what you want to achieve?",
      options: [
        { id: "yes", label: "Yes", value: "confirmed" },
        { id: "change", label: "Change it", value: "needs_changes" },
      ],
    }],
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
  discoverConnectorsForBlueprint: {
    outcomes: [{ id: "result", role: "destination", description: "Deliver the configured result." }],
  },
  pickConnectorApp: { outcomeId: "result", role: "destination" },
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
  },
  resolveBindings: {},
  connectToolkit: { toolkit: "example", callbackUrl: "https://example.test/callback" },
  listWorkspaceConnectors: {},
  confirmOutcomeBrief: {
    briefHash: "b".repeat(64),
    question: "Does this configuration look right?",
    options: [
      { id: "confirm", label: "Looks good", value: "confirm" },
      { id: "other", label: "Change it", value: "other" },
    ],
    allowOther: false,
  },
  compileLoop: {},
  testRunLoop: { scenario: { label: "Configured test scenario" } },
  activateLoop: { confirmedByUser: true },
} as const;
