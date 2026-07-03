/** Generic model-facing behavior for Conductor tools. Input shapes come from each tool's Zod schema. */

export const CONDUCTOR_TOOL_DESCRIPTIONS = {
  analyzeIntent:
    "Resolve the user's intended real-world outcome, start condition, approval preference, and execution order. Stay domain-neutral and non-technical. Do not choose apps, connectors, APIs, tools, bindings, or implementation details. Include the required outcome, trigger, executionOrder, approval, and decision fields defined by the tool schema. Output executionOrder as the ordered plain-language pipeline: each step has a role and description in execution order. Include every phase — if the flow revisits a source after a delivery step, list those steps in that sequence. Ask for input only when a material business choice remains unresolved. Treat externally visible or destructive actions as sensitive. Do not invent facts or configuration.",

  patchLoopSpec:
    "Apply the smallest partial update supported by the current confirmed state. Use only values established by intent analysis, explicit user choices, discovery output, or a compile blocker. Do not patch during intent clarification. Create the blueprint, agent, and approval configuration before connector selection. When patching taskBlueprint.outcomes, derive them from intentDiscovery.analysis.executionOrder in the same order when available. Do not reorder, bucket by role, or group all sources or destinations together. Add selected connectors only after user choice. Add bindings, actions, triggers, and output only from discovery results. Add confirmation only after the user accepts the current review. Never rewrite unchanged configuration.",

  discoverConnectorsForBlueprint:
    "Identify app choices required by unresolved non-transform blueprint outcomes. Run only after intent is ready and the blueprint exists. Return one pending choice group per distinct role. Do not change intent, choose an app for the user, discover action or trigger identifiers, or infer implementation mappings.",

  pickConnectorApp:
    "Present the server-ranked app picker for one unresolved blueprint outcome. Keep the question plain and outcome-focused. Never hand-build app options or expose connector, toolkit, API, binding, or role terminology to the user.",

  presentReplyOptions:
    "Present concise clickable replies for the current conversational choice. Labels and messages must be plain, outcome-focused, and free of internal build, connector, binding, trigger, API, or action terminology.",

  listTriggers:
    "List available event trigger definitions for the specified toolkit. Return discovered configuration without choosing on the user's behalf.",

  listActions:
    "List available action definitions for the specified toolkit. Return discovered configuration without inventing actions.",

  discoverBindings:
    "Rank concrete action bindings for the supplied outcomes within the selected toolkit. Return suggested bindings for the spec patch. Do not ask the user for API-level implementation details.",

  connectToolkit:
    "Start authorization for the specified toolkit and optional callback URL.",

  listWorkspaceConnectors:
    "List workspace apps and their connection status. Use connection status only as availability information; it is not user consent to select an app.",

  askQuestion:
    "Present the single highest-priority unresolved business question returned by intent analysis. Preserve its identifier and choices. Do not ask about connectors, toolkits, API details, fetch strategies, bindings, or implementation.",

  confirmOutcomeBrief:
    "Present confirmation controls for the current config-driven review card. Use the current confirmation hash from the system prompt. The review content is derived from LoopSpec by the UI; do not generate or duplicate plan summary fields. Options may confirm or request changes to outcome, trigger, connectors, approvals, or another user-specified area. Never expose the hash or internal configuration in user-visible text. After confirmation, patch the current hash before compilation.",

  compileLoop:
    "Compile the current confirmed specification into an immutable runnable plan. Do not compile an incomplete, changed, or unconfirmed specification.",

  testRunLoop:
    "Run a simulated smoke test for the compiled plan using the supplied scenario. Use the current compiled plan when no plan identifier is provided.",

  activateLoop:
    "Activate a compiled plan only after the same plan has a passing test run.",
} as const;
