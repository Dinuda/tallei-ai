import { createHash } from "node:crypto";
import OpenAI from "openai";
import { config } from "../config.js";
import { browserFallbackCache } from "./browserFallbackCache.js";
import type { OnboardingCheckpoint, OnboardingSession, OnboardingState } from "./claudeOnboarding.js";

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
    objective: "Create or open project named 'chatgpt memory'.",
    selectors: ["a[href*='/projects']", "button", "input", "textarea"],
    expectedSignal: "Project 'chatgpt memory' is open",
  },
  instructions_applied: {
    state: "instructions_applied",
    objective: "Apply project custom instructions for ChatGPT memory sync behavior.",
    selectors: ["textarea", "[contenteditable='true']", "button"],
    expectedSignal: "Instruction editor contains expected template text",
  },
  verified: {
    state: "verified",
    objective: "Verify connector, project name, and instruction template hash.",
    selectors: ["body", "main"],
    expectedSignal: "All verification checks passed",
  },
};

class LlmFallbackPlanner {
  private readonly openai = new OpenAI({ apiKey: config.openaiApiKey });

  async buildInstruction(input: {
    state: Exclude<OnboardingState, "queued">;
    lastError: string;
    sessionId: string;
    objective: string;
    expectedSignal: string;
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

    const response = await this.openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      max_output_tokens: 120,
    });

    const text = (response.output_text || "").trim();
    const instruction = text || `Recover ${input.state}: navigate to the relevant Claude page, re-run objective, verify expected signal.`;
    const { signature } = await browserFallbackCache.put(input.state, input.lastError, instruction);

    return {
      instruction,
      source: "llm",
      errorSignature: signature,
    };
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function getExpectedInstructionsHash(): string {
  return sha256(config.claudeProjectInstructionsTemplate);
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
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.browserWorkerApiKey
          ? { Authorization: `Bearer ${config.browserWorkerApiKey}` }
          : {}),
      },
      body: JSON.stringify({
        mode: input.mode,
        sessionId: input.session.id,
        state: input.state,
        projectName: input.session.projectName,
        expectedInstructionsHash: getExpectedInstructionsHash(),
        expectedInstructionSnippet: "recall_memories|save_memory",
        instruction: input.instruction,
        attempt: input.attempt,
      }),
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
    return data;
  }

  private simulate(input: {
    mode: ExecutionMode;
    session: OnboardingSession;
    state: Exclude<OnboardingState, "queued">;
    instruction: StudentPolicyInstruction;
    attempt: number;
  }): WorkerResponse {
    if (input.state === "claude_authenticated" && input.session.metadata.authCompleted !== true) {
      return {
        status: "checkpoint",
        checkpoint: {
          type: "auth",
          blockedState: "claude_authenticated",
          message: "Cloud browser session requires user login confirmation in Claude.",
          resumeHint: "Complete login/MFA in checkpoint UI, then call resume.",
        },
      };
    }

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
