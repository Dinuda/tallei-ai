import assert from "node:assert/strict";
import test from "node:test";

import {
  formatWorkflowUserProfile,
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
