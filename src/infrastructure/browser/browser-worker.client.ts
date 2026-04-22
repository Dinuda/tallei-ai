import { createHash } from "node:crypto";
import { config } from "../../config/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import { browserFallbackCache } from "./browser-fallback-cache.js";
import { flowTemplateStore } from "./flow-template-store.js";
import type { OnboardingActionState } from "./flow-template-store.types.js";
import type { OnboardingCheckpoint, OnboardingSession, OnboardingState } from "../../orchestration/browser/claude-onboarding.types.js";

type ExecutionMode = "student" | "llm_fallback";

type WorkerStatus = "ok" | "checkpoint" | "error";

interface WorkerResponse {
  status: WorkerStatus;
  output?: Record<string, unknown>;
  error?: string;
  checkpoint?: OnboardingCheckpoint;
}

interface StudentPolicyInstruction {
  state: Exclude<OnboardingState, "queued">;
  objective: string;
  selectors: string[];
  expectedSignal: string;
}

export type BrowserExecutionResult =
  | { kind: "ok"; metadataPatch?: Record<string, unknown>; diagnostics?: Record<string, unknown> }
  | { kind: "checkpoint"; checkpoint: OnboardingCheckpoint; metadataPatch?: Record<string, unknown>; diagnostics?: Record<string, unknown> }
  | { kind: "error"; message: string; diagnostics?: Record<string, unknown> };

