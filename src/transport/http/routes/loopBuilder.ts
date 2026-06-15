import { Router, type Response } from "express";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
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
import {
  refreshBuilderConnectorAvailability,
  resolveBuilderConnectorRequirement,
} from "../../../services/loop-builder/connectors.js";
import {
  dispatchWorkflowBuilderCommand,
  getWorkflowBuilderCommand,
  type BuilderToolName,
} from "../../../services/loop-builder/dispatcher.js";
import { loopBuilderOpenAiModel } from "../../../services/loop-builder/openai-chat.js";
import {
  createWorkflowBuilderSession,
  findWorkflowBuilderSessionBySpec,
  listWorkflowBuilderMessages,
  normalizeWorkflowBuilderMessages,
  replaceWorkflowBuilderMessages,
  requireWorkflowBuilderSession,
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

const promptCompatibilitySchema = z.object({
  prompt: z.string().trim().min(1).max(10_000),
  sessionId: z.string().uuid().optional(),
  specId: z.string().uuid().optional(),
  feedback: z.string().trim().min(1).max(5000).optional(),
  priorProposal: z.unknown().optional(),
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

async function runTool(
  auth: NonNullable<AuthRequest["authContext"]>,
  sessionId: string,
  toolName: BuilderToolName,
  input: Record<string, unknown>,
) {
  const command = await dispatchWorkflowBuilderCommand({ auth, sessionId, toolName, input });
  const completed = await waitForCommand(auth, command.jobId);
  if (completed.status !== "completed") {
    throw new Error(completed.error ?? `${toolName} failed`);
  }
  return completed.result ?? {};
}

const normalizedIntentSchema = z.object({
  outcome: z.string().min(1),
  toolCategories: z.array(z.string().min(1)).default([]),
  cadence: z.string().min(1),
  approvalModel: z.string().min(1),
  runtimeInputs: z.array(z.string().min(1)).default([]),
});

function analyzerTools(auth: NonNullable<AuthRequest["authContext"]>, sessionId: string) {
  return {
    appSelection: tool({
      description: "Show the live app catalogue so the user can explicitly choose which apps this loop may use. This is a UI interaction, not a builder command.",
      inputSchema: z.object({
        question: z.string().min(1).default("What app is where your customers reach out to you for support?"),
        recommendedToolkitSlugs: z.array(z.string().min(1)).max(8).default([]),
        allowMultiple: z.boolean().default(true),
      }),
    }),
    getAvailableTools: tool({
      description: "Discover exact actions from the apps explicitly selected by the user. Always call appSelection first and pass its exact toolkit slugs.",
      inputSchema: z.object({
        normalizedIntent: normalizedIntentSchema,
        resolvedIntent: z.string().min(1),
        assumptions: z.array(z.string().min(1)).default([]),
        selectedToolkits: z.array(z.string().min(1)).min(1),
      }),
      execute: (input) => runTool(auth, sessionId, "getAvailableTools", input),
    }),
    resolveBuildRequirement: tool({
      description: "Validate and durably resolve exactly one pending build-contract requirement. Free-form prose is not accepted unless it matches the requirement's typed value schema.",
      inputSchema: z.object({
        requirementId: z.string().min(1),
        value: z.unknown(),
      }),
      execute: (input) => runTool(auth, sessionId, "resolveBuildRequirement", input),
    }),
    connectorSetup: tool({
      description: "Render the first-class inline connector checklist for the pending connector build requirement. This is a UI interaction, not a builder command.",
      inputSchema: z.object({
        requirementId: z.string().min(1),
      }),
    }),
    scheduleSetup: tool({
      description: "Render the first-class schedule chooser for the pending trigger requirement. It only offers schedules supported by the current platform. This is a UI interaction, not a builder command.",
      inputSchema: z.object({
        requirementId: z.string().min(1),
      }),
    }),
    knowledgeBaseSetup: tool({
      description: "Render the knowledge base picker for the pending grounding requirement. Pre-selects Tallei internal memory and workspace memory (including inter-loop history from prior runs). Additional FAQ/Google Doc collections and connected-app product/user search are optional checkboxes. No user-provided URLs are required. This is a UI interaction, not a builder command.",
      inputSchema: z.object({
        requirementId: z.string().min(1),
      }),
    }),
    interactivePrompt: tool({
      description: "Present a structured option menu to the user when clarification can be answered with choices. This is a UI interaction, not a builder command. Only set the 'icon' field when an option represents a known external service or app (e.g., HubSpot, Salesforce, Slack, Notion, Gmail). For action options like 'Approve spec', 'Refine the spec', 'Save workflow', 'Other', or 'I will connect manually', leave the 'icon' field empty.",
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
    draftSpec: tool({
      description: "Create and persist the behavioral loop spec after getAvailableTools has completed.",
      inputSchema: z.object({}),
      execute: (input) => runTool(auth, sessionId, "draftSpec", input),
    }),
    refineSpec: tool({
      description: "Refine the current draft spec from user feedback. This invalidates approval and any generated graph.",
      inputSchema: z.object({ feedback: z.string().min(1) }),
      execute: (input) => runTool(auth, sessionId, "refineSpec", input),
    }),
    approveSpec: tool({
      description: "Approve the current behavioral spec. Call when the user selects 'Approve spec' from the interactive prompt. The interactive prompt selection itself is the user's approval; do not require an additional confirmation.",
      inputSchema: z.object({
        specJson: z.unknown().optional(),
        bodyMarkdown: z.string().optional(),
      }),
      execute: (input) => runTool(auth, sessionId, "approveSpec", { ...input, approved: true }),
    }),
    archiveSpec: tool({
      description: "Archive the current spec. Call when the user selects 'Archive and start over' from the interactive prompt. The interactive prompt selection itself is the user's approval; do not require an additional confirmation.",
      inputSchema: z.object({}),
      execute: (input) => runTool(auth, sessionId, "archiveSpec", { ...input, approved: true }),
    }),
    generateWorkflowGraph: tool({
      description: "Generate the executable workflow graph from the approved spec and persisted discovered contracts.",
      inputSchema: z.object({}),
      execute: (input) => runTool(auth, sessionId, "generateWorkflowGraph", input),
    }),
    refineWorkflowGraph: tool({
      description: "Refine the current workflow graph from user feedback without changing builder or Composio sessions.",
      inputSchema: z.object({ feedback: z.string().min(1) }),
      execute: (input) => runTool(auth, sessionId, "refineWorkflowGraph", input),
    }),
    saveWorkflow: tool({
      description: "Persist the generated workflow. Call when the user selects 'Save workflow' from the interactive prompt. The interactive prompt selection itself is the user's approval; do not require an additional confirmation.",
      inputSchema: z.object({
        cron: z.string().optional(),
        timezone: z.string().optional(),
        workspaceId: z.string().uuid().nullable().optional(),
      }),
      execute: (input) => runTool(auth, sessionId, "saveWorkflow", { ...input, approved: true }),
    }),
    runVerification: tool({
      description: "Run the dedicated verification lifecycle for a saved workflow before activation.",
      inputSchema: z.object({}),
      execute: (input) => runTool(auth, sessionId, "runVerification", input),
    }),
    confirmActivation: tool({
      description: "Confirm successful verification evidence and activate the workflow schedule. Call only after the user explicitly selects activation.",
      inputSchema: z.object({}),
      execute: (input) => runTool(auth, sessionId, "confirmActivation", { ...input, approved: true }),
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
    "When the intent is clear and the user has not selected apps yet, call appSelection and stop. Never infer or silently select an app from the workflow description.",
    "After appSelection returns, call getAvailableTools with the complete normalized resolved intent and the exact selectedToolkits slugs from its output. Discover tools only from those apps.",
    "Grounding and knowledge sources playbook:",
    "- Built-in sources (no URLs): tallei_memory and workspace_memory are always available. Workspace memory includes prior loop run outputs and preferences in the active workspace.",
    "- When the user mentions internal knowledge, memory, docs, knowledge bases, company info, or FAQs, call knowledgeBaseSetup immediately and stop. Never ask for URLs, document names, or KB identifiers in prose.",
    "- When groundingContext.recalledPreferences is non-empty and the user has not yet confirmed preferences this session, call interactivePrompt first with: question 'We found these saved preferences — are these what you want this loop to use, or something else?', options 'Use these preferences' (recommended), 'Use memory but I will adjust later', 'Skip preferences for this loop', allowOther true. Then continue to knowledgeBaseSetup when grounding is still pending.",
    "- For a pending grounding requirement, never use interactivePrompt as the primary grounding UI when knowledgeBaseSetup is the correct tool.",
    "- Optional product/user/CRM data: offer only via knowledgeBaseSetup external toolkit checkboxes or interactivePrompt using connectedSearchToolkits from groundingContext. If a toolkit is wanted but not connected, offer connectorSetup or skip — never require pasted URLs or credentials.",
    "- User may choose no grounding via resolveBuildRequirement with { mode: 'none' } when allowNone is true.",
    "After getAvailableTools, resolve every pending build-contract requirement one at a time. For a pending connector requirement, call connectorSetup and stop; never use interactivePrompt for connector setup and never offer connect later. For a pending trigger_schedule requirement, call scheduleSetup and stop. For a pending grounding requirement, call knowledgeBaseSetup and stop. Never invent event-driven execution unless an exact discovered trigger capability explicitly supports it. Never offer schedules more frequent than hourly. For other requirements, ask the user for the requirement's value, then call resolveBuildRequirement with a typed value matching its schema.",
    "After scheduleSetup or knowledgeBaseSetup returns, pass its exact typed value to resolveBuildRequirement. Do not reinterpret the selected schedule or knowledge sources.",
    "Never show schema validation errors, cron expressions, tool identifiers, or internal validation wording to the user. If a requested capability is unavailable, say that capability is currently limited or unsupported and offer the nearest supported choice through the appropriate UI tool.",
    "Never treat unrelated prose as a valid requirement answer. Never silently assume a connector, trigger, schedule, source, template, stable input, or review policy.",
    "The user may explicitly choose no source or no template only when the requirement allows it; persist that choice through resolveBuildRequirement.",
    "Always show build-contract warnings to the user, especially explicit ungrounded or no-template choices.",
    "Call draftSpec only after resolveBuildRequirement reports readyForSpecDraft true.",
    "Never call draftSpec before getAvailableTools. Never invent or search for tools outside getAvailableTools.",
    "After calling draftSpec, explain the draft briefly and immediately call interactivePrompt in the same turn to present a choice to the user: 'Approve spec' (recommended, with value 'Approve the spec') and 'Refine the spec'. Do not wait for the user to manually type or request approval in prose.",
    "When the user requests spec approval (such as selecting 'Approve spec'), call approveSpec. After approval succeeds, immediately call generateWorkflowGraph without asking for another approval.",
    "If generateWorkflowGraph fails (e.g., times out) and the session is in the 'failed' phase, you can retry generateWorkflowGraph in a subsequent turn because the spec is still approved. Prefer retrying once before asking the user what to do.",
    "Use refineSpec for feedback about the behavioral contract and refineWorkflowGraph for feedback about an existing graph.",
    "After calling generateWorkflowGraph, explain the result briefly and immediately call interactivePrompt in the same turn to present the next steps: 'Save workflow' (recommended), 'Refine the graph', and 'Archive and start over'. Do not wait for prose feedback or wait for the user to explicitly request saving/archiving.",
    "After saveWorkflow succeeds, explain that the workflow is unscheduled in verifying state and immediately present 'Run verification' via interactivePrompt.",
    "After runVerification succeeds, present its evidence and failures. Only when status is awaiting_confirmation, present 'Confirm and activate' via interactivePrompt. Call confirmActivation only from that explicit selection.",
    "Never output a bulleted, numbered, or formatted list of options or actions the user can take in your prose text response. If you have choices, next steps, or decisions to offer, you must present them via interactivePrompt.",
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

async function requireSessionForSpec(req: AuthRequest, specId: string) {
  const session = await findWorkflowBuilderSessionBySpec(req.authContext!, specId);
  if (!session) throw new Error("A workflow builder session correlated to this spec is required");
  return session;
}

function proposalSessionId(proposal: unknown): string | null {
  if (!proposal || typeof proposal !== "object") return null;
  const definition = (proposal as { definition?: unknown }).definition;
  if (!definition || typeof definition !== "object") return null;
  const builderMeta = (definition as { builderMeta?: unknown }).builderMeta;
  if (!builderMeta || typeof builderMeta !== "object") return null;
  const value = (builderMeta as { workflowBuilderSessionId?: unknown }).workflowBuilderSessionId;
  return typeof value === "string" ? value : null;
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

    // Persist the incoming messages immediately so the user's turns survive
    // page reloads or stream interruptions before onFinish runs.
    await replaceWorkflowBuilderMessages(req.authContext!, sessionId, messages);

    const tools = analyzerTools(req.authContext!, sessionId);
    const openai = createOpenAI({
      apiKey: process.env.TALLEI_LLM__OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    });
    const system = await buildAnalyzerSystemPrompt(req.authContext!, session);
    const result = streamText({
      model: openai(loopBuilderOpenAiModel()),
      system,
      messages: await convertToModelMessages(messages, { tools }),
      tools,
      stopWhen: stepCountIs(10),
      onError: ({ error }) => console.error("Loop builder analyzer stream failed:", error),
    });
    const stream = createUIMessageStream({
      originalMessages: messages,
      execute: async ({ writer }) => {
        writer.write({ type: "data-session", data: { sessionId }, transient: true });
        writer.merge(result.toUIMessageStream({ originalMessages: messages, sendReasoning: true }));
      },
      onFinish: async ({ messages: completedMessages }) => {
        await replaceWorkflowBuilderMessages(req.authContext!, sessionId, completedMessages);
      },
      onError: (error) => error instanceof Error ? error.message : String(error),
    });
    pipeUIMessageStreamToResponse({ response: res, stream });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : /not available|requires|required|not found/i.test(error instanceof Error ? error.message : "") ? 409 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Failed to process builder chat" });
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
        normalizedIntent: {
          outcome: body.prompt,
          toolCategories: [],
          cadence: "As needed",
          approvalModel: "Operator approval before external mutations",
          runtimeInputs: [],
        },
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
  try {
    const body = z.object({ sessionId: z.string().uuid() }).parse(req.body ?? {});
    const command = await dispatchWorkflowBuilderCommand({ auth: req.authContext!, sessionId: body.sessionId, toolName: "draftSpec", input: {} });
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to draft loop spec";
    res.status(error instanceof z.ZodError ? 409 : /not available|required/i.test(message) ? 409 : 500).json({ error: message });
  }
});

router.post("/specs/:specId/refine", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const specId = z.string().uuid().parse(req.params.specId);
    const body = z.object({ feedback: z.string().trim().min(1).max(5000) }).parse(req.body ?? {});
    const session = await requireSessionForSpec(req, specId);
    const command = await dispatchWorkflowBuilderCommand({ auth: req.authContext!, sessionId: session.id, toolName: "refineSpec", input: body });
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refine loop spec";
    res.status(error instanceof z.ZodError ? 400 : /required|not available/i.test(message) ? 409 : 500).json({ error: message });
  }
});

router.post("/specs/:specId/approve", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const specId = z.string().uuid().parse(req.params.specId);
    const body = z.object({ bodyMarkdown: z.string().optional(), specJson: z.unknown().optional() }).parse(req.body ?? {});
    const session = await requireSessionForSpec(req, specId);
    const command = await dispatchWorkflowBuilderCommand({ auth: req.authContext!, sessionId: session.id, toolName: "approveSpec", input: { ...body, approved: true } });
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to approve loop spec";
    res.status(error instanceof z.ZodError ? 400 : /required|not available/i.test(message) ? 409 : 500).json({ error: message });
  }
});

router.post("/specs/:specId/archive", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const specId = z.string().uuid().parse(req.params.specId);
    const session = await requireSessionForSpec(req, specId);
    const command = await dispatchWorkflowBuilderCommand({ auth: req.authContext!, sessionId: session.id, toolName: "archiveSpec", input: { approved: true } });
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to archive loop spec";
    res.status(/required|not available/i.test(message) ? 409 : 500).json({ error: message });
  }
});

router.post("/specs/:specId/generate", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const specId = z.string().uuid().parse(req.params.specId);
    const session = await requireSessionForSpec(req, specId);
    const command = await dispatchWorkflowBuilderCommand({ auth: req.authContext!, sessionId: session.id, toolName: "generateWorkflowGraph", input: {} });
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate workflow graph";
    res.status(error instanceof z.ZodError ? 400 : /required|not available/i.test(message) ? 409 : 500).json({ error: message });
  }
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

router.post("/propose", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = promptCompatibilitySchema.parse(req.body ?? {});
    const session = body.sessionId
      ? await requireWorkflowBuilderSession(req.authContext!, body.sessionId)
      : body.specId ? await requireSessionForSpec(req, body.specId) : null;
    if (!session) throw new Error("A correlated workflow builder session is required");
    const command = await dispatchWorkflowBuilderCommand({ auth: req.authContext!, sessionId: session.id, toolName: "generateWorkflowGraph", input: {} });
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to propose workflow";
    res.status(error instanceof z.ZodError ? 400 : 409).json({ error: message });
  }
});

