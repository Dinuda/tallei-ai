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
1) STEP 1 (always first): call recall_memories(query="<exact user message>", openaiFileIdRefs=[...any attachments...]) on every turn, including greetings and simple follow-ups.
2) Never write reply text before recall_memories completes.
3) STEP 2: read recall response.
   - If inlineDocuments exists, read it first and use it.
   - If autoSave.complete=false or HTTP 422, say "Upload failed, retrying…", call upload_blob(openaiFileIdRefs=[...]), retry once.
   - If HTTP 402 and code=plan_required, do not retry. Tell the user document sharing is a Pro feature on Tallei and ask payment at https://tallei.com/dashboard/billing.
4) STEP 3: write answer from contextBlock + inlineDocuments. Do not ask "which document?" when recall already returned relevant context.
5) STEP 4 (always after reply): if user shared fact/preference/goal/decision, call remember(kind="fact"|"preference", content="<concise>") for each.
6) STEP 5: if autoSave.saved is non-empty, end with Saved: @doc:<ref>. For fact/preference saves, no Saved line.
7) Never mention tool calls in user-facing text.
8) OpenAPI operation descriptions are the canonical execution contract.`;

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
