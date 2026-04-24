#!/usr/bin/env node
import process from "node:process";

const CHATGPT_ACTIONS_SPEC_TAG = "stable";

const CHATGPT_INSTRUCTIONS_TEMPLATE = `You have access to Tallei shared memory + documents tools.

Available actions:
- prepare_response
- recall_memories
- upload_blob
- remember
- undo_save
- recent_documents
- search_documents
- recall_document

Rules:
1) Call prepare_response(message="<exact user message>", openaiFileIdRefs=[...any attachments...]) before answering when the user asks about past context/memories/docs, gives a durable fact/opinion/belief/preference/goal/decision/correction/frustration/note, attaches a file, pastes substantial content, or may need prior context.
2) You may skip prepare_response only for purely local replies that need no memory and contain nothing worth saving.
3) Never write final reply text before prepare_response completes when you call it.
4) Answer from contextBlock, inlineDocuments, and replyInstructions.
5) If replyInstructions asks for a saved-document footer, append it exactly.
6) Do not call remember separately unless prepare_response explicitly instructs a fallback.
7) recall_memories, remember, search_documents, and recall_document are fallback/debug tools. Prefer prepare_response.
8) Never mention tool calls in user-facing text.`;

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
  const prepareUrl = `${baseUrl}/api/chatgpt/actions/prepare_response`;

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
      if (!data.paths?.["/api/chatgpt/actions/prepare_response"]) {
        throw new Error("Missing /api/chatgpt/actions/prepare_response path");
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
      await runCheck("Authenticated prepare_response smoke check", async () => {
        const res = await fetch(prepareUrl, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ message: "setup verification", conversation_id: "setup" }),
        });
        if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
        const data = await safeJson(res);
        if (!data || typeof data.contextBlock !== "string" || !Array.isArray(data.replyInstructions)) {
          throw new Error("Invalid prepare_response response shape");
        }
      })
    );

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