router.post("/refine", requireScopes(["memory:read"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = promptCompatibilitySchema.parse(req.body ?? {});
    const sessionId = body.sessionId ?? proposalSessionId(body.priorProposal);
    if (!sessionId) throw new Error("A correlated workflow builder session is required");
    const command = await dispatchWorkflowBuilderCommand({
      auth: req.authContext!, sessionId, toolName: "refineWorkflowGraph",
      input: { feedback: body.feedback ?? body.prompt },
    });
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refine workflow";
    res.status(error instanceof z.ZodError ? 400 : 409).json({ error: message });
  }
});

router.post("/save", requireScopes(["memory:write"]), async (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({
      sessionId: z.string().uuid().optional(),
      proposal: z.unknown(),
      cron: z.string().optional(),
      timezone: z.string().optional(),
      workspaceId: z.string().uuid().nullable().optional(),
    }).parse(req.body ?? {});
    const sessionId = body.sessionId ?? proposalSessionId(body.proposal);
    if (!sessionId) throw new Error("A correlated workflow builder session is required");
    const command = await dispatchWorkflowBuilderCommand({
      auth: req.authContext!, sessionId, toolName: "saveWorkflow",
      input: { cron: body.cron, timezone: body.timezone, workspaceId: body.workspaceId, approved: true },
    });
    res.status(202).json(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save workflow";
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

export default router;
