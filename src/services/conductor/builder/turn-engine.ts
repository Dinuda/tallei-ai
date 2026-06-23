import { createHash, randomUUID } from "node:crypto";

import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import { z } from "zod";

import type { AuthContext } from "../../../domain/auth/index.js";
import {
  createLoopBuilderToolCallRepair,
  emptyLoopBuilderUsage,
  executeWorkflowBuilderToolNow,
  loopBuilderStreamMaxOutputTokens,
  loopBuilderStreamProviderOptions,
  mergeLoopBuilderUsageTotals,
  requireWorkflowBuilderSession,
  sanitizeLoopBuilderChatMessages,
  updateWorkflowBuilderSessionState,
  usageFromLanguageModelStep,
  type LoopBuilderUsage,
  type WorkflowBuilderSession,
} from "../index.js";
import { renderTypeInputSchema } from "./render-type.js";
import { getAvailableToolsInputSchema, interactivePromptSchema, optionSchema, resolveIntentInputSchema } from "./phases/shared-schemas.js";
import { normalizeSaveLoopInput, saveLoopInputSchema } from "../inputs/save-loop-input.js";
import { isInternalAiDependencyText, isInternalAiToolkitSlug } from "../inputs/get-available-tools-input.js";
import type { BuilderToolName } from "../contracts/builder-types.js";
import type { BuilderState } from "../contracts/builder-types.js";
import {
  allowedActionsForState,
  legacyPhaseForState,
  reduceBuilderState,
  stateFromSession,
  type BuilderActionKind,
  type BuilderActionName,
} from "./state-machine.js";
import {
  appendBuilderTurnEvent,
  completeBuilderAction,
  completeBuilderTurn,
  failBuilderAction,
  insertBuilderTurn,
  insertOrGetBuilderAction,
  type BuilderTurnEvent,
} from "../data/turn.repository.js";

type BuilderEventWriter = (event: BuilderTurnEvent) => void | Promise<void>;

const SERVER_TOOL_NAMES = new Set<BuilderActionName>([
  "resolveIntent",
  "getAvailableTools",
  "resolveBuildRequirement",
  "previewAgentPlan",
  "saveLoop",
  "runBuilderTest",
  "runVerification",
  "confirmActivation",
]);

const CLIENT_TOOL_NAMES = new Set<BuilderActionName>([
  "interactivePrompt",
  "appSelection",
  "connectorSetup",
  "scheduleSetup",
  "knowledgeBaseSetup",
  "renderType",
  "artifactSetup",
  "requirementSetup",
]);

function stableActionId(state: BuilderState, name: BuilderActionName, input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ state, name, input })).digest("hex").slice(0, 32);
}

function event(type: string, data?: unknown): BuilderTurnEvent {
  return { type, at: new Date().toISOString(), ...(data !== undefined ? { data } : {}) };
}

function sessionSummary(session: WorkflowBuilderSession): Record<string, unknown> {
  return {
    id: session.id,
    revision: session.revision,
    phase: session.phase,
    builderState: session.builderState,
    goal: session.goal,
    resolvedIntent: session.resolvedIntent?.resolvedIntent ?? null,
    discoveredToolCount: session.discoveredToolContracts.length,
    unresolvedRequirements: session.buildContract?.requirements
      .filter((entry) => entry.status !== "resolved")
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        question: entry.question,
      })) ?? [],
    workflowId: session.workflowId,
  };
}

