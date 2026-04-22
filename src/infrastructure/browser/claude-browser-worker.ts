import {
  HyperAgent,
} from "@hyperbrowser/agent";
import type {
  ActionCacheOutput,
  ActionCacheReplayResult,
  ActionOutput,
  AgentActionDefinition,
} from "@hyperbrowser/agent/types";
import { z } from "zod4";
import { createHash } from "node:crypto";
import { config } from "../../config/index.js";
import type {
  OnboardingCheckpoint,
  OnboardingState,
} from "../../orchestration/browser/run-automation.usecase.js";

type ExecutionMode = "student";
type ActiveState = Exclude<OnboardingState, "queued">;
type HyperPage = Awaited<ReturnType<HyperAgent<"Hyperbrowser">["newPage"]>>;

type CacheDiagnostics = {
  cacheReplayUsed?: boolean;
  cacheReplayFallback?: boolean;
  replayStatus?: string;
  replaySteps?: number;
  aiUnavailable?: boolean;
  aiUnavailableReason?: string;
};

export interface BrowserWorkerExecuteRequest {
  mode: ExecutionMode;
  sessionId: string;
  state: ActiveState;
  projectName: string;
  authCompleted?: boolean;
  applyProjectInstructions?: boolean;
  projectInstructions?: string;
  expectedInstructionsHash?: string;
  expectedInstructionSnippet?: string;
  hyperAgentActionCacheByState?: Record<string, unknown>;
  attempt: number;
  instruction: {
    state: ActiveState;
    objective: string;
    selectors: string[];
    expectedSignal: string;
  };
}

export type BrowserWorkerExecuteResponse =
  | { status: "ok"; output?: Record<string, unknown> }
  | { status: "checkpoint"; checkpoint: OnboardingCheckpoint; output?: Record<string, unknown> }
  | { status: "error"; error: string; output?: Record<string, unknown> };

type StepPayload = {
  success: boolean;
  nextState?: string;
  needsHuman?: boolean;
  checkpointType?: "auth" | "manual_review";
  checkpointMessage?: string;
  resumeHint?: string;
  observedUrl?: string;
  observedTitle?: string;
  projectPresent?: boolean;
  connectorConnected?: boolean;
  instructionsApplied?: boolean;
  instructionsHash?: string | null;
  verificationNotes?: string[];
};

type SessionRecord = {
  agent: HyperAgent<"Hyperbrowser">;
  page: HyperPage;
  actionCacheByState: Partial<Record<ActiveState, ActionCacheOutput>>;
  liveUrl?: string;
  createdAt: number;
  lastSeenAt: number;
};

const DEFAULT_HYPERAGENT_MODEL = "gpt-4o";
const COMPLEX_STATES: ActiveState[] = [
  "connector_connected",
  "project_upserted",
  "instructions_applied",
  "verified",
];

