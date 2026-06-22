import { Router, type Response } from "express";
import { z } from "zod";
import {
  convertToModelMessages,
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  tool,
  validateUIMessages,
  type UIMessage,
} from "ai";

import { getLoopSpec, listLoopSpecs } from "../../../services/loop-builder/specs.js";
import { allocateAgentAvatars, bindAgentAvatar } from "../../../services/loop-builder/agent-avatars.js";
import {
  refreshBuilderConnectorAvailability,
  resolveBuilderConnectorRequirement,
} from "../../../services/loop-builder/connectors.js";
import { saveBuilderArtifactBundle } from "../../../services/loop-builder/artifacts.js";
import {
  dispatchWorkflowBuilderCommand,
  getWorkflowBuilderCommand,
  retryFailedBuilderCommand,
  type BuilderToolName,
} from "../../../services/loop-builder/dispatcher.js";
import { loopBuilderOpenAiModel, loopBuilderStreamMaxOutputTokens, loopBuilderStreamProviderOptions } from "../../../services/loop-builder/openai-chat.js";
import { createLoopBuilderToolCallRepair } from "../../../services/loop-builder/tool-call-repair.js";
import { resolveLoopChatLanguageModel } from "../../../services/llm/loop-chat-client.js";
import {
  emptyLoopBuilderUsage,
  mergeLoopBuilderUsageTotals,
  usageFromLanguageModelStep,
  type LoopBuilderUsage,
} from "../../../services/loop-builder/progress.js";
import {
  createWorkflowBuilderSession,
  listWorkflowBuilderMessages,
  normalizeWorkflowBuilderMessages,
  sanitizeLoopBuilderChatMessages,
  replaceWorkflowBuilderMessages,
  requireWorkflowBuilderSession,
  saveWorkflowBuilderAnalyzerUsage,
  updateWorkflowBuilderSession,
  type WorkflowBuilderSession,
} from "../../../services/loop-builder/sessions.js";
import { pool } from "../../../infrastructure/db/index.js";
import type { AuthContext } from "../../../domain/auth/index.js";
import { listKnowledgeBindings } from "../../../services/knowledge-base.js";
import { loadWorkflowUserProfile } from "../../../services/loop-engine/workflow-user-profile.js";
import type { ToolContract } from "../../../services/tool-spec/types.js";
import { authMiddleware, type AuthRequest, requireScopes } from "../middleware/auth.middleware.js";
import { workspaceMiddleware } from "../middleware/workspace.middleware.js";

const router = Router();

router.use(authMiddleware);
router.use(workspaceMiddleware);

const chatSchema = z.object({
  sessionId: z.string().uuid().optional(),
  messages: z.array(z.unknown()).min(1),
});

function messageText(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
}