function stateInstructions(state: BuilderState): string {
  switch (state) {
    case "intent.collecting":
      return [
        "Intent Analyst rules:",
        "Your only job in this state is to understand what the user wants done and what end result they expect.",
        "Clarify outcome, business trigger or cadence, approval expectation, and final output or deliverable.",
        "Do not ask which apps, services, connectors, ticket platforms, email tools, data sources, files, or records the loop should use.",
        "Do not ask where data lives. Tool and app selection happens later in requirements.",
        "Tallei performs reasoning, classification, drafting, routing, and orchestration itself. Never assume or ask for an AI provider, model provider, or classification model.",
        "Assumptions must be business-level only, such as cadence and approval expectations. Do not put unresolved app/tool choices in assumptions.",
        "If the desired outcome and end result are clear enough, call resolveIntent even if apps and data sources are unknown.",
        "Use interactivePrompt only for outcome-level clarification, one question at a time.",
      ].join("\n");
    case "intent.resolving":
      return [
        "Intent Resolver rules:",
        "Resolve the business intent into a concise draft of trigger, actions, and output.",
        "Do not introduce app or connector selection in this state.",
      ].join("\n");
    case "requirements.selecting_apps":
      return [
        "Requirements app selection rules:",
        "This state identifies external systems Tallei must read from or write to.",
        "Ask for app selection in a concrete order based on the intent. For support-ticket workflows, ask where customers send support requests first; then mention reply/delivery channels only if they may be separate.",
        "Do not ask broad catalogue questions like which applications the user wants to use.",
        "Do not ask for or recommend AI providers, model providers, classification models, or LLM tools. Tallei handles classification, drafting, and orchestration internally.",
        "Recommended app slugs must be only external business systems: ticketing/support inboxes, email/chat delivery channels, CRM/customer-data systems, or knowledge sources explicitly needed by the workflow.",
        "Ask for app selection only when appSelection is allowed, and stop after that client action.",
      ].join("\n");
    case "requirements.discovering_tools":
      return [
        "Discovery rules:",
        "Run connector/tool discovery once for the selected apps and stop after the server result.",
      ].join("\n");
    case "requirements.resolving":
      return [
        "Setup Coordinator rules:",
        "Resolve exactly one remaining requirement or ask exactly one setup UI question.",
        "Prefer runtime inputs for values that change per run.",
      ].join("\n");
    case "compile.previewing":
    case "compile.awaiting_approval":
      return [
        "Compile rules:",
        "Preview the runtime plan before save.",
        "Never save without explicit user approval.",
      ].join("\n");
    case "verification.testing":
    case "verification.awaiting_activation":
      return [
        "Verification rules:",
        "Test before activation.",
        "Never activate without explicit user approval.",
      ].join("\n");
    case "complete":
      return "The builder flow is complete. Provide a concise status update.";
    case "failed":
      return "The builder flow failed. Explain the blocking issue concisely and ask for the next corrective input.";
  }
}

function sanitizeAppSelectionInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!question || isInternalAiDependencyText(question) || /which apps|which applications|platforms should this loop/i.test(question)) {
    record.question = "Where do your customers send support requests? Select the support inbox or ticketing app first. If replies are sent from a separate channel, select that too.";
  }
  if (Array.isArray(record.recommendedToolkitSlugs)) {
    const recommendedToolkitSlugs = record.recommendedToolkitSlugs
      .map(String)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry && !isInternalAiToolkitSlug(entry));
    record.recommendedToolkitSlugs = recommendedToolkitSlugs.slice(0, 8);
  }
  return record;
}

function systemPrompt(input: {
  state: BuilderState;
  allowedActions: BuilderActionName[];
  session: WorkflowBuilderSession;
}): string {
  return [
    "You are Tallei's deterministic loop builder.",
    "The backend owns state transitions. Use only one allowed action this turn.",
    "If user input is needed, call exactly one client action and stop.",
    "If backend work is needed, call exactly one server action and stop after the tool result.",
    "Do not call tools that are not listed in allowedActions.",
    "If no tool is needed, answer normally in plain text.",
    "Keep visible text concise. Do not expose internal state names, schema errors, or tool ids.",
    stateInstructions(input.state),
    `Current state: ${input.state}`,
    `Allowed actions: ${input.allowedActions.join(", ")}`,
    `Session snapshot:\n${JSON.stringify(sessionSummary(input.session))}`,
  ].join("\n\n");
}

