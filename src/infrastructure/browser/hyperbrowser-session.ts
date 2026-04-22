import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import { config } from "../../config/index.js";
import type { SessionDetail } from "@hyperbrowser/sdk/types";

type HyperbrowserClient = {
  sessions: {
    create: () => Promise<SessionDetail>;
    stop: (id: string) => Promise<unknown>;
  };
};

export interface HyperbrowserSessionRuntime {
  hyperbrowserSessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  liveUrl: string;
}

let cachedApiKey = "";
let cachedClient: HyperbrowserClient | null = null;

function getClient(): HyperbrowserClient {
  const apiKey = config.hyperbrowserApiKey;
  if (!apiKey) {
    throw new Error("TALLEI_BROWSER__HYPERBROWSER_API_KEY is not configured");
  }

  if (cachedClient && cachedApiKey === apiKey) {
    return cachedClient;
  }

  cachedApiKey = apiKey;
  cachedClient = new Hyperbrowser({ apiKey }) as unknown as HyperbrowserClient;
  return cachedClient;
}

export async function createHyperbrowserSession(): Promise<HyperbrowserSessionRuntime> {
  const client = getClient();
  const session = await client.sessions.create();

  const hyperbrowserSessionId = session.id;
  const wsEndpoint = session.wsEndpoint;
  const liveUrl = session.liveUrl ?? "";

  if (!hyperbrowserSessionId || !wsEndpoint || !liveUrl) {
    throw new Error("Hyperbrowser session response missing id/wsEndpoint/liveUrl");
  }

  const browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    hyperbrowserSessionId,
    browser,
    context,
    page,
    liveUrl,
  };
}

export async function stopHyperbrowserSession(id: string): Promise<void> {
  try {
    const client = getClient();
    await client.sessions.stop(id);
  } catch {
    // best-effort shutdown
  }
}
