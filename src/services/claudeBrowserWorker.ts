import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { config } from "../config.js";
import type { OnboardingCheckpoint, OnboardingState } from "./claudeOnboarding.js";

type ExecutionMode = "student" | "llm_fallback";

export interface BrowserWorkerExecuteRequest {
  mode: ExecutionMode;
  sessionId: string;
  state: Exclude<OnboardingState, "queued">;
  projectName: string;
  expectedInstructionsHash?: string;
  expectedInstructionSnippet?: string;
  attempt: number;
  instruction: {
    state: Exclude<OnboardingState, "queued">;
    objective: string;
    selectors: string[];
    expectedSignal: string;
  };
}

export type BrowserWorkerExecuteResponse =
  | { status: "ok"; output?: Record<string, unknown> }
  | { status: "checkpoint"; checkpoint: OnboardingCheckpoint; output?: Record<string, unknown> }
  | { status: "error"; error: string; output?: Record<string, unknown> };

type RuntimeSession = {
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastSeenAt: number;
};

function now(): number {
  return Date.now();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function containsWords(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.every(word => lower.includes(word.toLowerCase()));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class ClaudeBrowserWorkerService {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => {
      void this.sweepExpiredSessions();
    }, Math.min(60000, Math.max(5000, Math.floor(config.browserSessionTtlMs / 3))));
    this.sweepTimer.unref();
  }

  async execute(input: BrowserWorkerExecuteRequest): Promise<BrowserWorkerExecuteResponse> {
    return this.withSessionLock(input.sessionId, async () => {
      let result = await this.executeOnce(input);
      if (result.status === "error" && this.isClosedRuntimeError(result.error)) {
        await this.disposeSession(input.sessionId);
        result = await this.executeOnce(input);
      }
      return result;
    });
  }

  private async executeOnce(input: BrowserWorkerExecuteRequest): Promise<BrowserWorkerExecuteResponse> {
    const runtime = await this.getOrCreateSession(input.sessionId);
    if ("error" in runtime) {
      return { status: "error", error: runtime.error };
    }

    try {
      const result = await this.runState(runtime, input);
      runtime.lastSeenAt = now();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker error";
      return { status: "error", error: message };
    }
  }

  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(sessionId) || Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>(resolve => {
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

  private async getOrCreateSession(sessionId: string): Promise<RuntimeSession | { error: string }> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      const browserConnected = existing.browser.isConnected();
      const pageOpen = !existing.page.isClosed();
      if (browserConnected && pageOpen) {
        existing.lastSeenAt = now();
        return existing;
      }
      await this.disposeSession(sessionId);
    }

    if (!config.browserWorkerWsEndpoint) {
      return {
        error:
          "BROWSER_WORKER_WS_ENDPOINT is not configured. Point it to your cloud Chromium/CDP endpoint.",
      };
    }

    try {
      const browser = await chromium.connectOverCDP(config.browserWorkerWsEndpoint);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());

      const runtime: RuntimeSession = {
        sessionId,
        browser,
        context,
        page,
        createdAt: now(),
        lastSeenAt: now(),
      };
      this.sessions.set(sessionId, runtime);
      return runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect Playwright over CDP";
      return { error: message };
    }
  }

  private async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      await session.context.close();
    } catch {}
    try {
      await session.browser.close();
    } catch {}
    this.sessions.delete(sessionId);
  }

  private isClosedRuntimeError(message: string): boolean {
    const m = message.toLowerCase();
    return (
      m.includes("target page, context or browser has been closed") ||
      m.includes("browser has been closed") ||
      m.includes("context has been closed") ||
      m.includes("page has been closed")
    );
  }

  private async runState(
    runtime: RuntimeSession,
    input: BrowserWorkerExecuteRequest
  ): Promise<BrowserWorkerExecuteResponse> {
    switch (input.state) {
      case "browser_started":
        return this.handleBrowserStarted(runtime, input);
      case "claude_authenticated":
        return this.handleClaudeAuthenticated(runtime, input);
      case "connector_connected":
        return this.handleConnectorConnected(runtime, input);
      case "project_upserted":
        return this.handleProjectUpserted(runtime, input);
      case "instructions_applied":
        return this.handleInstructionsApplied(runtime, input);
      case "verified":
        return this.handleVerified(runtime, input);
      default:
        return { status: "error", error: `Unsupported state ${input.state}` };
    }
  }

  private async handleBrowserStarted(
    runtime: RuntimeSession,
    input: BrowserWorkerExecuteRequest
  ): Promise<BrowserWorkerExecuteResponse> {
    await runtime.page.goto("https://claude.ai/", { waitUntil: "domcontentloaded", timeout: 45000 });
    return {
      status: "ok",
      output: {
        mode: input.mode,
        state: input.state,
        url: runtime.page.url(),
        title: await runtime.page.title(),
      },
    };
  }

  private async handleClaudeAuthenticated(
    runtime: RuntimeSession,
    input: BrowserWorkerExecuteRequest
  ): Promise<BrowserWorkerExecuteResponse> {
    const page = runtime.page;
    await page.goto("https://claude.ai/", { waitUntil: "domcontentloaded", timeout: 45000 });

    const auth = await this.detectAuthenticated(page, input.instruction.selectors);
    if (!auth) {
      const liveUrl = await this.getLiveSessionUrl(page);
      return {
        status: "checkpoint",
        checkpoint: {
          type: "auth",
          blockedState: "claude_authenticated",
          message: "Claude login/MFA confirmation needed in cloud browser session.",
          resumeHint: liveUrl
            ? "Open the live cloud browser session, complete Claude login/MFA, then press resume in Tallei."
            : "Complete login in the cloud browser checkpoint UI and then press resume in Tallei.",
          actionUrl: liveUrl || undefined,
        },
        output: {
          state: input.state,
          mode: input.mode,
          url: page.url(),
        },
      };
    }

    return {
      status: "ok",
      output: {
        state: input.state,
        mode: input.mode,
        authenticated: true,
        url: page.url(),
      },
    };
  }

  private async handleConnectorConnected(
    runtime: RuntimeSession,
    input: BrowserWorkerExecuteRequest
  ): Promise<BrowserWorkerExecuteResponse> {
    const page = runtime.page;
    await page.goto("https://claude.ai/settings/connectors", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    const connectedInitially = await this.detectConnectorConnected(page);
    if (connectedInitially) {
      return {
        status: "ok",
        output: { state: input.state, mode: input.mode, connected: true, via: "existing" },
      };
    }

    await this.tryClickByText(page, [/add custom connector/i, /add connector/i, /add/i]);
    const urlInput = page.locator("input[type='url'], input[placeholder*='https'], input[name*='url']").first();
    if ((await urlInput.count()) > 0) {
      await urlInput.fill(config.claudeConnectorMcpUrl);
      await this.tryClickByText(page, [/save/i, /add/i, /create/i, /continue/i]);
      await page.waitForTimeout(1200);
    }

    await this.tryClickByText(page, [/connect/i, /authorize/i]);
    await page.waitForTimeout(1200);

    const connectedAfter = await this.detectConnectorConnected(page);
    if (connectedAfter) {
      return {
        status: "ok",
        output: { state: input.state, mode: input.mode, connected: true, via: "created" },
      };
    }

    const liveUrl = await this.getLiveSessionUrl(page);
    return {
      status: "checkpoint",
      checkpoint: {
        type: "manual_review",
        blockedState: "connector_connected",
        message: "Connector setup needs confirmation in Claude UI.",
        resumeHint: liveUrl
          ? "Open the live cloud browser session, verify Tallei connector is connected (OAuth complete), then resume onboarding."
          : "Verify Tallei connector is connected (OAuth complete), then resume onboarding.",
        actionUrl: liveUrl || undefined,
      },
      output: {
        state: input.state,
        mode: input.mode,
        expectedMcpUrl: config.claudeConnectorMcpUrl,
      },
    };
  }

  private async handleProjectUpserted(
    runtime: RuntimeSession,
    input: BrowserWorkerExecuteRequest
  ): Promise<BrowserWorkerExecuteResponse> {
    const page = runtime.page;
    await page.goto("https://claude.ai/projects", { waitUntil: "domcontentloaded", timeout: 45000 });

    const projectRegex = new RegExp(`^${escapeRegExp(input.projectName)}$`, "i");
    const existing = page.getByText(projectRegex).first();
    if (await existing.isVisible().catch(() => false)) {
      await existing.click().catch(() => {});
      return {
        status: "ok",
        output: { state: input.state, mode: input.mode, upsert: "existing" },
      };
    }

    await this.tryClickByText(page, [/new project/i, /create project/i, /^new$/i, /^create$/i]);

    const inputBox = page.locator("input[type='text'], input[placeholder*='Project'], textarea").first();
    if ((await inputBox.count()) > 0) {
      await inputBox.fill(input.projectName);
      await this.tryClickByText(page, [/create/i, /save/i, /done/i]);
      await page.waitForTimeout(1200);
    }

    const created = page.getByText(projectRegex).first();
    if (await created.isVisible().catch(() => false)) {
      await created.click().catch(() => {});
      return {
        status: "ok",
        output: { state: input.state, mode: input.mode, upsert: "created" },
      };
    }

    const liveUrl = await this.getLiveSessionUrl(page);
    return {
      status: "checkpoint",
      checkpoint: {
        type: "manual_review",
        blockedState: "project_upserted",
        message: `Project '${input.projectName}' could not be auto-created/selected.`,
        resumeHint: liveUrl
          ? "Open the live cloud browser session, create/select the project manually in Claude, then resume onboarding."
          : "Create/select the project manually in Claude, then resume onboarding.",
        actionUrl: liveUrl || undefined,
      },
      output: { state: input.state, mode: input.mode },
    };
  }

  private async handleInstructionsApplied(
    runtime: RuntimeSession,
    input: BrowserWorkerExecuteRequest
  ): Promise<BrowserWorkerExecuteResponse> {
    const page = runtime.page;
    await this.tryClickByText(page, [/instructions/i, /project settings/i, /custom instructions/i, /settings/i]);

    const textarea = page.locator("textarea").first();
    const contentEditable = page.locator("[contenteditable='true']").first();
    const template = config.claudeProjectInstructionsTemplate;

    if ((await textarea.count()) > 0) {
      await textarea.fill(template);
    } else if ((await contentEditable.count()) > 0) {
      await contentEditable.click();
      await page.keyboard.press("Meta+A").catch(async () => {
        await page.keyboard.press("Control+A").catch(() => {});
      });
      await page.keyboard.type(template);
    } else {
      const liveUrl = await this.getLiveSessionUrl(page);
      return {
        status: "checkpoint",
        checkpoint: {
          type: "manual_review",
          blockedState: "instructions_applied",
          message: "Instruction editor not found in Claude project UI.",
          resumeHint: liveUrl
            ? "Open the live cloud browser session, open project instructions, paste template, then resume onboarding."
            : "Open project instructions, paste template, then resume onboarding.",
          actionUrl: liveUrl || undefined,
        },
        output: { state: input.state, mode: input.mode },
      };
    }

    await this.tryClickByText(page, [/save/i, /done/i, /update/i]);
    await page.waitForTimeout(800);

    return {
      status: "ok",
      output: {
        state: input.state,
        mode: input.mode,
        instructionsHash: sha256(template),
      },
    };
  }

  private async handleVerified(
    runtime: RuntimeSession,
    input: BrowserWorkerExecuteRequest
  ): Promise<BrowserWorkerExecuteResponse> {
    const page = runtime.page;
    const projectPresent = await page
      .getByText(new RegExp(`^${escapeRegExp(input.projectName)}$`, "i"))
      .first()
      .isVisible()
      .catch(() => false);

    const instructionText = await this.readInstructionText(page);
    const normalizedInstruction = instructionText?.replace(/\r\n/g, "\n").trim() ?? "";
    const instructionHash = normalizedInstruction ? sha256(normalizedInstruction) : null;
    const expectedHash = input.expectedInstructionsHash?.trim() || "";
    const expectedSnippet = input.expectedInstructionSnippet?.toLowerCase().trim() || "";
    const snippetMatched = expectedSnippet
      ? normalizedInstruction.toLowerCase().includes(expectedSnippet)
      : true;
    const hashMatched = expectedHash ? instructionHash === expectedHash : true;
    const instructionsMatched = snippetMatched && hashMatched;

    await page.goto("https://claude.ai/settings/connectors", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    const connectorConnected = await this.detectConnectorConnected(page);

    if (!projectPresent || !connectorConnected || !instructionsMatched) {
      const liveUrl = await this.getLiveSessionUrl(page);
      return {
        status: "checkpoint",
        checkpoint: {
          type: "manual_review",
          blockedState: "verified",
          message: "Final verification failed for project or connector.",
          resumeHint: liveUrl
            ? "Open the live cloud browser session, confirm project + connector state manually, then resume to re-run verification."
            : "Confirm project + connector state manually, then resume to re-run verification.",
          actionUrl: liveUrl || undefined,
        },
        output: {
          state: input.state,
          mode: input.mode,
          projectPresent,
          connectorConnected,
          instructionsMatched,
          instructionHash,
          expectedInstructionsHash: expectedHash || null,
        },
      };
    }

    return {
      status: "ok",
      output: {
        state: input.state,
        mode: input.mode,
        verified: true,
        projectPresent,
        connectorConnected,
        instructionsMatched,
        instructionHash,
      },
    };
  }

  private async detectAuthenticated(page: Page, selectors: string[]): Promise<boolean> {
    if (page.url().includes("/login")) return false;
    const passwordVisible = await page.locator("input[type='password']").first().isVisible().catch(() => false);
    if (passwordVisible) return false;

    for (const selector of selectors) {
      const visible = await page.locator(selector).first().isVisible().catch(() => false);
      if (visible) return true;
    }
    return false;
  }

  private async detectConnectorConnected(page: Page): Promise<boolean> {
    const text = (await page.textContent("body").catch(() => "")) || "";
    if (!text) return false;
    const hasName = /tallei/i.test(text);
    const hasConnectedWord = /(connected|active|enabled|authorized)/i.test(text);
    return hasName && hasConnectedWord;
  }

  private async readInstructionText(page: Page): Promise<string | null> {
    const textarea = page.locator("textarea").first();
    if ((await textarea.count()) > 0) {
      const value = await textarea.inputValue().catch(() => "");
      if (value) return value;
    }

    const contentEditable = page.locator("[contenteditable='true']").first();
    if ((await contentEditable.count()) > 0) {
      const text = await contentEditable.innerText().catch(() => "");
      if (text) return text;
    }

    const bodyText = (await page.textContent("body").catch(() => "")) || "";
    if (containsWords(bodyText, ["project", "instructions"])) {
      return bodyText;
    }
    return null;
  }

  private async getLiveSessionUrl(page: Page): Promise<string | null> {
    try {
      const cdp = await page.context().newCDPSession(page);
      const live = await cdp.send("Browserless.liveURL");
      const value = (
        (live as { liveURL?: unknown }).liveURL ??
        (live as { url?: unknown }).url
      );
      if (typeof value === "string" && value.startsWith("http")) {
        return value;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async tryClickByText(page: Page, patterns: RegExp[]): Promise<boolean> {
    for (const pattern of patterns) {
      const button = page.getByRole("button", { name: pattern }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {});
        return true;
      }
      const link = page.getByRole("link", { name: pattern }).first();
      if (await link.isVisible().catch(() => false)) {
        await link.click().catch(() => {});
        return true;
      }
    }
    return false;
  }

  private async sweepExpiredSessions(): Promise<void> {
    const cutoff = now() - Math.max(10000, config.browserSessionTtlMs);
    const ids = [...this.sessions.keys()];

    for (const sessionId of ids) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      if (session.lastSeenAt > cutoff) continue;
      await this.disposeSession(sessionId);
    }
  }
}

export const claudeBrowserWorkerService = new ClaudeBrowserWorkerService();