function now(): number {
  return Date.now();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeText(value: string | undefined | null): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

function isInvalidApiKeyError(error: unknown): boolean {
  if (!error) return false;
  const text =
    error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : typeof error === "string"
      ? error
      : JSON.stringify(error);
  return /invalid_api_key|incorrect api key provided|authenticationerror/i.test(text);
}

function shouldApplyProjectInstructions(input: BrowserWorkerExecuteRequest): boolean {
  if (typeof input.applyProjectInstructions === "boolean") {
    return input.applyProjectInstructions;
  }
  return true;
}

function buildInstructionChecks(input: BrowserWorkerExecuteRequest): {
  expectedHash: string;
  snippets: string[];
} {
  const expectedHash = normalizeText(input.expectedInstructionsHash);
  const snippets = normalizeText(input.expectedInstructionSnippet)
    .toLowerCase()
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  return { expectedHash, snippets };
}

function extractCacheDiagnostics(result?: ActionCacheReplayResult): CacheDiagnostics {
  if (!result) return { cacheReplayUsed: false };
  return {
    cacheReplayUsed: true,
    replayStatus: result.status,
    replaySteps: Array.isArray(result.steps) ? result.steps.length : 0,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActionCacheOutput(value: unknown): value is ActionCacheOutput {
  if (!isObject(value)) return false;
  if (typeof value.taskId !== "string") return false;
  if (typeof value.createdAt !== "string") return false;
  if (!Array.isArray(value.steps)) return false;
  return true;
}

function parseActionCacheMap(raw: unknown): Partial<Record<ActiveState, ActionCacheOutput>> {
  if (!isObject(raw)) return {};

  const out: Partial<Record<ActiveState, ActionCacheOutput>> = {};
  for (const state of COMPLEX_STATES) {
    const candidate = raw[state];
    if (isActionCacheOutput(candidate)) {
      out[state] = candidate;
    }
  }
  return out;
}

function serializeActionCacheMap(
  map: Partial<Record<ActiveState, ActionCacheOutput>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const state of COMPLEX_STATES) {
    const candidate = map[state];
    if (candidate) out[state] = candidate;
  }
  return out;
}

function mergePayload(primary: StepPayload, secondary: StepPayload | null): StepPayload {
  if (!secondary) return primary;
  return {
    success: primary.success,
    nextState: primary.nextState ?? secondary.nextState,
    needsHuman: primary.needsHuman ?? secondary.needsHuman,
    checkpointType: primary.checkpointType ?? secondary.checkpointType,
    checkpointMessage: primary.checkpointMessage ?? secondary.checkpointMessage,
    resumeHint: primary.resumeHint ?? secondary.resumeHint,
    observedUrl: primary.observedUrl ?? secondary.observedUrl,
    observedTitle: primary.observedTitle ?? secondary.observedTitle,
    projectPresent: primary.projectPresent ?? secondary.projectPresent,
    connectorConnected: primary.connectorConnected ?? secondary.connectorConnected,
    instructionsApplied: primary.instructionsApplied ?? secondary.instructionsApplied,
    instructionsHash: primary.instructionsHash ?? secondary.instructionsHash,
    verificationNotes: [
      ...(primary.verificationNotes ?? []),
      ...(secondary.verificationNotes ?? []),
    ],
  };
}

function toActionOutput(payload: StepPayload): ActionOutput {
  return {
    success: payload.success,
    message: JSON.stringify(payload),
    extract: payload,
  };
}

async function waitStable(page: HyperPage, ms = 900): Promise<void> {
  await page.waitForTimeout(ms).catch(() => {});
}

async function safeTitle(page: HyperPage): Promise<string | undefined> {
  try {
    return await page.title();
  } catch {
    return undefined;
  }
}

async function safeBodyText(page: HyperPage): Promise<string> {
  try {
    const text = await page.textContent("body");
    return text ?? "";
  } catch {
    return "";
  }
}

async function isVisible(page: HyperPage, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible();
  } catch {
    return false;
  }
}

async function clickRoleByName(
  page: HyperPage,
  role: "button" | "link",
  patterns: RegExp[],
): Promise<boolean> {
  for (const pattern of patterns) {
    const target = page.getByRole(role, { name: pattern }).first();
    try {
      if (await target.isVisible({ timeout: 1000 })) {
        await target.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // Continue trying other patterns.
    }
  }
  return false;
}

async function clickAnyByName(page: HyperPage, patterns: RegExp[]): Promise<boolean> {
  if (await clickRoleByName(page, "button", patterns)) return true;
  if (await clickRoleByName(page, "link", patterns)) return true;
  return false;
}

async function fillFirstVisible(page: HyperPage, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const target = page.locator(selector).first();
    try {
      if (await target.isVisible({ timeout: 700 })) {
        await target.fill(value, { timeout: 5000 });
        return true;
      }
    } catch {
      // Continue trying other selectors.
    }
  }
  return false;
}

async function ensureClaudeConnectorsOpen(page: HyperPage): Promise<StepPayload> {
  try {
    await page.goto("https://claude.ai/settings/connectors", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await waitStable(page);
  } catch {
    // Fall through to URL/title checks.
  }

  const observedUrl = page.url();
  const observedTitle = await safeTitle(page);
  const success = /claude\.ai\/settings\/connectors/i.test(observedUrl);

  return {
    success,
    needsHuman: !success,
    checkpointType: "manual_review",
    checkpointMessage: success
      ? undefined
      : "Could not open Claude connectors automatically.",
    resumeHint: success
      ? undefined
      : "Open Claude connectors in the live browser session and continue.",
    observedUrl,
    observedTitle,
    verificationNotes: ["Ran ensure_claude_connectors_open custom action."],
  };
}

async function detectConnectorConnected(page: HyperPage, connectorName: string): Promise<boolean> {
  const body = (await safeBodyText(page)).toLowerCase();
  const namePresent = body.includes(connectorName.toLowerCase());
  const connectedSignal = /(connected|active|enabled|authorized|on\b)/i.test(body);
  return namePresent && connectedSignal;
}

async function ensureTalleiConnectorConnected(
  page: HyperPage,
  connectorName: string,
  connectorUrl: string,
): Promise<StepPayload> {
  const open = await ensureClaudeConnectorsOpen(page);
  if (!open.success) {
    return open;
  }

  if (await detectConnectorConnected(page, connectorName)) {
    return {
      success: true,
      needsHuman: false,
      connectorConnected: true,
      observedUrl: page.url(),
      observedTitle: await safeTitle(page),
      verificationNotes: ["Connector already connected."],
    };
  }

  await clickAnyByName(page, [
    /add custom connector/i,
    /add connector/i,
    /new connector/i,
    /create connector/i,
  ]);

  await fillFirstVisible(page, [
    "input[placeholder*='name' i]",
    "input[name*='name' i]",
    "input[type='text']",
  ], connectorName);

  await fillFirstVisible(page, [
    "input[type='url']",
    "input[placeholder*='mcp' i]",
    "input[placeholder*='url' i]",
    "input[name*='url' i]",
  ], connectorUrl);

  await clickAnyByName(page, [
    /save/i,
    /create/i,
    /add/i,
    /continue/i,
  ]);

  await clickAnyByName(page, [
    /^connect$/i,
    /connect connector/i,
    /authorize/i,
    /allow/i,
    /enable/i,
    /reconnect/i,
  ]);

  await waitStable(page, 1400);
  const connected = await detectConnectorConnected(page, connectorName);

  if (connected) {
    return {
      success: true,
      needsHuman: false,
      connectorConnected: true,
      observedUrl: page.url(),
      observedTitle: await safeTitle(page),
      verificationNotes: ["Connector connected automatically."],
    };
  }

  return {
    success: false,
    needsHuman: true,
    checkpointType: "manual_review",
    checkpointMessage: "Connector setup needs approval or manual confirmation.",
    resumeHint:
      "In the live session, open Claude connectors, complete Connect/OAuth for Tallei Memory, then resume.",
    connectorConnected: false,
    observedUrl: page.url(),
    observedTitle: await safeTitle(page),
    verificationNotes: ["Automatic connector setup incomplete."],
  };
}

async function ensureProjectOpen(page: HyperPage, projectName: string): Promise<StepPayload> {
  try {
    await page.goto("https://claude.ai/projects", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await waitStable(page);
  } catch {
    // Continue with best-effort checks.
  }

  const projectRegex = new RegExp(`^${projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const existing = page.getByText(projectRegex).first();
  try {
    if (await existing.isVisible({ timeout: 1200 })) {
      await existing.click({ timeout: 6000 });
      await waitStable(page);
    }
  } catch {
    await clickAnyByName(page, [/new project/i, /create project/i, /^new$/i]);
    await fillFirstVisible(page, [
      "input[placeholder*='project' i]",
      "input[name*='project' i]",
      "input[type='text']",
    ], projectName);
    await clickAnyByName(page, [/create/i, /save/i, /continue/i]);
    await waitStable(page, 1200);
  }

  await clickAnyByName(page, [/project settings/i, /^settings$/i]);
  await waitStable(page, 900);

  const body = (await safeBodyText(page)).toLowerCase();
  const projectPresent = body.includes(projectName.toLowerCase()) || /\/projects/.test(page.url());

  if (!projectPresent) {
    return {
      success: false,
      needsHuman: true,
      checkpointType: "manual_review",
      checkpointMessage: `Project '${projectName}' could not be opened automatically.`,
      resumeHint:
        `In the live session, open/create project '${projectName}', then resume to continue configuration.`,
      projectPresent: false,
      observedUrl: page.url(),
      observedTitle: await safeTitle(page),
    };
  }

  return {
    success: true,
    needsHuman: false,
    projectPresent: true,
    observedUrl: page.url(),
    observedTitle: await safeTitle(page),
    verificationNotes: ["Project is open."],
  };
}

async function readInstructionsText(page: HyperPage): Promise<string> {
  const textarea = page.locator("textarea").first();
  try {
    if (await textarea.isVisible({ timeout: 900 })) {
      return (await textarea.inputValue()).trim();
    }
  } catch {
    // Try contenteditable next.
  }

  const editable = page.locator("[contenteditable='true']").first();
  try {
    if (await editable.isVisible({ timeout: 900 })) {
      return (await editable.innerText()).trim();
    }
  } catch {
    // Fall back to body text.
  }

  return (await safeBodyText(page)).trim();
}

async function applyProjectInstructions(
  page: HyperPage,
  projectName: string,
  template: string,
  expectedHash: string,
  snippets: string[],
): Promise<StepPayload> {
  const project = await ensureProjectOpen(page, projectName);
  if (!project.success) {
    return project;
  }

  await clickAnyByName(page, [
    /instructions/i,
    /custom instructions/i,
    /edit instructions/i,
  ]);
  await waitStable(page, 900);

  const wroteTextarea = await fillFirstVisible(page, ["textarea"], template);
  if (!wroteTextarea) {
    const editable = page.locator("[contenteditable='true']").first();
    try {
      if (await editable.isVisible({ timeout: 800 })) {
        await editable.click({ timeout: 4000 });
        await page.keyboard.press("Meta+A").catch(() => page.keyboard.press("Control+A"));
        await page.keyboard.type(template, { delay: 0 });
      }
    } catch {
      // Keep going and verify below.
    }
  }

  await clickAnyByName(page, [/save/i, /done/i, /update/i, /apply/i]);
  await waitStable(page, 1100);

  const text = await readInstructionsText(page);
  const normalized = normalizeText(text);
  const actualHash = normalized.length > 0 ? sha256(normalized) : null;
  const lower = normalized.toLowerCase();
  const snippetMatch = snippets.length === 0 || snippets.every((s) => lower.includes(s));
  const hashMatch = expectedHash.length === 0 || actualHash === expectedHash;
  const success = Boolean(actualHash) && snippetMatch && hashMatch;

  if (!success) {
    return {
      success: false,
      needsHuman: true,
      checkpointType: "manual_review",
      checkpointMessage: "Project instructions could not be verified automatically.",
      resumeHint:
        "In the live session, open project instructions, paste/save the template, then resume.",
      instructionsApplied: false,
      instructionsHash: actualHash,
      observedUrl: page.url(),
      observedTitle: await safeTitle(page),
      verificationNotes: [
        `Hash match: ${hashMatch}`,
        `Snippet match: ${snippetMatch}`,
      ],
    };
  }

  return {
    success: true,
    needsHuman: false,
    instructionsApplied: true,
    instructionsHash: actualHash,
    observedUrl: page.url(),
    observedTitle: await safeTitle(page),
  };
}

async function verifyOnboardingState(page: HyperPage, args: {
  projectName: string;
  connectorName: string;
  shouldVerifyInstructions: boolean;
  expectedHash: string;
  snippets: string[];
}): Promise<StepPayload> {
  const project = await ensureProjectOpen(page, args.projectName);
  if (!project.success) {
    return {
      ...project,
      projectPresent: false,
      connectorConnected: false,
      instructionsApplied: false,
    };
  }

  const connector = await ensureTalleiConnectorConnected(page, args.connectorName, config.claudeConnectorMcpUrl);
  if (!connector.success) {
    return {
      ...connector,
      projectPresent: true,
      connectorConnected: false,
      instructionsApplied: false,
    };
  }

  if (!args.shouldVerifyInstructions) {
    return {
      success: true,
      needsHuman: false,
      projectPresent: true,
      connectorConnected: true,
      instructionsApplied: true,
      observedUrl: page.url(),
      observedTitle: await safeTitle(page),
      verificationNotes: ["Instructions verification skipped by configuration."],
    };
  }

  const text = await readInstructionsText(page);
  const normalized = normalizeText(text);
  const hash = normalized.length > 0 ? sha256(normalized) : null;
  const lower = normalized.toLowerCase();
  const hashMatch = args.expectedHash.length === 0 || hash === args.expectedHash;
  const snippetMatch = args.snippets.length === 0 || args.snippets.every((s) => lower.includes(s));
  const matched = Boolean(hash) && hashMatch && snippetMatch;

  if (!matched) {
    return {
      success: false,
      needsHuman: true,
      checkpointType: "manual_review",
      checkpointMessage: "Final verification failed for project, connector, or instructions.",
      resumeHint:
        "In the live session, verify connector + project + instructions, then resume for re-check.",
      projectPresent: true,
      connectorConnected: true,
      instructionsApplied: false,
      instructionsHash: hash,
      observedUrl: page.url(),
      observedTitle: await safeTitle(page),
      verificationNotes: [
        `Instruction hash match: ${hashMatch}`,
        `Instruction snippet match: ${snippetMatch}`,
      ],
    };
  }

  return {
    success: true,
    needsHuman: false,
    projectPresent: true,
    connectorConnected: true,
    instructionsApplied: true,
    instructionsHash: hash,
    observedUrl: page.url(),
    observedTitle: await safeTitle(page),
  };
}

function createOnboardingCustomActions(): AgentActionDefinition[] {
  const ensureConnectorsOpenAction = {
    type: "ensure_claude_connectors_open",
    actionParams: z.object({}).describe("Open Claude connectors page and verify current URL/title."),
    run: async (ctx: { page: unknown }): Promise<ActionOutput> => {
      const payload = await ensureClaudeConnectorsOpen(ctx.page as HyperPage);
      return toActionOutput(payload);
    },
  };

  const ensureConnectorConnectedAction = {
    type: "ensure_tallei_connector_connected",
    actionParams: z.object({
      connectorName: z.string().describe("Connector display name."),
      connectorUrl: z.string().describe("Connector MCP URL."),
    }).describe("Ensure Tallei Memory connector exists and is connected in Claude."),
    run: async (
      ctx: { page: unknown },
      params: { connectorName: string; connectorUrl: string },
    ): Promise<ActionOutput> => {
      const payload = await ensureTalleiConnectorConnected(
        ctx.page as HyperPage,
        params.connectorName,
        params.connectorUrl,
      );
      return toActionOutput(payload);
    },
  };

  const ensureProjectOpenAction = {
    type: "ensure_project_open",
    actionParams: z.object({
      projectName: z.string().describe("Claude project name to open or create."),
    }).describe("Ensure target Claude project exists and is open."),
    run: async (ctx: { page: unknown }, params: { projectName: string }): Promise<ActionOutput> => {
      const payload = await ensureProjectOpen(ctx.page as HyperPage, params.projectName);
      return toActionOutput(payload);
    },
  };

  const applyProjectInstructionsAction = {
    type: "apply_project_instructions",
    actionParams: z.object({
      projectName: z.string().describe("Claude project name."),
      instructions: z.string().describe("Instructions template to apply."),
      expectedHash: z.string().describe("Expected SHA256 hash for saved instructions, or empty string."),
      snippets: z.array(z.string()).describe("Expected snippets to validate. Pass [] when none."),
    }).describe("Apply and verify Claude project custom instructions."),
    run: async (
      ctx: { page: unknown },
      params: {
        projectName: string;
        instructions: string;
        expectedHash: string;
        snippets: string[];
      },
    ): Promise<ActionOutput> => {
      const payload = await applyProjectInstructions(
        ctx.page as HyperPage,
        params.projectName,
        params.instructions,
        params.expectedHash,
        Array.isArray(params.snippets) ? params.snippets : [],
      );
      return toActionOutput(payload);
    },
  };

  const verifyOnboardingStateAction = {
    type: "verify_onboarding_state",
    actionParams: z.object({
      projectName: z.string().describe("Project name to verify."),
      connectorName: z.string().describe("Connector name."),
      expectedHash: z.string().describe("Expected instructions hash, or empty string."),
      snippets: z.array(z.string()).describe("Expected instruction snippets. Pass [] when none."),
      shouldVerifyInstructions: z.boolean().describe("Whether instruction verification is required."),
    }).describe("Verify project, connector, and instructions configuration."),
    run: async (
      ctx: { page: unknown },
      params: {
        projectName: string;
        connectorName: string;
        expectedHash: string;
        snippets: string[];
        shouldVerifyInstructions: boolean;
      },
    ): Promise<ActionOutput> => {
      const payload = await verifyOnboardingState(ctx.page as HyperPage, {
        projectName: params.projectName,
        connectorName: params.connectorName,
        shouldVerifyInstructions: params.shouldVerifyInstructions,
        expectedHash: params.expectedHash,
        snippets: Array.isArray(params.snippets) ? params.snippets : [],
      });
      return toActionOutput(payload);
    },
  };

  return [
    ensureConnectorsOpenAction,
    ensureConnectorConnectedAction,
    ensureProjectOpenAction,
    applyProjectInstructionsAction,
    verifyOnboardingStateAction,
  ] as unknown as AgentActionDefinition[];
}

class HyperbrowserClaudeWorkerService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly locks = new Map<string, Promise<void>>();

  async execute(input: BrowserWorkerExecuteRequest): Promise<BrowserWorkerExecuteResponse> {
    return this.withSessionLock(input.sessionId, async () => {
      try {
        const session = await this.getOrCreateSession(input);
        session.actionCacheByState = {
          ...session.actionCacheByState,
          ...parseActionCacheMap(input.hyperAgentActionCacheByState),
        };
        const result = await this.runState(session, input);
        session.lastSeenAt = now();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown HyperAgent worker error";
        const existing = this.sessions.get(input.sessionId);
        if (existing) {
          this.syncLiveUrl(existing);
        }

        if (isInvalidApiKeyError(error)) {
          return {
            status: "checkpoint",
            checkpoint: {
              type: "manual_review",
              blockedState: input.state,
              message: "Automation AI actions are unavailable due to invalid OpenAI API key.",
              resumeHint:
                "Continue this step manually in the live session, then click Resume. Also fix TALLEI_LLM__OPENAI_API_KEY.",
              ...(existing?.liveUrl ? { actionUrl: existing.liveUrl } : {}),
            },
            output: {
              state: input.state,
              mode: input.mode,
              liveSessionUrl: existing?.liveUrl,
              hyperAgentActionCacheByState: serializeActionCacheMap(
                existing?.actionCacheByState ?? {},
              ),
              aiUnavailable: true,
              aiUnavailableReason: "invalid_api_key",
            },
          };
        }

        return {
          status: "error",
          error: message,
          output: {
            state: input.state,
            mode: input.mode,
            liveSessionUrl: existing?.liveUrl,
            hyperAgentActionCacheByState: serializeActionCacheMap(
              existing?.actionCacheByState ?? {},
            ),
          },
        };
      }
    });
  }

  async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await session.agent.closeAgent();
    } catch {
      // best-effort cleanup
    }

    this.sessions.delete(sessionId);
  }

  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    let release = () => {};

    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(sessionId, prior.then(() => current));

    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(sessionId) === current) {
        this.locks.delete(sessionId);
      }
    }
  }

  private resolveOpenAiKey(): string {
    const key = config.openaiApiKey || process.env.OPENAI_API_KEY || "";
    const trimmed = key.trim();
    if (!trimmed) {
      throw new Error("OpenAI API key is required for HyperAgent onboarding (TALLEI_LLM__OPENAI_API_KEY)");
    }
    return trimmed;
  }

  private resolveOpenAiModel(): string {
    const configured = (config.openaiModel || "").trim();
    if (configured.toLowerCase().startsWith("gpt-")) return configured;
    return DEFAULT_HYPERAGENT_MODEL;
  }

  private syncLiveUrl(session: SessionRecord): void {
    const active = session.agent.getSession();
    if (!active || typeof active !== "object") return;

    const raw = (active as unknown as Record<string, unknown>).liveUrl;
    if (typeof raw === "string" && raw.trim().length > 0) {
      session.liveUrl = raw;
    }
  }

  private async getOrCreateSession(input: BrowserWorkerExecuteRequest): Promise<SessionRecord> {
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      this.syncLiveUrl(existing);
      return existing;
    }

    const hyperbrowserApiKey = config.hyperbrowserApiKey.trim();
    if (!hyperbrowserApiKey) {
      throw new Error("TALLEI_BROWSER__HYPERBROWSER_API_KEY is required for HyperAgent onboarding worker");
    }

    const agent = new HyperAgent({
      browserProvider: "Hyperbrowser",
      llm: {
        provider: "openai",
        model: this.resolveOpenAiModel(),
        apiKey: this.resolveOpenAiKey(),
      },
      hyperbrowserConfig: {
        config: {
          apiKey: hyperbrowserApiKey,
        },
      },
      customActions: createOnboardingCustomActions(),
      // CDP actions are noisy and brittle when remote pages are frequently re-created/closed.
      // Disable for onboarding flow stability; we rely on perform/ai + custom actions.
      cdpActions: false,
    });

    const page = await agent.newPage();
    const session: SessionRecord = {
      agent,
      page,
      actionCacheByState: parseActionCacheMap(input.hyperAgentActionCacheByState),
      createdAt: now(),
      lastSeenAt: now(),
    };

    this.syncLiveUrl(session);
    this.sessions.set(input.sessionId, session);
    return session;
  }

  private async runState(
    session: SessionRecord,
    input: BrowserWorkerExecuteRequest,
  ): Promise<BrowserWorkerExecuteResponse> {
    switch (input.state) {
      case "browser_started":
        return this.handleBrowserStarted(session, input);
      case "claude_authenticated":
        return this.handleClaudeAuthenticated(session, input);
      case "connector_connected":
        return this.handleConnectorConnected(session, input);
      case "project_upserted":
        return this.handleProjectUpserted(session, input);
      case "instructions_applied":
        return this.handleInstructionsApplied(session, input);
      case "verified":
        return this.handleVerified(session, input);
      default:
        return { status: "error", error: `Unsupported state ${input.state}` };
    }
  }

  private commonOutput(
    input: BrowserWorkerExecuteRequest,
    patch?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      state: input.state,
      mode: input.mode,
      liveSessionUrl: patch?.["liveSessionUrl"] ?? patch?.["actionUrl"],
      ...patch,
    };
  }

  private sessionMetadataPatch(session: SessionRecord): Record<string, unknown> {
    this.syncLiveUrl(session);
    return {
      liveSessionUrl: session.liveUrl,
      hyperAgentActionCacheByState: serializeActionCacheMap(session.actionCacheByState),
    };
  }

  private async tryReplay(
    session: SessionRecord,
    state: ActiveState,
  ): Promise<{ replay?: ActionCacheReplayResult; diagnostics: CacheDiagnostics }> {
    const cached = session.actionCacheByState[state];
    if (!cached) return { diagnostics: { cacheReplayUsed: false } };

    try {
      const replay = await session.page.runFromActionCache(cached, {
        maxXPathRetries: 3,
        debug: false,
      });
      const diagnostics = extractCacheDiagnostics(replay);
      return { replay, diagnostics };
    } catch {
      return {
        diagnostics: {
          cacheReplayUsed: true,
          cacheReplayFallback: true,
          replayStatus: "failed",
        },
      };
    }
  }

  private async runAiTask(
    session: SessionRecord,
    args: {
      state: ActiveState;
      task: string;
      maxSteps?: number;
      useCache?: boolean;
    },
  ): Promise<{
    payloadFromAi: StepPayload | null;
    diagnostics: CacheDiagnostics;
  }> {
    let diagnostics: CacheDiagnostics = { cacheReplayUsed: false };

    if (args.useCache) {
      const replayResult = await this.tryReplay(session, args.state);
      diagnostics = replayResult.diagnostics;
      if (replayResult.replay?.status === "completed") {
        return { payloadFromAi: null, diagnostics };
      }
      if (diagnostics.cacheReplayUsed) {
        diagnostics.cacheReplayFallback = true;
      }
    }

    let aiResult:
      | {
          output?: unknown;
          actionCache?: ActionCacheOutput;
        }
      | undefined;

    try {
      aiResult = await session.page.ai(args.task, {
        maxSteps: args.maxSteps ?? 20,
        useDomCache: true,
        enableVisualMode: true,
      });
    } catch (error) {
      if (!isInvalidApiKeyError(error)) {
        throw error;
      }

      return {
        payloadFromAi: null,
        diagnostics: {
          ...diagnostics,
          aiUnavailable: true,
          aiUnavailableReason: "invalid_api_key",
        },
      };
    }

    if (args.useCache && aiResult.actionCache && Array.isArray(aiResult.actionCache.steps)) {
      session.actionCacheByState[args.state] = aiResult.actionCache;
    }

    const payloadFromAi = this.extractStructuredPayload(aiResult.output);
    return { payloadFromAi, diagnostics };
  }

  private async handleBrowserStarted(
    session: SessionRecord,
    input: BrowserWorkerExecuteRequest,
  ): Promise<BrowserWorkerExecuteResponse> {
    await session.page.goto("https://claude.ai/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    }).catch(() => {});
    await waitStable(session.page);

    const observedUrl = session.page.url();
    const observedTitle = await safeTitle(session.page);
    const success =
      observedUrl !== "about:blank" &&
      /https?:\/\/(?:www\.)?claude\.ai(?:\/|$)/i.test(observedUrl);
    const metadata = this.sessionMetadataPatch(session);

    if (!success) {
      return this.toCheckpoint(session, input, {
        type: "manual_review",
        message: "Browser opened but page did not navigate from about:blank.",
        resumeHint: "In live session, open https://claude.ai/ and resume.",
        output: this.commonOutput(input, {
          ...metadata,
          url: observedUrl,
          title: observedTitle,
        }),
      });
    }

    return {
      status: "ok",
      output: this.commonOutput(input, {
        ...metadata,
        url: observedUrl,
        title: observedTitle,
      }),
    };
  }

  private async handleClaudeAuthenticated(
    session: SessionRecord,
    input: BrowserWorkerExecuteRequest,
  ): Promise<BrowserWorkerExecuteResponse> {
    if (input.authCompleted) {
      const metadata = this.sessionMetadataPatch(session);
      return {
        status: "ok",
        output: this.commonOutput(input, {
          ...metadata,
          authenticated: true,
          verification: "user_confirmed_resume",
        }),
      };
    }

    await session.page.goto("https://claude.ai/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    }).catch(() => {});
    await waitStable(session.page);

    await clickAnyByName(session.page, [
      /^log ?in$/i,
      /^sign ?in$/i,
      /continue with email/i,
      /^continue$/i,
    ]).catch(() => {});

    await waitStable(session.page, 1000);

    const authSignals = input.instruction.selectors.length > 0
      ? input.instruction.selectors
      : ["main", "[data-testid='user-menu']", "a[href*='/settings']"];

    let shellVisible = false;
    for (const selector of authSignals) {
      if (await isVisible(session.page, selector)) {
        shellVisible = true;
        break;
      }
    }

    const body = (await safeBodyText(session.page)).toLowerCase();
    const loginVisible =
      /\b(log ?in|sign ?in|password|passkey|mfa|verification code)\b/.test(body) &&
      !/\bproject settings\b/.test(body);

    const metadata = this.sessionMetadataPatch(session);
    if (!shellVisible || loginVisible) {
      return this.toCheckpoint(session, input, {
        type: "auth",
        message: "Claude login or MFA is required.",
        resumeHint:
          "Complete login/MFA in the live browser session. The flow will auto-resume once done.",
        output: this.commonOutput(input, {
          ...metadata,
          authenticated: false,
          url: session.page.url(),
          title: await safeTitle(session.page),
        }),
      });
    }

    return {
      status: "ok",
      output: this.commonOutput(input, {
        ...metadata,
        authenticated: true,
        url: session.page.url(),
        title: await safeTitle(session.page),
      }),
    };
  }

  private async handleConnectorConnected(
    session: SessionRecord,
    input: BrowserWorkerExecuteRequest,
  ): Promise<BrowserWorkerExecuteResponse> {
    const { payloadFromAi, diagnostics } = await this.runAiTask(session, {
      state: input.state,
      useCache: true,
      maxSteps: 24,
      task: [
        "Open Claude connectors and connect the Tallei connector.",
        "Use custom action ensure_tallei_connector_connected with connectorName='Tallei Memory' and connectorUrl provided.",
        `Connector URL: ${config.claudeConnectorMcpUrl}`,
        "If OAuth or approval requires the user, mark needsHuman=true and include a clear checkpoint message.",
        "Return only JSON in the final answer.",
      ].join(" "),
    });

    const verified = await ensureTalleiConnectorConnected(
      session.page,
      "Tallei Memory",
      config.claudeConnectorMcpUrl,
    );
    const payload = mergePayload(verified, payloadFromAi);
    const metadata = this.sessionMetadataPatch(session);

    if (!payload.success) {
      return this.toCheckpoint(session, input, {
        type: payload.checkpointType || "manual_review",
        message:
          payload.checkpointMessage ||
          "Connector setup needs manual confirmation.",
        resumeHint:
          payload.resumeHint ||
          "In live session, complete connector connect/OAuth, then resume.",
        output: this.commonOutput(input, {
          ...metadata,
          connected: false,
          connectorConnected: false,
          url: payload.observedUrl,
          title: payload.observedTitle,
          ...diagnostics,
        }),
      });
    }

    return {
      status: "ok",
      output: this.commonOutput(input, {
        ...metadata,
        connected: true,
        connectorConnected: true,
        url: payload.observedUrl,
        title: payload.observedTitle,
        ...diagnostics,
      }),
    };
  }

  private async handleProjectUpserted(
    session: SessionRecord,
    input: BrowserWorkerExecuteRequest,
  ): Promise<BrowserWorkerExecuteResponse> {
    const { payloadFromAi, diagnostics } = await this.runAiTask(session, {
      state: input.state,
      useCache: true,
      maxSteps: 24,
      task: [
        `Ensure Claude project '${input.projectName}' exists and is open.`,
        "Use custom action ensure_project_open with the project name.",
        "If blocked, mark needsHuman=true with clear checkpoint message.",
        "Return only JSON in the final answer.",
      ].join(" "),
    });

    const verified = await ensureProjectOpen(session.page, input.projectName);
    const payload = mergePayload(verified, payloadFromAi);
    const metadata = this.sessionMetadataPatch(session);

    if (!payload.success) {
      return this.toCheckpoint(session, input, {
        type: payload.checkpointType || "manual_review",
        message:
          payload.checkpointMessage ||
          `Project '${input.projectName}' could not be opened automatically.`,
        resumeHint:
          payload.resumeHint ||
          `Open/create project '${input.projectName}' in live session, then resume.`,
        output: this.commonOutput(input, {
          ...metadata,
          projectPresent: false,
          ...diagnostics,
        }),
      });
    }

    return {
      status: "ok",
      output: this.commonOutput(input, {
        ...metadata,
        upsert: "done",
        projectPresent: true,
        url: payload.observedUrl,
        title: payload.observedTitle,
        ...diagnostics,
      }),
    };
  }

  private async handleInstructionsApplied(
    session: SessionRecord,
    input: BrowserWorkerExecuteRequest,
  ): Promise<BrowserWorkerExecuteResponse> {
    const metadata = this.sessionMetadataPatch(session);

    if (!shouldApplyProjectInstructions(input)) {
      return {
        status: "ok",
        output: this.commonOutput(input, {
          ...metadata,
          instructionsApplied: false,
          instructionsSource: "skipped",
        }),
      };
    }

    const template = normalizeText(input.projectInstructions) || normalizeText(config.claudeProjectInstructionsTemplate);
    const { expectedHash, snippets } = buildInstructionChecks(input);
    const hashToMatch = expectedHash || sha256(template);

    const { payloadFromAi, diagnostics } = await this.runAiTask(session, {
      state: input.state,
      useCache: true,
      maxSteps: 28,
      task: [
        `Configure project '${input.projectName}' custom instructions exactly with the provided template.`,
        "Use custom action apply_project_instructions with projectName, instructions, expectedHash, and snippets.",
        `Expected hash: ${hashToMatch}`,
        snippets.length > 0 ? `Expected snippets: ${snippets.join(" | ")}` : "",
        "If blocked, mark needsHuman=true with a precise checkpoint reason.",
        "Return only JSON in the final answer.",
      ].filter(Boolean).join(" "),
    });

    const verified = await applyProjectInstructions(
      session.page,
      input.projectName,
      template,
      hashToMatch,
      snippets,
    );
    const payload = mergePayload(verified, payloadFromAi);

    if (!payload.success) {
      return this.toCheckpoint(session, input, {
        type: payload.checkpointType || "manual_review",
        message: payload.checkpointMessage || "Project instructions require manual confirmation.",
        resumeHint:
          payload.resumeHint ||
          "In live session, set/save instructions template, then resume.",
        output: this.commonOutput(input, {
          ...metadata,
          instructionsApplied: false,
          instructionsHash: payload.instructionsHash ?? null,
          verificationNotes: payload.verificationNotes ?? [],
          ...diagnostics,
        }),
      });
    }

    return {
      status: "ok",
      output: this.commonOutput(input, {
        ...metadata,
        instructionsApplied: true,
        instructionsSource: "hyperagent",
        instructionsHash: payload.instructionsHash ?? hashToMatch,
        verificationNotes: payload.verificationNotes ?? [],
        ...diagnostics,
      }),
    };
  }

  private async handleVerified(
    session: SessionRecord,
    input: BrowserWorkerExecuteRequest,
  ): Promise<BrowserWorkerExecuteResponse> {
    const { expectedHash, snippets } = buildInstructionChecks(input);

    const { payloadFromAi, diagnostics } = await this.runAiTask(session, {
      state: input.state,
      useCache: true,
      maxSteps: 22,
      task: [
        `Verify onboarding for project '${input.projectName}'.`,
        "Use custom action verify_onboarding_state with projectName, connectorName='Tallei Memory', expectedHash, snippets, shouldVerifyInstructions.",
        `Expected hash: ${expectedHash || "(none)"}`,
        snippets.length > 0 ? `Expected snippets: ${snippets.join(" | ")}` : "",
        "Return only JSON in the final answer.",
      ].filter(Boolean).join(" "),
    });

    const verified = await verifyOnboardingState(session.page, {
      projectName: input.projectName,
      connectorName: "Tallei Memory",
      shouldVerifyInstructions: shouldApplyProjectInstructions(input),
      expectedHash,
      snippets,
    });
    const payload = mergePayload(verified, payloadFromAi);
    const metadata = this.sessionMetadataPatch(session);

    if (!payload.success) {
      return this.toCheckpoint(session, input, {
        type: payload.checkpointType || "manual_review",
        message:
          payload.checkpointMessage ||
          "Final verification failed for project, connector, or instructions.",
        resumeHint:
          payload.resumeHint ||
          "In live session, verify/fix setup and resume for automatic re-check.",
        output: this.commonOutput(input, {
          ...metadata,
          projectPresent: payload.projectPresent,
          connectorConnected: payload.connectorConnected,
          instructionsMatched: false,
          instructionHash: payload.instructionsHash ?? null,
          expectedInstructionsHash: expectedHash || null,
          verificationNotes: payload.verificationNotes ?? [],
          ...diagnostics,
        }),
      });
    }

    return {
      status: "ok",
      output: this.commonOutput(input, {
        ...metadata,
        verified: true,
        projectPresent: payload.projectPresent ?? true,
        connectorConnected: payload.connectorConnected ?? true,
        instructionsMatched: true,
        instructionHash: payload.instructionsHash ?? null,
        verificationNotes: payload.verificationNotes ?? [],
        ...diagnostics,
      }),
    };
  }

  private extractStructuredPayload(raw: unknown): StepPayload | null {
    if (raw == null) return null;
    const queue: unknown[] = [raw];
    const seen = new Set<object>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (current == null) continue;

      const parsed = this.tryParseStepPayload(current);
      if (parsed) return parsed;

      if (typeof current === "string") {
        const trimmed = current.trim();
        if (!trimmed) continue;

        try {
          queue.push(JSON.parse(trimmed));
          continue;
        } catch {
          // keep scanning for fenced/embedded JSON blocks.
        }

        const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
        for (const match of trimmed.matchAll(fenced)) {
          if (!match[1]) continue;
          try {
            queue.push(JSON.parse(match[1]));
          } catch {
            // Ignore parse errors.
          }
        }

        const firstBrace = trimmed.indexOf("{");
        const lastBrace = trimmed.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          const block = trimmed.slice(firstBrace, lastBrace + 1);
          try {
            queue.push(JSON.parse(block));
          } catch {
            // Ignore parse errors.
          }
        }
        continue;
      }

      if (Array.isArray(current)) {
        for (const item of current) queue.push(item);
        continue;
      }

      if (typeof current === "object") {
        if (seen.has(current)) continue;
        seen.add(current);
        for (const value of Object.values(current as Record<string, unknown>)) {
          queue.push(value);
        }
      }
    }

    return null;
  }

  private tryParseStepPayload(value: unknown): StepPayload | null {
    if (!isObject(value)) return null;
    if (typeof value.success !== "boolean") return null;

    const checkpointType =
      value.checkpointType === "auth" || value.checkpointType === "manual_review"
        ? value.checkpointType
        : undefined;

    return {
      success: value.success,
      nextState: typeof value.nextState === "string" ? value.nextState : undefined,
      needsHuman: typeof value.needsHuman === "boolean" ? value.needsHuman : undefined,
      checkpointType,
      checkpointMessage:
        typeof value.checkpointMessage === "string" ? value.checkpointMessage : undefined,
      resumeHint: typeof value.resumeHint === "string" ? value.resumeHint : undefined,
      observedUrl: typeof value.observedUrl === "string" ? value.observedUrl : undefined,
      observedTitle: typeof value.observedTitle === "string" ? value.observedTitle : undefined,
      projectPresent:
        typeof value.projectPresent === "boolean" ? value.projectPresent : undefined,
      connectorConnected:
        typeof value.connectorConnected === "boolean" ? value.connectorConnected : undefined,
      instructionsApplied:
        typeof value.instructionsApplied === "boolean" ? value.instructionsApplied : undefined,
      instructionsHash:
        typeof value.instructionsHash === "string" || value.instructionsHash === null
          ? value.instructionsHash
          : undefined,
      verificationNotes: Array.isArray(value.verificationNotes)
        ? value.verificationNotes.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  }

  private toCheckpoint(
    session: SessionRecord,
    input: BrowserWorkerExecuteRequest,
    args: {
      type: "auth" | "manual_review";
      message: string;
      resumeHint: string;
      output?: Record<string, unknown>;
    },
  ): BrowserWorkerExecuteResponse {
    this.syncLiveUrl(session);
    return {
      status: "checkpoint",
      checkpoint: {
        type: args.type,
        blockedState: input.state,
        message: args.message,
        resumeHint: args.resumeHint,
        actionUrl: session.liveUrl,
      },
      output: {
        ...args.output,
        liveSessionUrl: session.liveUrl,
        hyperAgentActionCacheByState: serializeActionCacheMap(session.actionCacheByState),
      },
    };
  }
}

export const claudeBrowserWorkerService = new HyperbrowserClaudeWorkerService();
