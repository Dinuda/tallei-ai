import assert from "node:assert/strict";
import test from "node:test";

import {
  bundlesToImportConversations,
  classifyBulkImportCandidates,
} from "../../../src/orchestration/memory/chatgpt-import-signal.usecase.js";

function userMessage(text: string) {
  return { role: "user" as const, text, sourceDateTime: null };
}

function assistantMessage(text: string) {
  return { role: "assistant" as const, text, sourceDateTime: null };
}

function conversation(id: string, messages: ReturnType<typeof userMessage>[]) {
  return {
    id,
    sourceFile: "conversations.json",
    sourceDateTime: "2024-01-10T14:38:32.115Z",
    title: null,
    messages,
  };
}

test("signal filter drops screenshot junk examples", () => {
  const classified = classifyBulkImportCandidates([
    conversation("nova", [
      userMessage(
        "I'm Nova and this is my pal Neo. We're here to guide you on your incredible journey to becoming a super cool inventor."
      ),
    ]),
    conversation("android", [
      userMessage(
        "i have an application that has an android folder, ios folder, linux folder etc. how can i run it on android studio which file do i open in android"
      ),
    ]),
    conversation("pip", [
      userMessage("/usr/local/bin/python pip install litellm error: externally-managed-environment"),
    ]),
  ]);

  assert.equal(classified.keepHigh.length, 0);
  assert.equal(classified.dropped.length, 3);
});

test("signal filter keeps durable identity and project facts", () => {
  const classified = classifyBulkImportCandidates([
    conversation("tallei", [
      userMessage("I'm building Tallei, a memory layer for AI tools."),
    ]),
    conversation("stack", [
      userMessage("We use Next.js, TypeScript, Postgres, pgvector, Vercel, and Composio in our stack."),
    ]),
    conversation("preference", [
      userMessage("I prefer short, human, founder-style writing for startup product copy."),
    ]),
  ]);

  assert.ok(classified.keepHigh.length >= 2);
  assert.equal(classified.keepHigh.some((row) => row.textBundle.includes("Tallei")), true);
});

test("signal filter boosts assistant architecture content with user confirmation", () => {
  const classified = classifyBulkImportCandidates([
    {
      id: "arch",
      sourceFile: "conversations.json",
      sourceDateTime: null,
      title: "Tallei architecture",
      messages: [
        userMessage("Can you draft our system design?"),
        assistantMessage(
          "Proposed architecture: Next.js dashboard, Express MCP server, Postgres pgvector store, and async import workers."
        ),
        userMessage("Sounds good, let's go with that stack."),
      ],
    },
  ]);

  assert.equal(classified.keepHigh.length, 1);
  assert.equal(classified.keepHigh[0]?.reasons.includes("assistant_durable"), true);
});

test("bundlesToImportConversations maps bulk parser bundles", () => {
  const rows = bundlesToImportConversations([
    {
      id: "abc",
      sourceFile: "conversations.json",
      sourceDateTime: null,
      title: "Project",
      messages: [userMessage("I am building Tallei.")],
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, "abc");
});
