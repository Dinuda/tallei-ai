#!/usr/bin/env node
import process from "node:process";

const CHATGPT_INSTRUCTIONS_TEMPLATE = `You have access to Tallei shared memory tools.

Rules:
1) On the first user message in each new chat, call recallMemories with a broad query before replying.
2) Before answering personal/contextual questions, call recallMemories first.
3) When the user shares a durable fact or preference, call saveMemory in the same turn.
4) If the user corrects a prior fact, call saveMemory with the corrected fact.
5) Do not mention tool calls in the final user-facing response.`;

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
  const openApiUrl = `${baseUrl}/api/chatgpt/openapi.json`;
  const recallUrl = `${baseUrl}/api/chatgpt/actions/recall`;
  const saveUrl = `${baseUrl}/api/chatgpt/actions/save`;

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
      if (!data.paths?.["/api/chatgpt/actions/recall"]) {
        throw new Error("Missing /api/chatgpt/actions/recall path");
      }
      if (!data.paths?.["/api/chatgpt/actions/save"]) {
        throw new Error("Missing /api/chatgpt/actions/save path");
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
      await runCheck("Authenticated save smoke check", async () => {
        const res = await fetch(saveUrl, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            content: `Setup verification memory (${new Date().toISOString()})`,
          }),
        });
        if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
        const data = await safeJson(res);
        if (!data || data.success !== true || typeof data.memoryId !== "string") {
          throw new Error("Invalid save response shape");
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
