import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWorkflowUserProfile,
  isWorkflowUserProfileMemory,
  sanitizeWorkflowUserProfile,
  workflowUserProfileSchema,
} from "../../../src/services/loop-engine/workflow-user-profile.js";
import { buildAgentHandoff } from "../../../src/services/loop-runtime/memory.js";

test("formatWorkflowUserProfile renders durable profile memories for prompts", () => {
  const profile = workflowUserProfileSchema.parse({
    capturedAt: "2026-06-10T00:00:00.000Z",
    memoryIds: ["11111111-1111-4111-8111-111111111111"],
    profileText: "1. [11111111-1111-4111-8111-111111111111] (writing_style) Sign internal sync emails as Talk soon, [Founder]. Tone: direct, no fluff.",
    memories: [{
      id: "11111111-1111-4111-8111-111111111111",
      text: "Sign internal sync emails as Talk soon, [Founder]. Tone: direct, no fluff.",
      category: "writing_style",
      memoryType: "preference",
      tier: "permanent",
    }],
  });
  const formatted = formatWorkflowUserProfile(profile);
  assert.match(formatted, /Talk soon, \[Founder\]/);
  assert.match(formatted, /writing_style/);
});

test("buildAgentHandoff injects cached user profile for every agent run", () => {
  const handoff = buildAgentHandoff(
    { id: "writer", name: "Writer", task: "Draft email", tools: [] },
    {
      inputs: { sprint_notes: "Shipped memory persistence." },
      approvedMemories: [],
      approvedSources: {},
      operatorRevisions: {},
      updatedAt: new Date().toISOString(),
    },
    {},
    {
      userProfile: {
        profileText: "Sign as Talk soon, [Founder].",
        memories: [{ id: "11111111-1111-4111-8111-111111111111", text: "Sign as Talk soon, [Founder]." }],
      },
    },
  );
  assert.equal(handoff.user_profile, "Sign as Talk soon, [Founder].");
});

test("workflow profile accepts concise first-party preferences", () => {
  assert.equal(isWorkflowUserProfileMemory({
    text: "Our preferred stack is TypeScript, Postgres, and Qdrant.",
    memoryType: "preference",
  }), true);
  assert.equal(isWorkflowUserProfileMemory({
    text: "Sign internal sync emails as Talk soon, [Founder]. Tone: direct, no fluff.",
    memoryType: "preference",
  }), true);
});

test("workflow profile rejects retention-only memories and assistant outputs", () => {
  assert.equal(isWorkflowUserProfileMemory({
    text: "i like hte squares",
    memoryType: "preference",
  }), false);
  assert.equal(isWorkflowUserProfileMemory({
    text: "ResponseError: Unauthorized. The SendGrid API key is invalid.",
    memoryType: "fact",
  }), false);
  assert.equal(isWorkflowUserProfileMemory({
    text: "Here's simple feedback you can give to a 10-year-old:\n## Activity 1\nI love how creative this is.",
    memoryType: "preference",
  }), false);
  assert.equal(isWorkflowUserProfileMemory({
    text: "Gm Dinuda, everything fine on your side? I'm happy to visit the apartment. Lots of greetings, Ketty.",
    memoryType: "preference",
  }), false);
});

test("sanitizeWorkflowUserProfile removes contaminated cached profile memories", () => {
  const profile = workflowUserProfileSchema.parse({
    capturedAt: "2026-06-10T00:00:00.000Z",
    memoryIds: [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ],
    profileText: "stale contaminated profile",
    memories: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        text: "I prefer compact square layouts.",
        memoryType: "preference",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        text: "Here is a complete SQL troubleshooting guide.\n## Query",
        memoryType: "preference",
      },
    ],
  });

  const sanitized = sanitizeWorkflowUserProfile(profile);
  assert.deepEqual(sanitized?.memoryIds, ["11111111-1111-4111-8111-111111111111"]);
  assert.doesNotMatch(sanitized?.profileText ?? "", /SQL troubleshooting/);
});
