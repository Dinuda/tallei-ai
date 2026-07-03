import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

import { createEmptyLoopSpec } from "../../../src/loops/spec.js";

test("hasUnansweredUiToolCalls treats resumable input-streaming prompts as pending", async () => {
  const { hasUnansweredUiToolCalls } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-askQuestion",
      toolCallId: "tool-1",
      state: "input-streaming",
      input: {
        questionId: "trigger",
        question: "How should this start?",
        options: [
          { id: "manual", label: "Manual", value: "manual" },
          { id: "email", label: "Email", value: "email" },
        ],
      },
    }],
  }] satisfies UIMessage[];

  assert.equal(hasUnansweredUiToolCalls(messages), true);
});

test("findPendingInteractivePrompts returns multiple prompts in transcript order", async () => {
  const { findPendingInteractivePrompts } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const spec = createEmptyLoopSpec("00000000-0000-4000-8000-000000000001", {
    taskBlueprint: {
      version: 1,
      summary: "Route incoming support requests",
      outcomes: [
        { id: "source", role: "source", description: "Read support emails", status: "pending" },
      ],
    },
  });
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-askQuestion",
        toolCallId: "tool-1",
        state: "input-streaming",
        input: {
          questionId: "trigger",
          question: "How should this start?",
          options: [
            { id: "manual", label: "Manual", value: "manual" },
            { id: "email", label: "Email", value: "email" },
          ],
        },
      }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      parts: [
        {
          type: "tool-discoverConnectorsForBlueprint",
          toolCallId: "discover-1",
          state: "output-available",
          input: { outcomes: [{ id: "source", role: "source", description: "Read support emails" }] },
          output: {
            groups: [{
              outcomeId: "source",
              role: "source",
              outcomeDescription: "Read support emails",
              defaultQuestion: "Which app should we use?",
              recommendedOptionIds: ["gmail"],
              askOptions: [
                { id: "gmail", label: "Gmail", value: "gmail" },
                { id: "outlook", label: "Outlook", value: "outlook" },
              ],
            }],
          },
        },
        {
          type: "tool-pickConnectorApp",
          toolCallId: "tool-2",
          state: "input-streaming",
          input: { outcomeId: "source", role: "source" },
        },
      ],
    },
    {
      id: "assistant-3",
      role: "assistant",
      parts: [{
        type: "tool-askQuestion",
        toolCallId: "tool-3",
        state: "input-available",
        input: {
          questionId: "review",
          question: "Should drafts be reviewed first?",
          options: [
            { id: "review", label: "Review first", value: "review_first" },
            { id: "auto", label: "Send automatically", value: "auto" },
          ],
        },
      }],
    },
  ] satisfies UIMessage[];

  const pending = findPendingInteractivePrompts(messages, spec);
  assert.deepEqual(
    pending.map((item) => item.toolCallId),
    ["tool-1", "tool-2", "tool-3"],
  );
  assert.equal(pending[1]?.input.questionId, "connector-app:source");
  assert.deepEqual(
    pending.map((item) => item.input.step),
    [
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ],
  );
});

test("findPendingPresentReplyOptions reopens interrupted reply chips", async () => {
  const { findPendingPresentReplyOptions } = await import(
    "../../../dashboard/src/lib/conductor-prompt-suggestions.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-presentReplyOptions",
      toolCallId: "tool-1",
      state: "input-streaming",
      input: {
        options: [
          { id: "yes", label: "Yes", message: "Yes" },
          { id: "no", label: "No", message: "No" },
        ],
      },
    }],
  }] satisfies UIMessage[];

  const pending = findPendingPresentReplyOptions(messages);
  assert.equal(pending?.toolCallId, "tool-1");
  assert.equal(pending?.input.options.length, 2);
});

test("findPendingOutcomeBrief shows confirmation without a review tool result", async () => {
  const { findPendingOutcomeBrief } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const briefHash = "a".repeat(64);
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [
      { type: "text", text: "### Ready to build\n\n- **Runs when:** A message arrives." },
      {
        type: "tool-confirmOutcomeBrief",
        toolCallId: "confirm-1",
        state: "input-available",
        input: {
          briefHash,
          summary: {
            title: "Support reply",
            reversible: true,
            runsWhen: "A message arrives.",
            does: "Reads the message and drafts a reply.",
            steps: [
              { label: "Trigger", description: "New message", kind: "trigger" },
              { label: "Draft", description: "Write reply", kind: "action" },
            ],
            approval: "You review the reply.",
            result: "The draft is saved.",
          },
          question: "Does this look right?",
          options: [
            { id: "confirm", label: "Looks good", value: "confirm" },
            { id: "change", label: "Change it", value: "other" },
          ],
        },
      },
    ],
  }] satisfies UIMessage[];

  const pending = findPendingOutcomeBrief(messages);
  assert.equal(pending?.toolCallId, "confirm-1");
  assert.equal(pending?.confirmBriefHash, briefHash);
  assert.equal(pending?.confirmPrompt.options.length, 2);
});

test("completed askQuestion answers stay visible while pending copies stay hidden", async () => {
  const fs = await import("node:fs/promises");
  const [toolPart, shared] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-tool-part.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url), "utf8"),
  ]);

  assert.match(toolPart, /AnsweredAskQuestionCard/);
  assert.match(toolPart, /pendingInteractivePromptCallIds\.has/);
  assert.match(toolPart, /AnsweredPresentReplyOptionsCard/);
  assert.match(shared, /findPendingInteractivePrompts/);
  assert.match(shared, /return prompts\.map/);
  assert.match(shared, /step: \{ index: index \+ 1, total: prompts\.length \}/);
});