async function waitForCommand(
  auth: NonNullable<AuthRequest["authContext"]>,
  commandId: string,
  onProgress?: (command: Awaited<ReturnType<typeof getWorkflowBuilderCommand>>) => void,
) {
  let eventCount = -1;
  let attemptsWithoutProgress = 0;
  // Backend planning attempts can take up to 300s; give a generous window and
  // only timeout when no progress events have arrived for a long stretch.
  while (attemptsWithoutProgress < 2400) {
    const command = await getWorkflowBuilderCommand(auth, commandId);
    if (!command) throw new Error("Builder command disappeared");
    if (command.events.length !== eventCount) {
      eventCount = command.events.length;
      attemptsWithoutProgress = 0;
      onProgress?.(command);
    } else {
      attemptsWithoutProgress += 1;
    }
    if (command.status === "completed" || command.status === "failed" || command.status === "rejected") return command;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Builder command timed out");
}

async function loadSessionCommandUsage(
  auth: NonNullable<AuthRequest["authContext"]>,
  sessionId: string,
): Promise<LoopBuilderUsage> {
  const result = await pool.query<{ usage_json: LoopBuilderUsage | null }>(
    `SELECT usage_json
     FROM workflow_builder_commands
     WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3`,
    [sessionId, auth.tenantId, auth.userId],
  );
  return mergeLoopBuilderUsageTotals(
    emptyLoopBuilderUsage(),
    ...result.rows.map((row) => row.usage_json ?? emptyLoopBuilderUsage()),
  );
}

async function runTool(
  auth: NonNullable<AuthRequest["authContext"]>,
  sessionId: string,
  toolName: BuilderToolName,
  input: Record<string, unknown>,
  onProgress?: (command: Awaited<ReturnType<typeof getWorkflowBuilderCommand>>) => void | Promise<void>,
) {
  const command = await dispatchWorkflowBuilderCommand({ auth, sessionId, toolName, input });
  const completed = await waitForCommand(auth, command.jobId, onProgress);
  if (completed.status !== "completed") {
    throw new Error(completed.error ?? `${toolName} failed`);
  }
  return completed.result ?? {};
}


const getAvailableToolsInputSchema = z.object({
  outcome: z.string().min(1).describe("Resolved loop outcome in one sentence"),
  cadence: z.string().min(1).default("As needed"),
  approvalModel: z.string().min(1).default("Operator approval before external mutations"),
  selectedToolkits: z.array(z.string().min(1)).min(1).describe("Exact Composio toolkit slugs from appSelection output"),
  capabilityQueries: z.array(z.string().min(1)).max(8).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
});

function analyzerTools(
  auth: NonNullable<AuthRequest["authContext"]>,
  sessionId: string,
  onCommandProgress?: () => void | Promise<void>,
) {
  const run = (toolName: BuilderToolName, input: Record<string, unknown>) =>
    runTool(auth, sessionId, toolName, input, () => onCommandProgress?.());
  return {
    appSelection: tool({
      description: "Show the live app catalogue so the user can explicitly choose which apps this loop may use. Pass recommendedToolkitSlugs with 1-3 exact Composio toolkit slugs most likely needed for the user's intent, ordered most likely first (e.g. gmail for email support, slack for chat support). This is a UI interaction, not a builder command.",
      inputSchema: z.object({
        question: z.string().min(1).default("What app is where your customers reach out to you for support?"),
        recommendedToolkitSlugs: z.array(z.string().min(1)).max(8).default([]),
        allowMultiple: z.boolean().default(true),
      }),
    }),
    getAvailableTools: tool({
      description: "Discover exact actions from the apps explicitly selected by the user. Always call appSelection first and pass its exact toolkit slugs in selectedToolkits. Include capabilityQueries with one focused query per distinct external action the loop needs, ordered most essential first (e.g. 'fetch unread customer support emails', 'send reply email to customer'). Each query must describe a single specific action.",
      inputSchema: getAvailableToolsInputSchema,
      execute: (input) => run("getAvailableTools", input),
    }),
    resolveBuildRequirement: tool({
      description: "Validate and durably resolve exactly one pending build-contract requirement. Free-form prose is not accepted unless it matches the requirement's typed value schema.",
      inputSchema: z.object({
        requirementId: z.string().min(1),
        value: z.unknown(),
      }),
      execute: (input) => run("resolveBuildRequirement", input),
    }),
    connectorSetup: tool({
      description: "Render the first-class inline connector checklist for the pending connector build requirement. This is a UI interaction, not a builder command.",
      inputSchema: z.object({
        requirementId: z.string().min(1),
      }),
    }),
    scheduleSetup: tool({
      description: "Render the first-class schedule chooser for the pending trigger requirement. Provide workflow-aware schedule options (minimum cadence: once per hour). Always include allowOther so the user can describe a different timing. This is a UI interaction, not a builder command.",
      inputSchema: z.object({
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
      }),
    }),
    outputReviewGatesSetup: tool({
      description: "Render the output review gate chooser for the pending output_review_gates requirement. This is a UI interaction, not a builder command.",
      inputSchema: z.object({
        requirementId: z.string().min(1).default("output_review_gates"),
        question: z.string().min(1).default("Should this loop pause for operator review between agents?"),
        subtitle: z.string().optional(),
        recommendedOptionIds: z.array(z.string().min(1)).max(4).default(["review_drafts"]),
        allowOther: z.boolean().default(false),
      }),
    }),
    knowledgeBaseSetup: tool({
      description: "Render the knowledge base picker for the pending grounding requirement. Pre-selects Tallei internal memory and workspace memory (including inter-loop history from prior runs). Additional FAQ/Google Doc collections and connected-app product/user search are optional checkboxes. No user-provided URLs are required. This is a UI interaction, not a builder command.",
      inputSchema: z.object({
        requirementId: z.string().min(1),
      }),
    }),
    artifactSetup: tool({
      description: "Render the in-chat email artifact composer for the pending artifact_contract requirement. User previews the minimal reply template, edits copy in the canvas, and approves. This is a UI interaction, not a builder command.",
      inputSchema: z.object({
        requirementId: z.string().min(1).default("artifact_contract"),
        draftTemplates: z.array(z.object({
          templateId: z.enum(["acknowledgment", "troubleshooting", "escalation", "resolution", "blank"]),
          name: z.string().optional(),
          props: z.object({
            subject: z.string().optional(),
            previewText: z.string().optional(),
            greeting: z.string().optional(),
            body: z.string().optional(),
            signOff: z.string().optional(),
            agentName: z.string().optional(),
          }).optional(),
        })).optional(),
      }),
    }),
    requirementSetup: tool({
      description: "Present structured this/that choices plus a custom input for a pending build-contract requirement that is not connector, schedule, grounding, artifact, or output review gates. Use for stable_input, review_policy, and similar operational decisions. User selects an option and/or types their own guidance. This is a UI interaction, not a builder command.",
      inputSchema: z.object({
        requirementId: z.string().min(1),
        question: z.string().min(1),
        options: z.array(z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          value: z.string().min(1),
          description: z.string().optional(),
          icon: z.string().optional(),
        })).min(2).max(8),
        recommendedOptionIds: z.array(z.string().min(1)).max(8).default([]),
        allowMultiple: z.boolean().default(false),
        allowOther: z.boolean().default(true),
      }),
    }),
    interactivePrompt: tool({
      description: "Present a structured option menu to the user when clarification can be answered with choices. This is a UI interaction, not a builder command. Only set the 'icon' field when an option represents a known external service or app (e.g., HubSpot, Salesforce, Slack, Notion, Gmail). For action options like 'Save loop', 'Make changes', 'Other', or 'I will connect manually', leave the 'icon' field empty.",
      inputSchema: z.object({
        question: z.string().min(1),
        options: z.array(z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          value: z.string().min(1),
          description: z.string().optional(),
          icon: z.string().optional(),
        })).min(2).max(8),
        recommendedOptionIds: z.array(z.string().min(1)).max(8).default([]),
        allowMultiple: z.boolean().default(false),
        allowOther: z.boolean().default(true),
      }),
    }),
    saveLoop: tool({
      description: "Compile the config-driven runtime agent contract, save the loop, and initialize verification. Call only after requirements are ready and the user confirms they want to save.",
      inputSchema: z.object({
        cron: z.string().optional(),
        timezone: z.string().optional(),
        workspaceId: z.string().uuid().nullable().optional(),
      }),
      execute: (input) => {
        return run("saveLoop", { ...input, approved: true });
      },
    }),
    runBuilderTest: tool({
      description: "Start the safe builder test run for the saved workflow. Call after saveLoop completes, not before.",
      inputSchema: z.object({}),
      execute: (input) => run("runBuilderTest", input),
    }),
    runVerification: tool({
      description: "Run the dedicated verification lifecycle for a saved workflow before activation.",
      inputSchema: z.object({}),
      execute: (input) => run("runVerification", input),
    }),
    confirmActivation: tool({
      description: "Confirm successful verification evidence and activate the workflow schedule. Call only after the user explicitly selects activation.",
      inputSchema: z.object({}),
      execute: (input) => run("confirmActivation", { ...input, approved: true }),
    }),
  };
}