function clientTool(name: BuilderActionName, inputSchema: z.ZodTypeAny) {
  return tool({
    description: `Request the ${name} client interaction and end this turn.`,
    inputSchema: inputSchema as never,
  });
}

function createActionTools(input: {
  auth: AuthContext;
  turnId: string;
  sessionId: string;
  state: BuilderState;
  expectedRevision: number;
  allowedActions: BuilderActionName[];
  emit: BuilderEventWriter;
  onUsage: (usage: LoopBuilderUsage) => void;
}) {
  const tools: ToolSet = {};
  const maybeAddServer = (
    actionName: BuilderActionName,
    toolName: BuilderToolName,
    inputSchema: z.ZodTypeAny,
    normalize: (value: Record<string, unknown>) => Record<string, unknown> = (value) => value,
  ) => {
    if (!input.allowedActions.includes(actionName)) return;
    tools[actionName] = tool({
      description: `Execute ${actionName} as the single backend action for this turn.`,
      inputSchema: inputSchema as never,
      execute: async (rawInput: unknown) => {
        const actionInput = normalize(rawInput as Record<string, unknown>);
        const actionId = stableActionId(input.state, actionName, actionInput);
        const action = await insertOrGetBuilderAction({
          auth: input.auth,
          turnId: input.turnId,
          sessionId: input.sessionId,
          actionId,
          state: input.state,
          actionName,
          actionKind: "server_action",
          inputJson: actionInput,
          expectedRevision: input.expectedRevision,
        });
        if (action.status === "completed" && action.output_json) return action.output_json;
        if (action.status === "failed") throw new Error(action.error_text ?? `${actionName} failed`);

        const latest = await requireWorkflowBuilderSession(input.auth, input.sessionId);
        if (latest.revision !== input.expectedRevision) {
          throw new Error("Builder session changed while this turn was running");
        }

        await input.emit(event("builder.action.started", { actionName, actionKind: "server_action" }));
        try {
          const completed = await executeWorkflowBuilderToolNow(
            input.auth,
            input.sessionId,
            toolName,
            actionInput,
            (_events, usage) => input.onUsage(usage),
          );
          const output = {
            ...completed.result,
            actionName,
            actionKind: "server_action",
            usage: completed.usage,
            progressEvents: completed.events,
          };
          await completeBuilderAction(input.auth, action.id, output);
          await input.emit(event("builder.action.completed", { actionName, actionKind: "server_action", output }));
          return output;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await failBuilderAction(input.auth, action.id, message);
          await input.emit(event("builder.turn.failed", { error: message }));
          throw error;
        }
      },
    }) as ToolSet[string];
  };

  maybeAddServer("resolveIntent", "resolveIntent", resolveIntentInputSchema);
  maybeAddServer("getAvailableTools", "getAvailableTools", getAvailableToolsInputSchema);
  maybeAddServer("resolveBuildRequirement", "resolveBuildRequirement", z.object({
    requirementId: z.string().min(1),
    value: z.unknown(),
  }));
  maybeAddServer("previewAgentPlan", "previewAgentPlan", z.object({}));
  maybeAddServer("saveLoop", "saveLoop", saveLoopInputSchema, (value) => ({ ...normalizeSaveLoopInput(value), approved: true }));
  maybeAddServer("runBuilderTest", "runBuilderTest", z.object({}));
  maybeAddServer("runVerification", "runVerification", z.object({}));
  maybeAddServer("confirmActivation", "confirmActivation", z.object({}), (value) => ({ ...value, approved: true }));

  if (input.allowedActions.includes("interactivePrompt")) tools.interactivePrompt = clientTool("interactivePrompt", interactivePromptSchema) as ToolSet[string];
  if (input.allowedActions.includes("appSelection")) {
    tools.appSelection = clientTool("appSelection", z.preprocess(sanitizeAppSelectionInput, z.object({
      question: z.string().min(1).default("Where do your customers send support requests? Select the support inbox or ticketing app first. If replies are sent from a separate channel, select that too.").describe("A concrete ordered question about external business systems. Never mention AI providers, model providers, or classification models."),
      recommendedToolkitSlugs: z.array(z.string().min(1)).max(8).default([]),
      allowMultiple: z.boolean().default(true),
    }))) as ToolSet[string];
  }
  if (input.allowedActions.includes("connectorSetup")) tools.connectorSetup = clientTool("connectorSetup", z.object({ requirementId: z.string().min(1) })) as ToolSet[string];
  if (input.allowedActions.includes("scheduleSetup")) {
    tools.scheduleSetup = clientTool("scheduleSetup", z.object({
      requirementId: z.string().min(1),
      question: z.string().min(1).default("How often should this loop run?"),
      subtitle: z.string().optional(),
      options: z.array(z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
        trigger: z.enum(["schedule", "event"]).default("schedule"),
        cron: z.string().optional(),
        timezone: z.string().optional(),
        toolkit: z.string().optional(),
        triggerSlug: z.string().optional(),
      })).min(1).max(8).optional(),
      recommendedOptionIds: z.array(z.string().min(1)).max(8).default([]),
      allowOther: z.boolean().default(true),
    })) as ToolSet[string];
  }
  if (input.allowedActions.includes("knowledgeBaseSetup")) tools.knowledgeBaseSetup = clientTool("knowledgeBaseSetup", z.object({ requirementId: z.string().min(1) })) as ToolSet[string];
  if (input.allowedActions.includes("renderType")) tools.renderType = clientTool("renderType", renderTypeInputSchema) as ToolSet[string];
  if (input.allowedActions.includes("artifactSetup")) {
    tools.artifactSetup = clientTool("artifactSetup", z.object({
      requirementId: z.string().min(1).default("artifact_contract"),
    })) as ToolSet[string];
  }
  if (input.allowedActions.includes("requirementSetup")) {
    tools.requirementSetup = clientTool("requirementSetup", z.object({
      requirementId: z.string().min(1),
      question: z.string().min(1),
      options: z.array(optionSchema).min(2).max(8),
      recommendedOptionIds: z.array(z.string().min(1)).max(8).default([]),
      allowMultiple: z.boolean().default(false),
      allowOther: z.boolean().default(true),
    })) as ToolSet[string];
  }
  return tools;
}

