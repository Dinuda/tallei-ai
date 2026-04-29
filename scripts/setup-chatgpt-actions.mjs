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
1) If user asks to start/create/begin a ChatGPT↔Claude collab, call createCollabTask immediately in the same turn.
2) If user gives explicit collab args (title/brief/first_actor/max_iterations), pass those exact values.
3) For createCollabTask, pass recall_query (from user goal/brief) and include_doc_refs when user names specific @doc refs.
4) If attachments exist, pass openaiFileIdRefs (+ conversation_id when available) to createCollabTask so preflight recall runs before ingest.
5) After createCollabTask succeeds, call collab_continue in the same turn. If upload.count_failed > 0, report file failures briefly and continue unless task creation failed.
6) If user asks to continue/resume/proceed collab or includes a collab UUID, call collab_continue with task_id, message, and (when files are attached) openaiFileIdRefs + conversation_id.
7) Never call collab_continue without openaiFileIdRefs when this turn contains file attachments.
8) On first collab turn, if no task documents exist yet, collab_continue will fail without openaiFileIdRefs.
9) collab_continue runs prepare_response preflight first, then uploads/attaches files, then checks/submits the turn.
10) Use collab_continue.prepare_context as drafting source of truth and collab_continue.documents as attached task-document list.
11) ChatGPT file URLs are temporary; pass openaiFileIdRefs immediately in the same turn (do not delay follow-up calls).
12) Do not output copy/paste workflows or manual setup guidance when collab tools are available.
13) Default to answering from the visible ChatGPT conversation without calling tools.
14) Call prepare_response(message="<exact user message>", openaiFileIdRefs=[...any attachments...]) only when the user asks about information outside the visible chat, asks about a file/document/catalogue/product list not fully visible, gives durable new information worth saving, attaches/pastes substantial content, or explicitly asks to remember/save/recall/search/use Tallei.
15) Do NOT call prepare_response for ordinary conversation, local reasoning, writing, coding, explanations, brainstorming, summaries of visible text, or follow-ups such as "make that shorter", "continue", or "what do you mean?" when visible context is enough and nothing durable needs saving.
16) Never write final reply text before prepare_response completes when you call it.
17) Answer from contextBlock, inlineDocuments, and replyInstructions.
18) If replyInstructions asks for a saved-document footer, append it exactly.
19) Do not call remember separately unless prepare_response explicitly instructs a fallback.
20) recall_memories, remember, search_documents, and recall_document are fallback/debug tools. Prefer prepare_response.
21) Never mention tool calls in user-facing text.`;

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