function connectedSearchToolkits(contracts: ToolContract[]): Array<{ toolkit: string; name: string; connected: boolean }> {
  const seen = new Set<string>();
  const toolkits: Array<{ toolkit: string; name: string; connected: boolean }> = [];
  for (const contract of contracts) {
    const match = contract.toolRef.match(/^composio\.([^.]+)\.search$/i);
    if (!match?.[1]) continue;
    const toolkit = match[1].toLowerCase();
    if (seen.has(toolkit)) continue;
    seen.add(toolkit);
    toolkits.push({
      toolkit,
      name: contract.name,
      connected: contract.constraints.connected === true,
    });
  }
  return toolkits;
}

async function buildAnalyzerSystemPrompt(
  auth: AuthContext,
  session: WorkflowBuilderSession,
): Promise<string> {
  const [bindings, profile] = await Promise.all([
    listKnowledgeBindings(auth).catch(() => null),
    loadWorkflowUserProfile(auth).catch(() => null),
  ]);
  const recalledPreferences = (profile?.memories ?? []).map((memory) => ({
    id: memory.id,
    text: memory.text.slice(0, 200),
    category: memory.category ?? null,
  }));
  const groundingContext = {
    builtinSources: ["tallei_memory", "workspace_memory"],
    workspaceMemoryIncludes: "prior loop runs, synced docs, and workspace preferences in this workspace",
    recalledPreferences,
    workspaceKnowledgeBases: (bindings?.knowledgeBases ?? []).map((kb) => ({
      id: kb.id,
      name: kb.name,
      kind: kb.kind,
    })),
    connectedSearchToolkits: connectedSearchToolkits(session.discoveredToolContracts),
  };

  return [
    "You are the loop builder analyzer and orchestrator.",
    "Reason internally about the user's intent and clarification answers. Intent analysis and clarification resolution are not tools.",
    "If an answer would materially change the outcome, schedule, runtime inputs, approval model, or required capabilities, ask for clarification.",
    "Whenever a clarification can be expressed as choices, including binary yes/no questions, call interactivePrompt and stop. Ask only one interactive prompt at a time.",
    "Use allowMultiple only when more than one choice may be selected. Include a recommended option when a safe default exists. Use allowOther when a custom answer is reasonable.",
    "For options representing known services or integrations (e.g., HubSpot, Salesforce, Slack, Notion, Mailchimp), include the Composio icon key in the 'icon' field of each option. Common keys: hubspot, salesforce, pipedrive, zoho-crm, slack, notion, mailchimp, gmail, github, airtable, trello, asana, zendesk, stripe, google-sheets, google-docs.",
    "Only ask a normal assistant text question when it genuinely cannot be represented as useful choices.",
    "Never ask the user to paste API keys, passwords, or credentials. Offer account connection as an option instead.",
    "When the intent is clear and the user has not selected apps yet, call appSelection and stop. Never infer or silently select an app from the workflow description. In appSelection, pass recommendedToolkitSlugs with the 1-3 most likely Composio toolkit slugs for the user's intent, ordered most likely first.",
    "After appSelection returns, call getAvailableTools with outcome (resolved intent), the exact selectedToolkits slugs from appSelection, and capabilityQueries: one specific query per distinct external action the loop needs (e.g. 'list unread support emails', 'send customer reply email'), ordered from most essential to supporting. Each capability query must target a single action, not a broad category. Discover tools only from those apps.",
    "Grounding and knowledge sources playbook:",
    "- Built-in sources (no URLs): tallei_memory and workspace_memory are always available. Workspace memory includes prior loop run outputs and preferences in the active workspace.",
    "- When the user mentions internal knowledge, memory, docs, knowledge bases, company info, or FAQs, call knowledgeBaseSetup immediately and stop. Never ask for URLs, document names, or KB identifiers in prose.",
    "- When groundingContext.recalledPreferences is non-empty and the user has not yet confirmed preferences this session, call interactivePrompt first with: question 'We found these saved preferences — are these what you want this loop to use, or something else?', options 'Use these preferences' (recommended), 'Use memory but I will adjust later', 'Skip preferences for this loop', allowOther true. Then continue to knowledgeBaseSetup when grounding is still pending.",
    "- For a pending grounding requirement, never use interactivePrompt as the primary grounding UI when knowledgeBaseSetup is the correct tool.",
    "- Optional product/user/CRM data: offer only via knowledgeBaseSetup external toolkit checkboxes or interactivePrompt using connectedSearchToolkits from groundingContext. If a toolkit is wanted but not connected, offer connectorSetup or skip — never require pasted URLs or credentials.",
    "- User may choose no grounding via resolveBuildRequirement with { mode: 'none' } when allowNone is true.",
    "After getAvailableTools, resolve every pending build-contract requirement one at a time. For a pending connector requirement, call connectorSetup and stop; never use interactivePrompt for connector setup and never offer connect later. For a pending trigger_schedule requirement, call scheduleSetup and stop. For a pending grounding requirement, call knowledgeBaseSetup and stop. For a pending artifact_contract requirement, call artifactSetup with draftTemplates entries (acknowledgment, troubleshooting, escalation, resolution) that pre-fill subject/body copy for the minimal support-reply templates and stop; never use interactivePrompt or prose numbered options for artifact setup. For a pending output_review_gates requirement, call outputReviewGatesSetup and stop; the user must choose whether to review drafts only or drafts plus send confirmation. For a pending stable_input, review_policy, or other generic build requirement, call requirementSetup and stop — never ask in prose with numbered or bulleted option lists. requirementSetup must offer 2-4 concrete options with short descriptions (e.g. simple rule, paste policy, use Tallei default) and allowOther true so the user can type custom guidance. Never invent event-driven execution unless an exact discovered trigger capability explicitly supports it.",
    "Schedule playbook for trigger_schedule:",
    "- Minimum cadence is once per hour. Never offer or resolve schedules more frequent than hourly.",
    "- Call scheduleSetup with 2-4 workflow-aware options inferred from the resolved intent (e.g. weekly Monday morning for newsletters, daily morning for digests, hourly for monitoring). Mark the best-fit option recommended via recommendedOptionIds.",
    "- Include discovered event triggers in scheduleSetup only when they exactly match the workflow; prefer the matching event over polling when appropriate.",
    "- Always set allowOther true so the user can choose Tell Tallei what to do differently for custom timing.",
    "- Use a concrete question and optional subtitle tied to the workflow (e.g. weekly newsletter timing), not generic hourly/daily-only wording.",
    "- Never ask schedule timing in prose or numbered lists outside scheduleSetup.",
    "After scheduleSetup, knowledgeBaseSetup, outputReviewGatesSetup, or requirementSetup returns, pass its exact typed value to resolveBuildRequirement. Map requirementSetup answers to the requirement schema: for stable_input use { name, value } where value is the selected option value and/or otherText; for review_policy use { mode } inferred from the answer. For outputReviewGatesSetup, pass { mode } from the tool output value (review_drafts or review_drafts_and_send). For scheduleSetup with a selected preset, pass { trigger: 'schedule', cron, timezone } or { trigger: 'event', toolkit, triggerSlug } from the tool output value. If scheduleSetup returns customScheduleText, translate it into a valid schedule at least 1 hour apart, then resolve — never reject reasonable custom timing without offering the nearest valid option.",
    "artifact_contract handoff: when artifactSetup returns with artifactPersisted true, the approved template bundle is already durably resolved server-side. Do not call resolveBuildRequirement for artifact_contract in that case — continue to the next pending requirement or the save prompt. Never reconstruct or simplify the template JSON yourself.",
    "Do not reinterpret the selected schedule, knowledge sources, artifact bundle, or operational policy except when converting customScheduleText into cron.",
    "Never show schema validation errors, cron expressions, tool identifiers, or internal validation wording to the user. If a requested capability is unavailable, say that capability is currently limited or unsupported and offer the nearest supported choice through the appropriate UI tool.",
    "Never treat unrelated prose as a valid requirement answer. Never silently assume a connector, trigger, schedule, source, template, stable input, or review policy.",
    "The user may explicitly choose no source or no template only when the requirement allows it; persist that choice through resolveBuildRequirement.",
    "Always show build-contract warnings to the user, especially explicit ungrounded or no-template choices.",
    "After resolveBuildRequirement reports readyForSpecDraft true, summarize the resolved configuration briefly and immediately call interactivePrompt in the same turn: 'Save and test loop' (recommended), 'I want more changes', and 'Start over'. Do not call a separate draft, preview, approve, or refine step.",
    "When the user selects 'Save and test loop', call saveLoop first. It compiles the runtime agent contract, persists the workflow, and initializes verification. After saveLoop completes, call runBuilderTest as a separate step so the test run has its own visible status.",
    "If saveLoop fails with a timeout, 502, 503, 504, or backend connectivity error, explain transparently that this is a temporary backend infrastructure issue — not caused by the user's configuration. When buildContract requirements are all resolved, reassure them every setup choice is already persisted in this builder session and offer retry/reload options through chat.",
    "If saveLoop fails with runtime contract validation, do not call it infrastructure. Explain in chat that the builder needs to recompile from the approved choices and offer retry or more changes; never expose raw schema paths, tool identifiers, or internal validation wording to the user.",
    "When the user selects 'I want more changes' or gives behavioral feedback, resolve the changed build requirement directly, then offer 'Save and test loop' again. Never call a spec refinement tool.",
    "After runBuilderTest completes, summarize the verification and builder test run status. Distinguish critical failures (block activation) from optional warnings (loop may still activate). When verification status is awaiting_confirmation — including when only optional read probes warned — present 'Activate' (recommended) and 'I'll do more changes' via interactivePrompt. Call confirmActivation only from Activate.",
    "After confirmActivation succeeds, tell the user their loop is live. Point them to the header status bar for runs and agent approvals. Mention they can keep refining in the builder if needed.",
    "Never output a bulleted, numbered, or formatted list of options or actions the user can take in your prose text response. If you have choices, next steps, or decisions to offer — including escalation rules, review policies, or stable inputs — you must present them via requirementSetup or interactivePrompt, never as prose lists above the text box.",
    "Keep visible rationale concise. Do not reveal hidden chain-of-thought.",
    `Current durable session projection:\n${JSON.stringify({
      phase: session.phase,
      goal: session.goal,
      intentAnalysis: session.intentAnalysis,
      resolvedIntent: session.resolvedIntent,
      discoveredTools: session.discoveredToolContracts.map((contract) => ({
        name: contract.name,
        description: contract.description,
        connected: contract.constraints.connected ?? false,
        risk: contract.constraints.risk ?? null,
      })),
      buildContract: session.buildContract ? {
        ...session.buildContract,
        requirements: session.buildContract.requirements.map((requirement) => ({
          ...requirement,
          validationErrors: [],
        })),
      } : null,
      specId: session.specId,
      proposal: session.currentProposal ? {
        title: session.currentProposal.title,
        summary: session.currentProposal.summary,
      } : null,
      workflowId: session.workflowId,
      error: null,
      groundingContext,
    })}`,
  ].join("\n\n");
}

