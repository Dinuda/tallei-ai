import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

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

test("findPendingInteractivePrompt reopens interrupted askQuestion prompts", async () => {
  const { findPendingInteractivePrompt } = await import(
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

  const pending = findPendingInteractivePrompt(messages, null);
  assert.equal(pending?.toolCallId, "tool-1");
  assert.equal(pending?.toolName, "askQuestion");
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

test("findPendingOutcomeBrief still resumes legacy review plus confirmation transcripts", async () => {
  const { findPendingOutcomeBrief } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const briefHash = "b".repeat(64);
  const messages = [{
    id: "assistant-legacy",
    role: "assistant",
    parts: [
      {
        type: "tool-reviewOutcomeBrief",
        toolCallId: "review-1",
        state: "output-available",
        input: {},
        output: { briefHash, brief: { outcome: "Legacy summary" } },
      },
      {
        type: "tool-confirmOutcomeBrief",
        toolCallId: "confirm-legacy",
        state: "input-available",
        input: {
          briefHash,
          question: "Does this look right?",
          options: [
            { id: "confirm", label: "Looks good", value: "confirm" },
            { id: "change", label: "Change it", value: "other" },
          ],
        },
      },
    ],
  }] satisfies UIMessage[];

  assert.equal(findPendingOutcomeBrief(messages)?.toolCallId, "confirm-legacy");
});

test("confirmation UI renders a config-driven review card", async () => {
  const fs = await import("node:fs/promises");
  const [card, toolPart] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/conductor/outcome-brief-card.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-tool-part.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(card, /<Canvas/);
  assert.match(card, /viewModel\.title/);
  assert.match(card, /tag-blue-text/);
  assert.match(card, /<Controls/);
  assert.match(card, /<MiniMap/);
  assert.match(card, /onNodeClick/);
  assert.match(card, /\/tallei\.svg/);
  assert.match(card, /logos\.composio\.dev\/api/);
  assert.match(card, /<Avatar/);
  assert.match(card, /useSession/);
  assert.doesNotMatch(card, /Edge\.Animated|animateMotion|type: "animated"/);
  assert.doesNotMatch(card, /rounded-2xl|rounded-xl/);
  assert.doesNotMatch(card, />Starts when</);
  assert.doesNotMatch(card, />Safety gate</);
  assert.match(toolPart, /buildOutcomeReviewViewModel\(spec/);
  assert.match(toolPart, /part\.state === "input-streaming"/);
  assert.match(toolPart, /OutcomeBriefCard/);
  assert.doesNotMatch(toolPart, /manifestRef/);
});
