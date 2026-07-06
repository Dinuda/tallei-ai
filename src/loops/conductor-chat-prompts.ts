/** Generic model-facing behavior for Conductor tools. Input shapes come from each tool's Zod schema. */

export const CONDUCTOR_TOOL_DESCRIPTIONS = {
  analyzeIntent:
    "You are the Intent Analyzer for a friendly automation builder. Turn the user's request into a decision-complete, platform-neutral automation plan. Define the measurable real-world outcome, the business event that starts it, and a complete executionOrder. Include every distinct stage in order: trigger, required information retrieval, transformations or decisions, review policy when relevant, and final delivery or action. Do not collapse distinct stages or invent implementation details. Write each step as a short verb-first action phrase. The first step must be the trigger. Never ask about or choose apps, platforms, providers, connectors, APIs, tools, integrations, databases, or webhooks; connector discovery owns all such choices. Return zero to four questions with unique IDs, only for unresolved business choices that materially change the plan, such as review policy, scope, escalation policy, or success criteria. Zero questions is correct when the request already determines the business behavior. Never add a generic confirmation or filler question. Treat externally visible or destructive actions as sensitive. Do not invent facts or configuration. Example: User wants email triage → executionOrder starts with a trigger step, includes classify/draft stages, ends with delivery; ask one question about review policy only—never ask which email app.",

  discoverConnectorsForBlueprint:
    "Identify app choices required by unresolved non-transform blueprint outcomes. Some outcomes may be auto-resolved by reusing an app the user already selected; narrate that reuse plainly and call pickConnectorApp only for remaining groups. If rejectedSelections is present, briefly explain that the selected app lacks the required event capability and present the replacement picker. Do not ask the same app question twice. Example: User already picked Gmail for receive → narrate reuse for send role; call pickConnectorApp only for the Slack delivery role.",

  pickConnectorApp:
    "Present the server-ranked app picker for one unresolved blueprint outcome. The server owns the question and options; do not author, repeat, or rephrase them. Never expose connector, toolkit, API, binding, or role terminology to the user. Example: Call with outcomeId from discovery output; let the UI show ranked app options—do not write \"Which connector toolkit?\" in plain text.",

  presentReplyOptions:
    "Present concise clickable replies for the current conversational choice. Labels and messages must be plain, outcome-focused, and free of internal build, connector, binding, trigger, API, or action terminology. Example: Activation chips labeled \"Yes, turn it on\" and \"Not yet\"—not \"Confirm activateLoop\" or \"Proceed to activation phase\".",

  listTriggers:
    "List available event trigger definitions for the specified toolkit. Return discovered configuration without choosing on the user's behalf. Example: Call listTriggers for gmail before resolveBindings when the workflow needs a new-email trigger.",

  listActions:
    "List available action definitions for the specified toolkit. Return discovered configuration without inventing actions. Example: Call listActions for slack when resolveBindings needs to bind a post-message action.",

  discoverBindings:
    "Discover and rank concrete action candidates within the selected toolkit. Supply only the toolkit; the server derives action outcomes from the current workflow. Never supply workflow descriptions, roles, action overrides, action slugs, or configuration. Example: Call discoverBindings with toolkit gmail only—the server maps outcomes; do not pass actionSlug or config fields.",

  resolveBindings:
    "Finalize all trigger and action bindings from server-owned discovery state and prior answers. Call with an empty object after listTriggers and discoverBindings have run for every selected app. If pendingQuestions are returned, reproduce each question exactly with askQuestion and then call resolveBindings again. Pending options are server-vetted for feasibility against the selected trigger; offer them verbatim and never substitute or invent action slugs—the server rejects infeasible selections. Never construct, copy, rename, or invent provider field names, configuration objects, trigger slugs, action slugs, or overrides. Call resolveBindings before any binding askQuestion; never author binding questions or option values yourself. Example: resolveBindings returns pendingQuestions about channel → askQuestion copies question text exactly → resolveBindings again with empty object.",

  connectToolkit:
    "Start authorization for the specified toolkit and optional callback URL. Example: After listWorkspaceConnectors shows Gmail disconnected, call connectToolkit for gmail—do not ask the user to repeat OAuth steps already in progress.",

  listWorkspaceConnectors:
    "List workspace apps and their connection status. Use connection status only as availability information; it is not user consent to select an app. Example: Gmail connected + Slack disconnected → tell user Slack needs authorization; do not treat Gmail's connected status as the user choosing Gmail for this workflow.",

  askQuestion:
    "Present one plain business question. During intent, preserve the analyzer's wording and choices. During bindings, call resolveBindings first; only present pendingQuestions returned by resolveBindings, copied exactly. Option descriptions may include server-provided binding context; present them verbatim and do not re-author them. Never author binding questions, option values, or provider configuration. Example: Valid—\"Should drafts be sent automatically or held for your review?\" Forbidden—\"Do you want to use Gmail?\" or \"Yes/No: confirm Slack as output app?\"",

  presentAgentTeam:
    "Present the specialist team roster for the current workflow review. Group adjacent blueprint outcomes that form one coherent responsibility into a single persona; keep trigger outcomes in their own groups. Preserve execution order and include every outcome id exactly once across groups. Prefer a small coherent team over one persona per event. Never group outcomes across an approval boundary; processing stays before review and sensitive delivery stays after review. Each group's outcomeIds are that persona's workflow tools in order. Suggest roleTitle and ownershipSummary as clear verb-first phrases derived only from the grouped outcomes. The server validates coverage, adjacency, ordering, and approval boundaries, derives reviewer placement from the approval policy, and falls back to one persona per outcome when grouping is invalid. Call this immediately before confirmOutcomeBrief. Do not change the underlying workflow, bindings, or runtime configuration. Example: Group read+classify outcomes into one analyst persona; keep approval and send as separate personas—never merge processing steps with post-approval delivery.",

  confirmOutcomeBrief:
    "Present exactly two confirmation controls after presentAgentTeam: confirm (accept and build) and other (request changes). Use the current confirmation hash from the system prompt. Do not generate or duplicate review content—the roster is already shown. Option id and value must be the action tokens confirm and other only—never add category-specific change buttons. Set allowOther to false. Put user-facing wording in label only. Never expose the hash or internal configuration in user-visible text. The server persists the answer automatically; never ask for a second confirmation. Example: Two buttons only—\"Looks good, build it\" (confirm) and \"I'd like changes\" (other)—never add \"Change apps\" or \"Change trigger\" buttons.",

  compileLoop:
    "Compile the current confirmed specification into an immutable runnable plan. Do not compile an incomplete or unconfirmed specification. When compile fails because review is incomplete, the server returns recoverToPhase review—call presentAgentTeam then confirmOutcomeBrief in the same thread before retrying compileLoop. When compile fails on technical metadata, rerun the relevant discovery tool; the server records validated corrections automatically. Example: Review not confirmed → recover to presentAgentTeam + confirmOutcomeBrief; missing trigger binding → listTriggers then resolveBindings, not a user-facing apology only.",

  testRunLoop:
    "Run a simulated smoke test for the compiled plan using the supplied scenario. Use the current compiled plan when no plan identifier is provided. Example: After compileLoop succeeds, call testRunLoop with a realistic scenario label before offering activation.",

  activateLoop:
    "Activate a compiled plan only after the same plan has a passing test run. Example: User says \"turn it on\" → presentReplyOptions for explicit approval → activateLoop only when testRunLoop has passed.",
} as const;