router.post("/chat", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = chatSchema.parse(req.body ?? {});
    const messages = await validateUIMessages({
      messages: normalizeWorkflowBuilderMessages(body.messages),
    });
    const last = messages.at(-1);
    const firstUserText = messages.find((message) => message.role === "user");
    const text = messageText(last?.role === "user" ? last : firstUserText);
    if (!text && !body.sessionId) {
      res.status(400).json({ error: "A text message is required" });
      return;
    }
    const session = body.sessionId
      ? await requireWorkflowBuilderSession(req.authContext!, body.sessionId)
      : await createWorkflowBuilderSession(req.authContext!, text);
    const sessionId = session.id;
    const analyzerUsageBase = session.analyzerUsage ?? emptyLoopBuilderUsage();

    // Persist the incoming messages immediately so the user's turns survive
    // page reloads or stream interruptions before onFinish runs.
    await replaceWorkflowBuilderMessages(req.authContext!, sessionId, messages);

    const system = await buildAnalyzerSystemPrompt(req.authContext!, session);
    const modelId = loopBuilderOpenAiModel();
    const model = resolveLoopChatLanguageModel(modelId);
    let completedTurnUsage = emptyLoopBuilderUsage();
    const stream = createUIMessageStream({
      originalMessages: messages,
      execute: async ({ writer }) => {
        writer.write({ type: "data-session", data: { sessionId }, transient: true });
        let runningTurnUsage = emptyLoopBuilderUsage();
        const emitLiveUsage = async () => {
          const commandUsage = await loadSessionCommandUsage(req.authContext!, sessionId);
          writer.write({
            type: "data-usage",
            data: mergeLoopBuilderUsageTotals(analyzerUsageBase, runningTurnUsage, commandUsage),
            transient: true,
          });
        };
        const tools = analyzerTools(req.authContext!, sessionId, () => emitLiveUsage());
        const apiMessages = sanitizeLoopBuilderChatMessages(messages);
        const result = streamText({
          model,
          system,
          messages: await convertToModelMessages(apiMessages, { tools }),
          tools,
          maxOutputTokens: loopBuilderStreamMaxOutputTokens(modelId),
          providerOptions: loopBuilderStreamProviderOptions(modelId) as never,
          experimental_repairToolCall: createLoopBuilderToolCallRepair(session.goal),
          stopWhen: stepCountIs(10),
          onError: ({ error }) => console.error("Loop builder analyzer stream failed:", error),
          onStepFinish: ({ usage }) => {
            runningTurnUsage = mergeLoopBuilderUsageTotals(
              runningTurnUsage,
              usageFromLanguageModelStep(usage, modelId),
            );
            void emitLiveUsage();
          },
          onFinish: ({ totalUsage }) => {
            completedTurnUsage = usageFromLanguageModelStep(totalUsage, modelId);
            const sessionUsage = mergeLoopBuilderUsageTotals(analyzerUsageBase, completedTurnUsage);
            void (async () => {
              const commandUsage = await loadSessionCommandUsage(req.authContext!, sessionId);
              writer.write({
                type: "data-usage",
                data: mergeLoopBuilderUsageTotals(sessionUsage, commandUsage),
                transient: true,
              });
              await saveWorkflowBuilderAnalyzerUsage(req.authContext!, sessionId, sessionUsage);
            })();
          },
        });
        writer.merge(result.toUIMessageStream({ originalMessages: messages, sendReasoning: true }));
      },
      onFinish: async ({ messages: completedMessages }) => {
        const patchedMessages = completedMessages.map((message, index) => {
          if (index !== completedMessages.length - 1 || message.role !== "assistant") return message;
          if (completedTurnUsage.promptTokens === 0 && completedTurnUsage.completionTokens === 0) return message;
          return {
            ...message,
            metadata: {
              ...(message.metadata ?? {}),
              usage: {
                promptTokens: completedTurnUsage.promptTokens,
                completionTokens: completedTurnUsage.completionTokens,
                totalTokens: completedTurnUsage.promptTokens + completedTurnUsage.completionTokens,
                estimatedCostUsd: completedTurnUsage.estimatedCostUsd,
              },
            },
          };
        });
        await replaceWorkflowBuilderMessages(req.authContext!, sessionId, patchedMessages);
      },
      onError: (error) => error instanceof Error ? error.message : String(error),
    });
    pipeUIMessageStreamToResponse({ response: res, stream });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : /not available|requires|required|not found/i.test(error instanceof Error ? error.message : "") ? 409 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Failed to process builder chat" });
  }
});

