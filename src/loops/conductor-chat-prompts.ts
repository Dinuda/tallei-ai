/** Generic model-facing behavior for Conductor tools. Input shapes come from each tool's Zod schema. */

export const CONDUCTOR_TOOL_DESCRIPTIONS = {
  analyzeIntent:
    "You are the Intent Analyzer for a friendly automation builder. Understand the user’s intent in plain, non-technical terms. Focus only on the final real-world outcome, when it should run, and whether approval or review is needed before the automation takes action. Do not ask about connectors, apps, APIs, tools, integrations, databases, webhooks, or implementation details. Include the required outcome, trigger,executionOrder, questions, approval, and decision fields defined by the tool schema. Output executionOrder as the ordered plain-language pipeline: each step has a role and description in execution order. Write each step description as a short verb-first action phrase (e.g. \"Drafts personalized reply\", \"Sends reply to customer\"). Never use noun job titles like \"Reply Sender\" or awkward compounds. For workflows that deliver a reply to a person, the destination step must say \"Sends reply to customer\". Include every phase — if the flow revisits a source after a delivery step, list those steps in that sequence. Return at least one and at most four queued questions with unique IDs. Return exactly one question by default; include additional  questions only for independent, material business choices that cannot be inferred from the user's request.   Never fill the queue merely because four slots are available. If you have no questions,   ask one outcome-focused confirmation question. Treat externally visible or destructive actions as sensitive.   Do not invent facts or configuration. ",

  discoverConnectorsForBlueprint:
    "Identify app choices required by unresolved non-transform blueprint outcomes. Some outcomes may be auto-resolved by reusing an app the user already selected; narrate that reuse plainly and call pickConnectorApp only for remaining groups. Do not ask the same app question twice.",

  pickConnectorApp:
    "Present the server-ranked app picker for one unresolved blueprint outcome. Keep the question plain and outcome-focused. Never hand-build app options or expose connector, toolkit, API, binding, or role terminology to the user.",

  presentReplyOptions:
    "Present concise clickable replies for the current conversational choice. Labels and messages must be plain, outcome-focused, and free of internal build, connector, binding, trigger, API, or action terminology.",

  listTriggers:
    "List available event trigger definitions for the specified toolkit. Return discovered configuration without choosing on the user's behalf.",

  listActions:
    "List available action definitions for the specified toolkit. Return discovered configuration without inventing actions.",

  discoverBindings:
    "Rank concrete action bindings for the supplied outcomes within the selected toolkit. After trigger discovery, if the chosen trigger exposes a meaningful configurable scope, ask exactly one plain business question with askQuestion and then call setBindingConfig. Skip configuration when no meaningful field exists.",

  setBindingConfig:
    "Save the validated answer to the current trigger's single business-facing configuration question. Use only fields returned by trigger discovery and never expose provider IDs or raw schema details.",

  connectToolkit:
    "Start authorization for the specified toolkit and optional callback URL.",

  listWorkspaceConnectors:
    "List workspace apps and their connection status. Use connection status only as availability information; it is not user consent to select an app.",

  askQuestion:
    "Present one plain business question. During intent, preserve the analyzer's wording and choices. During bindings, use it only for the single meaningful trigger scope question returned by discovery; never expose schema keys, provider IDs, or API terminology.",

  presentAgentTeam:
    "Present the specialist team roster for the current workflow review. Group adjacent blueprint outcomes that form one coherent responsibility into a single persona; keep trigger outcomes in their own groups. Preserve execution order and include every outcome id exactly once across groups. Prefer a small coherent team over one persona per event. Never group outcomes across an approval boundary—drafting stays before review and sensitive sending or delivery stays after review. Each group's outcomeIds are that persona's workflow tools in order. Suggest roleTitle and ownershipSummary as verb-first action phrases that describe what the persona does (e.g. \"Drafts personalized reply\", \"Sends reply to customer\"). Never use noun job titles like \"Reply Sender\" or \"Delivery Specialist\". For workflows that deliver a reply to a person, roleTitle and ownershipSummary must say \"Sends reply to customer\". The server validates coverage, adjacency, ordering, and approval boundaries, derives reviewer placement from the approval policy, and falls back to one persona per outcome when grouping is invalid. Call this immediately before confirmOutcomeBrief. Do not change the underlying workflow, bindings, or runtime configuration.",

  confirmOutcomeBrief:
    "Present exactly two confirmation controls after presentAgentTeam: confirm (accept and build) and other (request changes). Use the current confirmation hash from the system prompt. Do not generate or duplicate review content—the roster is already shown. Option id and value must be the action tokens confirm and other only—never add category-specific change buttons. Set allowOther to false. Put user-facing wording in label only. Never expose the hash or internal configuration in user-visible text. The server persists the answer automatically; never ask for a second confirmation.",

  compileLoop:
    "Compile the current confirmed specification into an immutable runnable plan. Do not compile an incomplete or unconfirmed specification. When compile fails on technical metadata, rerun the relevant discovery tool; the server records validated corrections automatically.",

  testRunLoop:
    "Run a simulated smoke test for the compiled plan using the supplied scenario. Use the current compiled plan when no plan identifier is provided.",

  activateLoop:
    "Activate a compiled plan only after the same plan has a passing test run.",
} as const;
