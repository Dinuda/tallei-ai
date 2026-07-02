/** Tool descriptions and model-facing copy for Conductor chat (loops POST /:loopId/chat). */

import { CONDUCTOR_TOOL_INPUT_EXAMPLES } from "./conductor-tools.js";

function inlineJson(value: unknown): string {
  return JSON.stringify(value);
}

export const CONDUCTOR_TOOL_DESCRIPTIONS = {
  analyzeIntent:
  `You are the Intent Analyzer for a friendly automation builder. Understand the user’s intent in plain, non-technical terms. Focus only on the final real-world outcome, when it should run, and whether approval or review is needed before the automation takes action. Do not ask about connectors, apps, APIs, tools, integrations, databases, webhooks, or implementation details. Return only valid JSON matching this schema example: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.analyzeIntent)}. Always include outcome, trigger, and decisions. Min 1 question when approval/autonomy is unclear. The outcome should describe what must eventually happen in the real world, not just an intermediate step. For example, if the user says "draft replies and send the email", the outcome is "Customer gets a reply sent to their query"; the draft/review step is an approval decision, not the final outcome. Ask a question when the automation may take action on the user's behalf and approval behavior is unclear. Sensitive actions include send, delete, approve, reject, cancel, pay, post, publish, archive, modify records, and contact people. For sensitive actions, clarify whether the agent should act automatically, and send results to end consumers. Canonical approval mapping: review before sending or draft-then-send => {"mode":"mixed","sensitiveRoles":["destination"],"sensitiveCapabilities":[]}; send automatically => {"mode":"auto","sensitiveRoles":[],"sensitiveCapabilities":[]}; ask before every action => {"mode":"ask","sensitiveRoles":[],"sensitiveCapabilities":[]}. If the user says "incoming", "new", or "automatically", infer an event-based trigger when reasonable. If the user gives a schedule like "every morning", "weekly", or "on Fridays", use that as the trigger. If the user says "draft", infer review is expected unless they also clearly say to send automatically. If the user clearly says "send automatically without review", do not ask about approval. If the user clearly says "save as draft", "review before sending", or "ask me before sending", do not ask about approval. If timing is missing, set trigger to "unspecified"; do not ask about timing from this prompt unless approval is already clear and timing is the only blocker your schema requires. Do not invent details the user did not provide. Decisions must match the schema example: each one needs questionId, question, and answer.`,
  
  patchLoopSpec:
  `You update the loop spec with confirmed configuration changes. Your job is not to decide what the user wants, ask questions, or discover connectors, actions, triggers, or bindings. Return only a valid partial spec patch object. Common valid shapes are: initial blueprint ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.initialBlueprint)}, connector choice ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.connectorChoice)}, trigger and bindings ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.triggerAndBindings)}, confirmation ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.confirmation)}. Only write values confirmed by ready intent analysis, interactive user choice, discovery tool output, or a specific compile blocker. Do not patch while intent is still being clarified. Patch narrowly and never rewrite unchanged data. For the initial blueprint patch, include taskBlueprint, agent, and approval only. Do not patch connector fields during the initial blueprint patch. Patch selectedConnector only after the user picks an app. Patch bindings, actions, triggers, and output only from discovery results. Patch confirmation only after the user confirms the outcome brief. Preserve existing correct fields and prefer the smallest safe patch.`,

  discoverConnectorsForBlueprint:
  `Run only after intent is ready and taskBlueprint has been patched. Call this tool with JSON matching this shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverConnectorsForBlueprint)}. Read the confirmed taskBlueprint and identify which app choices are needed to run it. Do not decide the user's outcome, trigger, scope, approval behavior, or success criteria. Do not ask intent questions. Do not discover bindings, action slugs, trigger slugs, input mappings, or output mappings. Return one pending app-choice group per distinct role that still needs a user selection. Never auto-select a connected app.`,

  pickConnectorApp:
  `Present a user-visible app picker for one outcomeId and role after discoverConnectorsForBlueprint. Call this tool with JSON matching this shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.pickConnectorApp)}. The question must be plain and outcome-focused. Do not say connector, integration, toolkit, API, source, binding, role, or app connector to the user. Always show the server-ranked picker and never hand-build app lists.`,

  presentReplyOptions:
  `Show clickable quick-reply chips when asking the user to confirm a next step or answer a yes/no choice. Call this tool with JSON matching this shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.presentReplyOptions)}. Keep the labels and messages plain, friendly, and outcome-focused. Do not mention compile, test, activate, connector, binding, trigger, API, action slug, or internal system steps.`,

  listTriggers: `List available Composio event triggers for a toolkit. Input shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.listTriggers)}.`,

  listActions: `List available Composio actions for a toolkit used in binding resolution. Input shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.listActions)}.`,

  discoverBindings:
    `Search Composio and rank exact action bindings for inferred outcomes. Call this tool with JSON matching this shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverBindings)}. Returns suggestedBindings for patchLoopSpec. Never ask about fetch/list API details.`,

  connectToolkit: `Start OAuth for a toolkit that is not connected yet. Input shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.connectToolkit)}.`,

  listWorkspaceConnectors:
    `List the apps available in the current workspace and whether each one is connected. Input shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.listWorkspaceConnectors)}. Use this to refresh connection status after OAuth; never treat a connected app as the user's app selection.`,

  askQuestion:
    `Ask the one highest-priority unresolved intent question returned by analyzeIntent. Call this tool with JSON matching this shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.askQuestion)}. Use questionId, question, and option objects exactly as provided. Forbidden: connector choices, Composio slugs, fetch strategies, or API implementation details.`,

  reviewOutcomeBrief:
    `Build the authoritative outcome brief after intent, connectors, bindings, trigger, output, approvals, and guardrails are resolved. Input shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.reviewOutcomeBrief)}. Returns technical brief plus userSummary for the confirmation UI. Then call confirmOutcomeBrief with the resulting briefHash.`,

  confirmOutcomeBrief:
    `Show the user a simple confirmation card before the loop is built or turned on. Call this tool with JSON matching this shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.confirmOutcomeBrief)}. Use the briefHash from reviewOutcomeBrief, but do not mention hashes, internal fields, compile steps, or technical setup to the user. Each option value must be one of: confirm, change_outcome, change_trigger, change_connectors, change_approvals, other. If the user confirms, patch intentDiscovery.status=confirmed and confirmedBriefHash with the exact current briefHash before compiling.`,

  compileLoop:
    `Freeze the current spec and compile it into a runnable plan. Input shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.compileLoop)}. Call when the user confirms they are ready and compile blockers are resolved.`,

  testRunLoop:
    `Run a fast simulated smoke test against the compiled plan before activation. Call this tool with JSON matching this shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.testRunLoop)}. Pass only compiledPlanId (optional) and scenario.`,

  activateLoop:
    `Activate a compiled plan. Input shape: ${inlineJson(CONDUCTOR_TOOL_INPUT_EXAMPLES.activateLoop)}. Compile freezes the plan; activate provisions Composio webhooks and schedules. Requires a prior passing testRunLoop on the same plan.`,
} as const;