router.put("/sessions/:sessionId/messages", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({ messages: z.array(z.unknown()) }).parse(req.body ?? {});
    await requireWorkflowBuilderSession(req.authContext!, sessionId);
    await replaceWorkflowBuilderMessages(
      req.authContext!,
      sessionId,
      await validateUIMessages({ messages: normalizeWorkflowBuilderMessages(body.messages) }),
    );
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save builder messages";
    res.status(error instanceof z.ZodError ? 400 : /not found/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/retry-command", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({ commandId: z.string().uuid().optional() }).parse(req.body ?? {});
    const command = await retryFailedBuilderCommand(req.authContext!, sessionId, body.commandId);
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to retry builder command";
    res.status(error instanceof z.ZodError ? 400 : /not found|no failed/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.get("/sessions/:sessionId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const session = await requireWorkflowBuilderSession(req.authContext!, sessionId);
    const rawMessages = await listWorkflowBuilderMessages(req.authContext!, sessionId);
    const messages = rawMessages.length > 0 ? await validateUIMessages({ messages: rawMessages }) : [];
    const commandsResult = await pool.query(
      `SELECT id, tool_name, status, events_json, usage_json, error_text, created_at, updated_at
       FROM workflow_builder_commands
       WHERE session_id = $1 AND tenant_id = $2 AND user_id = $3
       ORDER BY created_at ASC`,
      [sessionId, req.authContext!.tenantId, req.authContext!.userId]
    );
    const commands = commandsResult.rows.map(row => ({
      id: row.id,
      toolName: row.tool_name,
      status: row.status,
      events: row.events_json ?? [],
      usage: row.usage_json ?? {},
      result: row.result_json ?? undefined,
      error: row.error_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const profile = await loadWorkflowUserProfile(req.authContext!).catch(() => null);
    const recalledPreferences = (profile?.memories ?? []).map((memory) => ({
      id: memory.id,
      text: memory.text.slice(0, 200),
      category: memory.category ?? null,
    }));
    res.json({ session, messages, commands, recalledPreferences });
  } catch (error) {
    res.status(error instanceof z.ZodError ? 400 : 404).json({ error: error instanceof Error ? error.message : "Builder session not found" });
  }
});

router.post("/sessions/:sessionId/connectors/refresh", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    res.json({ checklist: await refreshBuilderConnectorAvailability(req.authContext!, sessionId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refresh connector availability";
    res.status(error instanceof z.ZodError ? 400 : /not found|no connector requirement/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/connectors/resolve", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    res.json(await resolveBuilderConnectorRequirement(req.authContext!, sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve connector requirement";
    res.status(error instanceof z.ZodError ? 400 : /not found|no connector requirement/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/sessions/:sessionId/artifacts/save", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({
      requirementId: z.string().min(1).default("artifact_contract"),
      value: z.object({
        mode: z.literal("supplied_template"),
        template: z.string().min(1),
      }),
      messages: z.array(z.unknown()).optional(),
    }).parse(req.body ?? {});
    const result = await saveBuilderArtifactBundle(req.authContext!, sessionId, {
      requirementId: body.requirementId,
      value: body.value,
    });
    if (body.messages) {
      await replaceWorkflowBuilderMessages(
        req.authContext!,
        sessionId,
        await validateUIMessages({ messages: normalizeWorkflowBuilderMessages(body.messages) }),
      );
    }
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save artifact templates";
    res.status(error instanceof z.ZodError ? 400 : /not found|no build contract/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.get("/sessions/:sessionId/schedule-options", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const session = await requireWorkflowBuilderSession(req.authContext!, sessionId);
    const requirement = session.buildContract?.requirements.find((entry) => entry.kind === "trigger_schedule");
    if (!requirement) throw new Error("This builder session has no trigger requirement.");
    res.json({ requirementId: requirement.id, capabilities: requirement.triggerCapabilities ?? { minimumScheduleMinutes: 60, events: [] } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load schedule options";
    res.status(error instanceof z.ZodError ? 400 : /not found|no trigger requirement/i.test(message) ? 404 : 409).json({ error: message });
  }
});

router.post("/intent/analyze", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({ prompt: z.string().trim().min(1).max(10_000) }).parse(req.body ?? {});
    const session = await createWorkflowBuilderSession(req.authContext!, body.prompt);
    const command = await dispatchWorkflowBuilderCommand({
      auth: req.authContext!,
      sessionId: session.id,
      toolName: "getAvailableTools",
      input: {
        outcome: body.prompt,
        cadence: "As needed",
        approvalModel: "Operator approval before external mutations",
        resolvedIntent: body.prompt,
        assumptions: [],
      },
    });
    res.status(202).json(command);
  } catch (error) {
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : "Failed to analyze loop intent" });
  }
});

router.post("/specs/draft", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  res.status(410).json({ error: "Spec drafts are no longer used. Use /api/loop-builder/save to compile and save the runtime agent contract." });
});

router.post("/specs/:specId/refine", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  res.status(410).json({ error: "Spec refinement is no longer used. Update the resolved builder requirements, then save the runtime agent contract." });
});

router.post("/specs/:specId/approve", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  res.status(410).json({ error: "Spec approval is no longer used. Saving the loop compiles and persists the runtime agent contract directly." });
});

router.post("/specs/:specId/archive", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  res.status(410).json({ error: "Spec archival is no longer part of the builder flow. Start over from the builder session instead." });
});

router.get("/jobs/:jobId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const command = await getWorkflowBuilderCommand(req.authContext!, z.string().uuid().parse(req.params.jobId));
    if (!command) return void res.status(404).json({ error: "Loop builder job not found" });
    res.json(command);
  } catch (error) {
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: error instanceof Error ? error.message : "Failed to read loop builder job" });
  }
});