const STUDENT_POLICY: Record<Exclude<OnboardingState, "queued">, StudentPolicyInstruction> = {
  browser_started: {
    state: "browser_started",
    objective: "Open claude.ai in the cloud browser context.",
    selectors: ["body", "main", "nav"],
    expectedSignal: "Claude landing page is visible",
  },
  claude_authenticated: {
    state: "claude_authenticated",
    objective: "Confirm user is authenticated in Claude account context.",
    selectors: ["[data-testid='user-menu']", "[aria-label='Account menu']", "a[href*='/settings']"],
    expectedSignal: "Authenticated account shell is visible",
  },
  connector_connected: {
    state: "connector_connected",
    objective: "Ensure Tallei connector is added and connected in Claude connectors settings.",
    selectors: ["a[href*='/settings/connectors']", "button", "input[type='url']"],
    expectedSignal: "Tallei connector shows connected/active state",
  },
  project_upserted: {
    state: "project_upserted",
    objective: "Create or open the configured Claude project.",
    selectors: ["a[href*='/projects']", "button", "input", "textarea"],
    expectedSignal: "Configured Claude project is open",
  },
  instructions_applied: {
    state: "instructions_applied",
    objective: "Apply project custom instructions for Tallei memory behavior.",
    selectors: ["textarea", "[contenteditable='true']", "button"],
    expectedSignal: "Instruction editor contains the expected Tallei template",
  },
  verified: {
    state: "verified",
    objective: "Verify connector, project name, and instruction configuration (when enabled).",
    selectors: ["body", "main"],
    expectedSignal: "All verification checks passed",
  },
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function shouldApplyProjectInstructions(session: OnboardingSession): boolean {
  const value = session.metadata["applyProjectInstructions"];
  if (typeof value === "boolean") return value;
  return true;
}

function getProjectInstructions(session: OnboardingSession): string | undefined {
  const raw = session.metadata["projectInstructions"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getExpectedInstructionsHash(session: OnboardingSession): string | undefined {
  const instructions = getProjectInstructions(session) ?? config.claudeProjectInstructionsTemplate;
  const normalized = instructions.trim();
  return normalized.length > 0 ? sha256(normalized) : undefined;
}

function normalizeCheckpoint(value: unknown): OnboardingCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const type = typeof raw.type === "string" ? raw.type : null;
  const blockedState =
    typeof raw.blockedState === "string"
      ? raw.blockedState
      : typeof raw.blocked_state === "string"
      ? raw.blocked_state
      : null;
  const message = typeof raw.message === "string" ? raw.message : null;
  const resumeHint =
    typeof raw.resumeHint === "string"
      ? raw.resumeHint
      : typeof raw.resume_hint === "string"
      ? raw.resume_hint
      : null;
  const actionUrl =
    typeof raw.actionUrl === "string"
      ? raw.actionUrl
      : typeof raw.action_url === "string"
      ? raw.action_url
      : undefined;

  if (!type || !blockedState || !message || !resumeHint) return null;
  if (type !== "auth" && type !== "captcha" && type !== "manual_review") return null;
  if (
    blockedState !== "browser_started" &&
    blockedState !== "claude_authenticated" &&
    blockedState !== "connector_connected" &&
    blockedState !== "project_upserted" &&
    blockedState !== "instructions_applied" &&
    blockedState !== "verified"
  ) {
    return null;
  }

  return {
    type,
    blockedState,
    message,
    resumeHint,
    ...(actionUrl ? { actionUrl } : {}),
  };
}

class LlmFallbackPlanner {
  async buildInstruction(input: {
    state: Exclude<OnboardingState, "queued">;
    lastError: string;
    sessionId: string;
    objective: string;
    expectedSignal: string;
    useCheapModel?: boolean;
  }): Promise<{ instruction: string; source: "cache" | "llm"; errorSignature: string }> {
    const cached = await browserFallbackCache.get(input.state, input.lastError);
    if (cached) {
      await browserFallbackCache.recordHit(input.state, cached.signature);
      return {
        instruction: cached.instruction,
        source: "cache",
        errorSignature: cached.signature,
      };
    }

    const prompt = [
      "You are a browser automation recovery planner.",
      "Return a concise fallback instruction for a Playwright-like worker.",
      "Keep under 90 words.",
      `State: ${input.state}`,
      `Objective: ${input.objective}`,
      `Expected signal: ${input.expectedSignal}`,
      `Last error: ${input.lastError}`,
      `Session: ${input.sessionId}`,
      "Instruction:",
    ].join("\n");

    const response = await aiProviderRegistry.chat({
      model: input.useCheapModel
        ? "gpt-4o-mini"
        : aiProviderRegistry.chatModelName(),
      messages: [
        { role: "system", content: "You are a browser automation recovery planner." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 140,
    });

    const text = response.text.trim();
    const instruction = text || `Recover ${input.state}: navigate to the relevant Claude page, re-run objective, verify expected signal.`;
    const { signature } = await browserFallbackCache.put(input.state, input.lastError, instruction);

    return {
      instruction,
      source: "llm",
      errorSignature: signature,
    };
  }
}

class CloudBrowserWorkerClient {
  private readonly planner = new LlmFallbackPlanner();

  private get enabled(): boolean {
    return config.browserWorkerBaseUrl.length > 0;
  }

  async execute(
    session: OnboardingSession,
    state: Exclude<OnboardingState, "queued">
  ): Promise<BrowserExecutionResult> {
    const policy = STUDENT_POLICY[state];
    const retries = Math.max(1, config.browserMaxStudentRetries);
    const isLearned = await flowTemplateStore
      .getLearnedPolicy(state as OnboardingActionState)
      .then(t => t?.isLearned ?? false)
      .catch(() => false);

    const attemptErrors: string[] = [];
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const workerResult = await this.dispatch({
        mode: "student",
        session,
        state,
        instruction: policy,
        attempt,
      });

      if (workerResult.status === "ok") {
        return {
          kind: "ok",
          metadataPatch: workerResult.output,
          diagnostics: { mode: "student", attempts: attempt },
        };
      }

      if (workerResult.status === "checkpoint" && workerResult.checkpoint) {
        return {
          kind: "checkpoint",
          checkpoint: workerResult.checkpoint,
          metadataPatch: workerResult.output,
          diagnostics: { mode: "student", attempts: attempt },
        };
      }

      attemptErrors.push(workerResult.error || "Unknown student execution error");
    }

    if (!config.browserLlmFallbackEnabled) {
      return {
        kind: "error",
        message: `Student policy failed after ${retries} attempts: ${attemptErrors.join(" | ")}`,
        diagnostics: { mode: "student", attempts: retries, errors: attemptErrors },
      };
    }

    const fallbackPlan = await this.planner.buildInstruction({
      state,
      lastError: attemptErrors[attemptErrors.length - 1] || "Unknown error",
      sessionId: session.id,
      objective: policy.objective,
      expectedSignal: policy.expectedSignal,
      useCheapModel: isLearned,
    });

    const fallbackResult = await this.dispatch({
      mode: "llm_fallback",
      session,
      state,
      instruction: {
        state,
        objective: fallbackPlan.instruction,
        selectors: [],
        expectedSignal: policy.expectedSignal,
      },
      attempt: 1,
    });

    if (fallbackResult.status === "ok") {
      return {
        kind: "ok",
        metadataPatch: fallbackResult.output,
        diagnostics: {
          mode: "llm_fallback",
          studentErrors: attemptErrors,
          fallbackSource: fallbackPlan.source,
          fallbackErrorSignature: fallbackPlan.errorSignature,
        },
      };
    }

    if (fallbackResult.status === "checkpoint" && fallbackResult.checkpoint) {
      return {
        kind: "checkpoint",
        checkpoint: fallbackResult.checkpoint,
        metadataPatch: fallbackResult.output,
        diagnostics: {
          mode: "llm_fallback",
          studentErrors: attemptErrors,
          fallbackSource: fallbackPlan.source,
          fallbackErrorSignature: fallbackPlan.errorSignature,
        },
      };
    }

    return {
      kind: "error",
      message: `Fallback failed: ${fallbackResult.error || "Unknown fallback error"}`,
      diagnostics: {
        mode: "llm_fallback",
        studentErrors: attemptErrors,
        fallbackSource: fallbackPlan.source,
        fallbackErrorSignature: fallbackPlan.errorSignature,
        fallbackError: fallbackResult.error || "Unknown fallback error",
      },
    };
  }

  private async dispatch(input: {
    mode: ExecutionMode;
    session: OnboardingSession;
    state: Exclude<OnboardingState, "queued">;
    instruction: StudentPolicyInstruction;
    attempt: number;
  }): Promise<WorkerResponse> {
    if (!this.enabled) {
      return this.simulate(input);
    }

    const url = new URL("/api/browser-use/claude-onboarding/execute", config.browserWorkerBaseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(5_000, config.browserWorkerRequestTimeoutMs));
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.browserWorkerApiKey
          ? { Authorization: `Bearer ${config.browserWorkerApiKey}` }
          : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        mode: input.mode,
        sessionId: input.session.id,
        state: input.state,
        projectName: input.session.projectName,
        authCompleted: input.session.metadata.authCompleted === true,
        applyProjectInstructions: shouldApplyProjectInstructions(input.session),
        projectInstructions: getProjectInstructions(input.session),
        expectedInstructionsHash: shouldApplyProjectInstructions(input.session) ? getExpectedInstructionsHash(input.session) : undefined,
        expectedInstructionSnippet: shouldApplyProjectInstructions(input.session) ? "tallei memory + document tools|remember" : undefined,
        instruction: input.instruction,
        attempt: input.attempt,
      }),
    }).catch((error) => {
      const isAbort =
        error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message));
      if (isAbort) {
        return {
          ok: false,
          status: 504,
          async json() {
            return { error: "Worker request timed out" };
          },
          async text() {
            return "Worker request timed out";
          },
        } as Response;
      }
      throw error;
    }).finally(() => {
      clearTimeout(timeout);
    });

    if (!res.ok) {
      let detail = "";
      try {
        const parsed = await res.json() as { error?: string };
        detail = parsed?.error ? `: ${parsed.error}` : "";
      } catch {
        try {
          const txt = await res.text();
          if (txt) detail = `: ${txt.slice(0, 160)}`;
        } catch {}
      }
      return {
        status: "error",
        error: `Worker HTTP ${res.status}${detail}`,
      };
    }

    const data = (await res.json()) as WorkerResponse;
    if (!data?.status) {
      return { status: "error", error: "Malformed worker response" };
    }
    if (data.status === "checkpoint") {
      const checkpoint = normalizeCheckpoint(data.checkpoint);
      if (!checkpoint) {
        return { status: "error", error: "Malformed checkpoint response from worker" };
      }
      return { ...data, checkpoint };
    }
    return data;
  }

  private simulate(input: {
    mode: ExecutionMode;
    session: OnboardingSession;
    state: Exclude<OnboardingState, "queued">;
    instruction: StudentPolicyInstruction;
    attempt: number;
  }): WorkerResponse {
    return {
      status: "error",
      error:
        "Browser worker is not configured (TALLEI_BROWSER__WORKER_BASE_URL missing). Live user-visible browser sessions are required for onboarding checkpoints.",
    };

    // Unreachable in strict mode; kept for compatibility if simulation is reintroduced.
    return {
      status: "ok",
      output: {
        browserMode: input.mode,
        simulated: true,
        lastCompletedState: input.state,
        lastAttempt: input.attempt,
        lastExpectedSignal: input.instruction.expectedSignal,
      },
    };
  }
}

export const cloudBrowserWorker = new CloudBrowserWorkerClient();
