/**
 * agent-runner-internals.ts — Shared utilities extracted from agent-runner.ts
 * for use by the tool handler registry.
 */

import { loopExecutorOpenAiChat } from "./openai-chat.js";

export function readGatewaySearchConfig(raw: unknown) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const domainsRaw = Array.isArray(record.allowedDomains)
    ? record.allowedDomains.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    : [];
  const contextSizeRaw = typeof record.searchContextSize === "string" ? record.searchContextSize : null;
  const countryRaw = typeof record.country === "string" ? record.country : null;
  const contextSize = contextSizeRaw === "low" || contextSizeRaw === "medium" || contextSizeRaw === "high" ? contextSizeRaw : "medium";
  return {
    allowedDomains: domainsRaw.slice(0, 20),
    contextSize,
    country: countryRaw?.trim().toUpperCase() || "US",
  };
}

export function readMemorySearchConfig(raw: unknown, fallbackTask: string) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const rawLimit = typeof record.limit === "number"
    ? record.limit
    : typeof record.limit === "string"
      ? Number.parseInt(record.limit, 10)
      : Number.NaN;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(20, Math.max(1, Math.floor(rawLimit)))
    : 5;
  const configuredQuery = typeof record.query === "string" && record.query.trim()
    ? record.query.trim()
    : "";
  const query = configuredQuery || fallbackTask.slice(0, 500);
  return { query, limit };
}

function readLoopAgentTimeoutMs(): number {
  const raw = process.env.TALLEI_LOOP_EXECUTOR__AGENT_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}

async function withAbortTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>, timeoutLabel: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function runExaWebSearch(input: { goal: string; task: string; config?: Record<string, unknown> }) {
  const searchConfig = readGatewaySearchConfig(input.config);
  const exaApiKey = process.env.EXA_API_KEY?.trim() || "";
  if (!exaApiKey) throw new Error("EXA_API_KEY is required for internal.web_search.");

  const query = [input.task.trim(), "", `Goal context: ${input.goal.trim()}`, "Focus on recent, credible sources."].join("\n");
  const data = await withAbortTimeout(readLoopAgentTimeoutMs(), async (signal) => {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", "x-api-key": exaApiKey, "x-exa-integration": "tallei-loop-executor" },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 8,
        userLocation: searchConfig.country,
        includeDomains: searchConfig.allowedDomains.length > 0 ? searchConfig.allowedDomains : undefined,
        contents: { text: { maxCharacters: 1200 }, highlights: true, summary: true, livecrawl: "fallback" },
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Exa API error ${response.status}: ${body.slice(0, 500)}`);
    }
    return response.json() as Promise<{ results?: unknown[] }>;
  }, "Exa web search call");

  const results = (Array.isArray(data.results) ? data.results : [])
    .map((row) => {
      const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
      const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : "Untitled";
      const url = typeof record.url === "string" ? record.url.trim() : "";
      if (!url) return null;
      const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : null;
      const highlights = Array.isArray(record.highlights)
        ? record.highlights.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        : [];
      const text = typeof record.text === "string" ? record.text.trim() : "";
      const snippet = summary || highlights[0] || (text ? text.slice(0, 260) : "No snippet available.");
      return { title, url, snippet };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (results.length === 0) throw new Error("Exa returned no results for this query.");

  const text = [
    "Top themes:",
    ...results.slice(0, 4).map((row) => `- ${row.title}`),
    "",
    "Evidence:",
    ...results.slice(0, 8).map((row) => `- ${row.title}\n  URL: ${row.url}\n  Summary: ${row.snippet.replace(/\s+/g, " ").slice(0, 320)}`),
  ].join("\n");
  return { text, model: "exa-search", provider: "exa_web_search" };
}

export async function completeText(input: { system: string; user: string; maxTokens?: number }): Promise<string> {
  const response = await withAbortTimeout(readLoopAgentTimeoutMs(), (signal) => loopExecutorOpenAiChat({
    messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }],
    temperature: 0.3,
    maxTokens: input.maxTokens ?? 1600,
    signal,
  }), "Loop agent model call");
  const text = response.text.trim();
  if (!text) throw new Error("Loop agent LLM returned an empty response");
  return text;
}