router.post("/save", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({
      sessionId: z.string().uuid(),
      cron: z.string().optional(),
      timezone: z.string().optional(),
      workspaceId: z.string().uuid().nullable().optional(),
    }).parse(req.body ?? {});
    const command = await dispatchWorkflowBuilderCommand({
      auth: req.authContext!, sessionId: body.sessionId, toolName: "saveLoop",
      input: { cron: body.cron, timezone: body.timezone, workspaceId: body.workspaceId, approved: true },
    });
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save loop";
    res.status(error instanceof z.ZodError ? 400 : 409).json({ error: message });
  }
});

router.get("/specs", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const specs = await listLoopSpecs(req.authContext!);
    res.json({ specs });
  } catch (error) {
    console.error("Error listing loop specs:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list loop specs" });
  }
});

router.get("/specs/:specId", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const { specId } = z.object({ specId: z.string().uuid() }).parse(req.params);
    const spec = await getLoopSpec(req.authContext!, specId);
    if (!spec || spec.status === "archived") {
      res.status(404).json({ error: "Loop spec not found" });
      return;
    }
    res.json({ spec });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    console.error("Error reading loop spec:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to read loop spec" });
  }
});

router.patch("/sessions/:sessionId", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const sessionId = z.string().uuid().parse(req.params.sessionId);
    const body = z.object({ title: z.string().trim().min(1).max(120) }).parse(req.body ?? {});
    const session = await requireWorkflowBuilderSession(req.authContext!, sessionId);
    
    // We update title, goal, and if currentProposal exists, we update its title too.
    const patch: Parameters<typeof updateWorkflowBuilderSession>[2] = {
      title: body.title,
      goal: body.title,
    };
    if (session.currentProposal) {
      patch.currentProposal = { ...session.currentProposal, title: body.title };
    }
    
    const updated = await updateWorkflowBuilderSession(req.authContext!, sessionId, patch);
    res.json({ session: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update builder session";
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: message });
  }
});

router.post("/agent-avatars/allocate", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({ count: z.number().int().min(1).max(20).optional() }).parse(req.body ?? {});
    const avatars = await allocateAgentAvatars(req.authContext!, body.count ?? 1);
    res.json({ avatars });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to allocate avatars";
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: message });
  }
});

router.post("/agent-avatars/:avatarId/bind", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const avatarId = z.string().uuid().parse(req.params.avatarId);
    const body = z.object({
      specId: z.string().uuid(),
      agentId: z.string().min(1).trim(),
    }).parse(req.body ?? {});
    const avatar = await bindAgentAvatar(req.authContext!, avatarId, body);
    res.json({ avatar });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to bind avatar";
    const status = message.includes("not found") ? 404 : message.includes("already bound") ? 409 : error instanceof z.ZodError ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