function extractLastAction(messages: ModelMessage[]): {
  name: BuilderActionName;
  kind: BuilderActionKind;
  input: Record<string, unknown>;
} | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex] as { type?: string; toolName?: string; input?: unknown; args?: unknown };
      if (part.type !== "tool-call" || !part.toolName) continue;
      const name = part.toolName as BuilderActionName;
      return {
        name,
        kind: SERVER_TOOL_NAMES.has(name)
          ? "server_action"
          : CLIENT_TOOL_NAMES.has(name)
            ? "client_action"
            : "assistant_message",
        input: (part.input ?? part.args ?? {}) as Record<string, unknown>,
      };
    }
  }
  return null;
}

export async function runBuilderTurn(input: {
  auth: AuthContext;
  session: WorkflowBuilderSession;
  model: LanguageModel;
  modelId: string;
  uiMessages: UIMessage[];
  writer: UIMessageStreamWriter;
  analyzerUsageBase: LoopBuilderUsage;
  abortSignal?: AbortSignal;
}): Promise<LoopBuilderUsage> {
  const state = stateFromSession(input.session);
  const allowedActions = allowedActionsForState(state);
  const turnId = randomUUID();
  let turnUsage = emptyLoopBuilderUsage();

  const writeEvent = async (builderEvent: BuilderTurnEvent) => {
    await appendBuilderTurnEvent(input.auth, turnId, builderEvent);
    input.writer.write({ type: "data-builder-event", data: builderEvent, transient: true });
  };

  await insertBuilderTurn({
    auth: input.auth,
    id: turnId,
    sessionId: input.session.id,
    sessionRevision: input.session.revision,
    state,
  });
  await writeEvent(event("builder.turn.started", {
    turnId,
    sessionId: input.session.id,
    sessionRevision: input.session.revision,
    state,
    allowedActions,
  }));

  const tools = createActionTools({
    auth: input.auth,
    turnId,
    sessionId: input.session.id,
    state,
    expectedRevision: input.session.revision,
    allowedActions,
    emit: writeEvent,
    onUsage: (usage) => {
      turnUsage = mergeLoopBuilderUsageTotals(turnUsage, usage);
    },
  });

  const result = streamText({
    model: input.model,
    system: systemPrompt({ state, allowedActions, session: input.session }),
    messages: await convertToModelMessages(sanitizeLoopBuilderChatMessages(input.uiMessages)),
    tools,
    stopWhen: stepCountIs(1),
    maxOutputTokens: loopBuilderStreamMaxOutputTokens(input.modelId),
    providerOptions: loopBuilderStreamProviderOptions(input.modelId) as never,
    experimental_repairToolCall: createLoopBuilderToolCallRepair(input.session.goal),
    abortSignal: input.abortSignal,
    onStepFinish: ({ usage }) => {
      turnUsage = mergeLoopBuilderUsageTotals(turnUsage, usageFromLanguageModelStep(usage, input.modelId));
    },
  });

  input.writer.merge(result.toUIMessageStream({
    originalMessages: input.uiMessages,
    sendReasoning: true,
    messageMetadata: () => ({
      builderState: state,
      turnId,
    }),
  }));

  try {
    const response = await result.response;
    const action = extractLastAction(response.messages);
    if (action?.kind === "client_action") {
      const actionId = stableActionId(state, action.name, action.input);
      const record = await insertOrGetBuilderAction({
        auth: input.auth,
        turnId,
        sessionId: input.session.id,
        actionId,
        state,
        actionName: action.name,
        actionKind: "client_action",
        inputJson: action.input,
        expectedRevision: input.session.revision,
      });
      const output = { actionName: action.name, actionKind: "client_action", input: action.input };
      if (record.status !== "completed") await completeBuilderAction(input.auth, record.id, output);
      await writeEvent(event("builder.client_action.required", output));
    } else if (!action) {
      const record = await insertOrGetBuilderAction({
        auth: input.auth,
        turnId,
        sessionId: input.session.id,
        actionId: stableActionId(state, "assistantMessage", {}),
        state,
        actionName: "assistantMessage",
        actionKind: "assistant_message",
        inputJson: {},
        expectedRevision: input.session.revision,
      });
      if (record.status !== "completed") await completeBuilderAction(input.auth, record.id, { actionName: "assistantMessage" });
    }

    if (action?.kind === "server_action") {
      const refreshed = await requireWorkflowBuilderSession(input.auth, input.session.id);
      const nextState = reduceBuilderState(state, { kind: action.kind, name: action.name }, refreshed);
      if (nextState !== state) {
        const transitioned = await updateWorkflowBuilderSessionState(
          input.auth,
          input.session.id,
          refreshed.revision,
          nextState,
          legacyPhaseForState(nextState),
        );
        await writeEvent(event("builder.state.transitioned", {
          from: state,
          to: nextState,
          sessionRevision: transitioned.revision,
        }));
      }
    }

    await writeEvent(event("builder.turn.completed", { turnId, state }));
    await completeBuilderTurn(input.auth, turnId, "completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeBuilderTurn(input.auth, turnId, input.abortSignal?.aborted ? "aborted" : "failed", message);
    await writeEvent(event("builder.turn.failed", { turnId, error: message }));
    throw error;
  }

  return mergeLoopBuilderUsageTotals(input.analyzerUsageBase, turnUsage);
}
