#!/usr/bin/env node
import process from "node:process";

const CHATGPT_ACTIONS_SPEC_TAG = "stable";

const CHATGPT_INSTRUCTIONS_TEMPLATE = `You have access to Tallei shared memory + documents tools.

Available actions:
- recall_memories
- upload_blob
- remember
- undo_save
- recent_documents
- search_documents
- recall_document

Rules:
1) On the first user turn in a chat, always call recall_memories(query=user message, limit=8, types=["fact","preference"]).
2) After first turn, call recall_memories only when asked or when prior memory/docs are needed to answer confidently.
3) If uploaded files exist, strict tool order is required: start user-facing text with "I'm saving <file_name>" -> upload_blob(openaiFileIdRefs=[...]) -> recall_memories(if needed) -> answer.
4) Never answer before upload_blob returns.
5) If upload_blob returns failures, retry upload_blob and do not continue with final answer until files are saved or user explicitly says to skip saving.
6) End the final answer with saved refs (for example: Saved: @doc:... or Saved: @lot:...).
7) Uploads are not PDF-only; Word files (.docx/.docm) are supported too.
8) If a question is referential (e.g., "the first activity", "that catalogue", "according to the spec", "in the line"), treat it as document-grounded even without the words "pdf" or "document".
9) For document-grounded questions, call recent_documents(limit=5) first.
10) If needed, call search_documents(query=user message, limit=5).
11) If a likely match exists, call recall_document(ref=best match) before answering.
12) Only ask clarification if no match after steps 9-11; never skip these and give a generic answer.
13) recall_memories provides docs-lite context only; include_doc_refs returns brief metadata only.
14) Every 3 user messages, save a concise fact summary with remember(kind="fact"), unless user opted out.
15) Use remember as the unified save endpoint (fact/preference/document-note/document-blob) for explicit user save requests.
16) If the user says "undo"/"delete", call undo_save with the saved @doc ref.
17) Do not mention tool calls in user-facing responses (except the required save line + saved-ref footer on file turns).
18) STRICT MODE for GPT-5.3 / GPT-5.3-instant / auto:
    - Before final answer, check: first-turn recall done; file upload (if any) succeeded; needed doc lookup done; save line + saved refs included.
    - If any check fails, call required tools now and do not finalize answer yet.
19) OpenAPI operation descriptions are the canonical execution contract.`;

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function normalizeBaseUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.pathname === "/mcp" || parsed.pathname.endsWith("/mcp/")) {
      parsed.pathname = "/";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function runCheck(name, fn) {
  try {
    await fn();
    console.log(`[OK] ${name}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[FAIL] ${name}: ${message}`);
    return false;
  }
}

async function main() {
  const port = process.env.PORT || "3000";
  const baseUrl = normalizeBaseUrl(
    getArgValue("--base-url") ||
      process.env.PUBLIC_BASE_URL ||
      process.env.NEXT_PUBLIC_API_BASE_URL ||
      `http://localhost:${port}`
  );
  const checkEnabled = hasFlag("--check");
  const rawAccessToken = getArgValue("--access-token") || process.env.TALLEI_OAUTH_ACCESS_TOKEN || "";
  const accessToken = rawAccessToken.startsWith("Bearer ")
    ? rawAccessToken.slice("Bearer ".length)
    : rawAccessToken;

  const healthUrl = `${baseUrl}/health`;
  const openApiUrl = `${baseUrl}/api/chatgpt/actions/openapi.json?spec=${encodeURIComponent(CHATGPT_ACTIONS_SPEC_TAG)}`;
  const recallUrl = `${baseUrl}/api/chatgpt/actions/recall_memories`;
  const rememberUrl = `${baseUrl}/api/chatgpt/actions/remember`;

  console.log("Tallei ChatGPT Actions Setup");
  console.log("============================");
  console.log("");
  console.log(`Base URL: ${baseUrl}`);
  console.log(`OpenAPI URL: ${openApiUrl}`);
  console.log(`Health URL: ${healthUrl}`);
  console.log(`OAuth Authorization URL: ${baseUrl}/authorize`);
  console.log(`OAuth Token URL: ${baseUrl}/token`);
  console.log("");
  console.log("OAuth scopes for ChatGPT actions:");
  console.log("memory:read memory:write");
  console.log("");
  console.log("Suggested GPT Instructions:");
  console.log("---------------------------");
  console.log(CHATGPT_INSTRUCTIONS_TEMPLATE);
  console.log("");
  console.log("Usage:");
  console.log("node scripts/setup-chatgpt-actions.mjs --check [--access-token <oauth_access_token>] [--base-url https://your-domain]");
  console.log("");

  if (!checkEnabled) {
    console.log("Checks skipped. Add --check to run connectivity verification.");
    return;
  }

  const checks = [];

  checks.push(
    await runCheck("Health endpoint", async () => {
      const res = await fetch(healthUrl);
      if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
      const data = await safeJson(res);
      if (!data || data.status !== "ok") {
        throw new Error("Health payload missing status=ok");
      }
    })
  );

  checks.push(
    await runCheck("OpenAPI schema endpoint", async () => {
      const res = await fetch(openApiUrl);
      if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
      const data = await safeJson(res);
      if (!data || typeof data !== "object") throw new Error("Invalid OpenAPI JSON");
      if (typeof data.openapi !== "string") throw new Error("Missing openapi version");
      if (!data.paths?.["/api/chatgpt/actions/recall_memories"]) {
        throw new Error("Missing /api/chatgpt/actions/recall_memories path");
      }
      if (!data.paths?.["/api/chatgpt/actions/remember"]) {
        throw new Error("Missing /api/chatgpt/actions/remember path");
      }
    })
  );

  if (!accessToken) {
    console.log("[INFO] OAuth access token not provided; skipping authenticated recall/save smoke checks.");
  } else {
    const authHeaders = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    checks.push(
      await runCheck("Authenticated recall smoke check", async () => {
        const res = await fetch(recallUrl, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ query: "setup verification", limit: 1 }),
        });
        if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
        const data = await safeJson(res);
        if (!data || typeof data.contextBlock !== "string" || !Array.isArray(data.memories)) {
          throw new Error("Invalid recall response shape");
        }
      })
    );

    checks.push(
      await runCheck("Authenticated remember smoke check", async () => {
        const res = await fetch(rememberUrl, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            kind: "fact",
            content: `Setup verification memory (${new Date().toISOString()})`,
          }),
        });
        if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
        const data = await safeJson(res);
        if (!data || data.success !== true) {
          throw new Error("Invalid remember response shape");
        }
      })
    );
  }

  const failed = checks.some((ok) => !ok);
  if (failed) {
    process.exitCode = 1;
  } else {
    console.log("All requested checks passed.");
  }
}

void main();
