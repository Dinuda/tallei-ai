#!/usr/bin/env tsx
/**
 * Smoke test: verify Tallei MCP endpoint is reachable and working.
 * Does NOT require benchmark datasets.
 *
 * Usage:
 *   npx tsx eval/smoke-test.ts
 *
 * Environment:
 *   TALLEI_EVAL_URL    MCP endpoint (default: http://localhost:3000/mcp)
 *   EVAL_USER_ID       Existing user UUID in local DB (required)
 */

import {
  saveMemory,
  recallMemories,
  getEvalUserIdOrThrow,
  assertEvalAuthOrThrow,
} from "./tallei-client.js";

async function main() {
  const userId = getEvalUserIdOrThrow();
  console.log(`[smoke] testing Tallei MCP at ${process.env["TALLEI_EVAL_URL"] ?? "http://localhost:3000/mcp"}`);
  console.log(`[smoke] user ID: ${userId}`);

  try {
    await assertEvalAuthOrThrow(userId);
    console.log("[smoke] saving test memory...");
    await saveMemory("I love building AI systems with TypeScript", userId);
    console.log("[smoke] ✓ save_memory OK");

    console.log("[smoke] recalling memories...");
    const result = await recallMemories("favorite programming language", userId, 5);
    console.log("[smoke] ✓ recall_memories OK");
    console.log(`[smoke] context block:\n${result.slice(0, 200)}...`);

    console.log("[smoke] ✓ all checks passed");
  } catch (err) {
    console.error("[smoke] ✗ failed:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(1);
});
