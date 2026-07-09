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

test("findPendingInteractivePrompts ignores askQuestion until questionId is present", async () => {
  const { findPendingInteractivePrompts } = await import(
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
        question: "How should this start?",
        options: [
          { id: "manual", label: "Manual", value: "manual" },
          { id: "email", label: "Email", value: "email" },
        ],
      },
    }],
  }] satisfies UIMessage[];

  assert.deepEqual(findPendingInteractivePrompts(messages), []);
});

test("findPendingInteractivePrompts excludes optimistically resolved tool calls", async () => {
  const { findPendingInteractivePrompts } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-askQuestion",
      toolCallId: "tool-1",
      state: "input-available",
      input: {
        questionId: "priority-labels",
        question: "Use default priority labels?",
        options: [
          { id: "default", label: "Default", value: "default" },
          { id: "custom", label: "Custom", value: "custom" },
        ],
      },
    }],
  }] satisfies UIMessage[];

  assert.equal(findPendingInteractivePrompts(messages).length, 1);
  assert.equal(
    findPendingInteractivePrompts(messages, null, null, new Set(["tool-1"])).length,
    0,
  );
});

test("partitionPendingQuestionBatch advances locally without hiding unanswered server prompts", async () => {
  const { partitionPendingQuestionBatch } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const prompts = [
    {
      toolCallId: "tool-1",
      toolName: "askQuestion" as const,
      input: {
        questionId: "q1",
        question: "First?",
        options: [{ id: "a", label: "A", value: "a" }],
      },
    },
    {
      toolCallId: "tool-2",
      toolName: "askQuestion" as const,
      input: {
        questionId: "q2",
        question: "Second?",
        options: [{ id: "b", label: "B", value: "b" }],
      },
    },
    {
      toolCallId: "tool-3",
      toolName: "askQuestion" as const,
      input: {
        questionId: "q3",
        question: "Third?",
        options: [{ id: "c", label: "C", value: "c" }],
      },
    },
  ];
  const queued = new Map([
    ["tool-1", {
      answerText: "A",
      selectedOptionIds: ["a"],
      selectedValues: ["a"],
    }],
  ]);

  const batch = partitionPendingQuestionBatch(prompts, queued);
  assert.equal(batch.batchMode, true);
  assert.equal(batch.total, 3);
  assert.equal(batch.queuedCount, 1);
  assert.equal(batch.remaining.length, 2);
  assert.equal(batch.remaining[0]?.toolCallId, "tool-2");
  assert.deepEqual(batch.remaining[0]?.input.step, { index: 2, total: 3 });
  assert.deepEqual(batch.remaining[1]?.input.step, { index: 3, total: 3 });
});

test("partitionPendingQuestionBatch does not batch connector picks", async () => {
  const { partitionPendingQuestionBatch } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const prompts = [
    {
      toolCallId: "tool-1",
      toolName: "askQuestion" as const,
      input: {
        questionId: "q1",
        question: "First?",
        options: [{ id: "a", label: "A", value: "a" }],
      },
    },
    {
      toolCallId: "tool-2",
      toolName: "pickConnectorApp" as const,
      input: {
        questionId: "connector-app:dest",
        question: "Pick app",
        options: [{ id: "gmail", label: "Gmail", value: "gmail" }],
      },
    },
  ];

  const batch = partitionPendingQuestionBatch(prompts, new Map());
  assert.equal(batch.batchMode, false);
  assert.equal(batch.remaining.length, 2);
});

test("collectSupersededAskQuestionCallIds keeps only the latest answered card per questionId", async () => {
  const { collectSupersededAskQuestionCallIds } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [
      {
        type: "tool-askQuestion",
        toolCallId: "tool-1",
        state: "output-available",
        input: {
          questionId: "priority-labels",
          question: "Use default priority labels?",
          options: [
            { id: "default", label: "Default", value: "default" },
            { id: "custom", label: "Custom", value: "custom" },
          ],
        },
        output: {
          questionId: "priority-labels",
          answerText: "Default",
          selectedOptionIds: ["default"],
          selectedValues: ["default"],
        },
      },
      {
        type: "tool-askQuestion",
        toolCallId: "tool-2",
        state: "output-available",
        input: {
          questionId: "priority-labels",
          question: "Use default priority labels?",
          options: [
            { id: "default", label: "Default", value: "default" },
            { id: "custom", label: "Custom", value: "custom" },
          ],
        },
        output: {
          questionId: "priority-labels",
          answerText: "Default",
          selectedOptionIds: ["default"],
          selectedValues: ["default"],
        },
      },
    ],
  }] satisfies UIMessage[];

  const superseded = collectSupersededAskQuestionCallIds(messages);
  assert.equal(superseded.size, 1);
  assert.equal(superseded.has("tool-1"), true);
  assert.equal(superseded.has("tool-2"), false);
});

test("clearPhaseProgressPendingUiTool clears only the matching pending tool", async () => {
  const { clearPhaseProgressPendingUiTool } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const phaseProgress = {
    phase: "intent",
    pendingUiTool: {
      toolCallId: "tool-1",
      toolName: "askQuestion",
      input: {
        questionId: "priority-labels",
        question: "Use default priority labels?",
        options: [
          { id: "default", label: "Default", value: "default" },
          { id: "custom", label: "Custom", value: "custom" },
        ],
      },
    },
  };

  const cleared = clearPhaseProgressPendingUiTool(phaseProgress, "tool-1");
  assert.equal(cleared?.pendingUiTool, undefined);
  assert.equal(clearPhaseProgressPendingUiTool(phaseProgress, "tool-2"), phaseProgress);
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
              defaultQuestion: "Where should the incoming messages come from?",
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
  assert.equal(pending[1]?.input.question, "Where should the incoming messages come from?");
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

test("findPendingPresentReplyOptions ignores optimistically resolved tool calls", async () => {
  const { findPendingPresentReplyOptions } = await import(
    "../../../dashboard/src/lib/conductor-prompt-suggestions.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-presentReplyOptions",
      toolCallId: "tool-1",
      state: "input-available",
      input: {
        options: [
          { id: "yes", label: "Yes", message: "Yes" },
          { id: "no", label: "No", message: "No" },
        ],
      },
    }],
  }] satisfies UIMessage[];

  assert.equal(findPendingPresentReplyOptions(messages)?.toolCallId, "tool-1");
  assert.equal(findPendingPresentReplyOptions(messages, new Set(["tool-1"])), null);
});

test("hasUnansweredUiToolCalls ignores optimistically resolved tool calls", async () => {
  const { hasUnansweredUiToolCalls } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-askQuestion",
      toolCallId: "ask-1",
      state: "input-available",
      input: {
        questionId: "q1",
        question: "Which channel?",
        options: [
          { id: "email", label: "Email", value: "email" },
          { id: "slack", label: "Slack", value: "slack" },
        ],
      },
    }],
  }] satisfies UIMessage[];

  assert.equal(hasUnansweredUiToolCalls(messages), true);
  assert.equal(hasUnansweredUiToolCalls(messages, null, new Set(["ask-1"])), false);
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
  assert.match(shared, /return visible\.map/);
  assert.match(shared, /step: \{ index: index \+ 1, total: visible\.length \}/);
});

test("conductor composer validates message length and surfaces sonner toasts", async () => {
  const fs = await import("node:fs/promises");
  const [shared, layout, builder] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-builder-layout.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(shared, /CONDUCTOR_MESSAGE_MAX_LENGTH = 4_000/);
  assert.match(shared, /validateConductorComposerMessage/);
  assert.match(shared, /Message is too long/);
  assert.match(layout, /from \"sonner\"/);
  assert.match(layout, /toast\.error\(validationError\)/);
  assert.match(builder, /toast\.error\(validationError\)/);
});

test("connector picker searches all apps and verifies before submitting", async () => {
  const fs = await import("node:fs/promises");
  const [menu, picker, hook, connectCard] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/ai-elements/interactive-prompt-menu.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/builder-connector-prompt.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/use-connector-authorization.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/builder-connect-toolkit-card.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(menu, /placeholder="Search apps…"/);
  assert.match(menu, /max-h-\[21rem\].*overflow-y-auto/);
  assert.match(menu, /More apps/);
  assert.match(picker, /useConnectorAuthorization/);
  assert.match(picker, /ensureConnected/);
  assert.match(picker, /Connecting \$\{pendingToolkitLabel\}/);
  assert.match(picker, /Restart connection/);
  assert.doesNotMatch(picker, /toast\.error/);
  assert.doesNotMatch(picker, /Try again/);
  assert.match(hook, /\/api\/connectors\/status\//);
  assert.match(hook, /\/api\/connectors\/authorize\//);
  assert.match(hook, /pollVerify/);
  assert.match(hook, /window\.location\.assign\(redirectUrl\)/);
  assert.match(hook, /isn't available to connect yet/);
  assert.doesNotMatch(hook, /window\.open/);
  assert.doesNotMatch(hook, /setInterval/);
  assert.doesNotMatch(picker, /text-red-600/);
  assert.match(connectCard, /useConnectorAuthorization/);
  assert.match(connectCard, /autoStart/);
  assert.doesNotMatch(connectCard, /toast\.error/);
  assert.doesNotMatch(connectCard, /window\.open/);
});

test("deriveConductorPromptSuggestions omits continue chips after terminal phaseProgress", async () => {
  const { deriveConductorPromptSuggestions } = await import(
    "../../../dashboard/src/lib/conductor-prompt-suggestions.ts"
  );
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-activateLoop",
        toolCallId: "activate-1",
        state: "output-available",
        output: { ok: true, turnOutcome: "build_complete" },
      }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      parts: [{ type: "text", text: "All set." }],
    },
  ] satisfies UIMessage[];
  const suggestions = deriveConductorPromptSuggestions({
    messages,
    missingSlots: ["activation"],
    status: "draft",
    hasPendingQuestion: false,
    hasPendingReplyOptions: false,
    chatBusy: false,
    buildPhase: "activation",
    phaseProgress: {
      phase: "activation",
      status: "complete",
      terminal: true,
      reason: "activation_complete",
    },
  });
  assert.deepEqual(suggestions, []);
});

test("deriveConductorPromptSuggestions omits continue chips when build is terminal", async () => {
  const { deriveConductorPromptSuggestions } = await import(
    "../../../dashboard/src/lib/conductor-prompt-suggestions.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "All set." }],
  }] satisfies UIMessage[];
  const suggestions = deriveConductorPromptSuggestions({
    messages,
    missingSlots: ["activation"],
    status: "draft",
    hasPendingQuestion: false,
    hasPendingReplyOptions: false,
    chatBusy: false,
    buildPhase: "activation",
    phaseProgress: {
      phase: "activation",
      status: "complete",
      terminal: true,
      reason: "activation_complete",
    },
  });
  assert.deepEqual(suggestions, []);
});

test("conductor builder uses server-owned tool-answer instead of client auto-send", async () => {
  const fs = await import("node:fs/promises");
  const builder = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url),
    "utf8",
  );
  assert.match(builder, /submitConductorToolAnswer/);
  assert.match(builder, /answerTool/);
  assert.match(builder, /parseContinuationIntent/);
  assert.doesNotMatch(builder, /sendAutomaticallyWhen/);
  assert.doesNotMatch(builder, /useConductorContinuation/);
  assert.doesNotMatch(builder, /findPendingConductorPhaseHandoff/);
  assert.doesNotMatch(builder, /findConductorStall/);
  assert.doesNotMatch(builder, /shouldAutoSendConductorChat/);
  assert.doesNotMatch(builder, /method: "PUT"/);
});

test("conductor shared has no client auto-continue helpers", async () => {
  const fs = await import("node:fs/promises");
  const shared = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(shared, /Transcript-inferred auto-continue/i);
  assert.doesNotMatch(shared, /shouldAutoSendConductorChat/);
  assert.doesNotMatch(shared, /findConductorStall/);
  assert.doesNotMatch(shared, /findPendingConductorPhaseHandoff/);
  assert.doesNotMatch(shared, /prepareMessagesForUiToolOutput/);
});

test("phase handoff continuation is owned by the server session loop", async () => {
  const fs = await import("node:fs/promises");
  const [builder, loops] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../src/transport/http/routes/loops.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(builder, /findPendingConductorPhaseHandoff/);
  assert.doesNotMatch(builder, /persistedPhase !== handoff\.nextPhase/);
  assert.doesNotMatch(builder, /useConductorContinuation/);
  assert.doesNotMatch(builder, /sendAutomaticallyWhen/);
  assert.match(loops, /pipeConductorSession/);
  assert.match(loops, /consumePendingHandoffIfNeeded/);
});

test("findPendingOutcomeBrief prefers event-log pendingUiTool over transcript drift", async () => {
  const { findPendingOutcomeBrief } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-confirmOutcomeBrief",
      toolCallId: "confirm-1",
      state: "output-error",
      input: {
        briefHash: "a".repeat(64),
        question: "Ready?",
        options: [
          { id: "confirm", label: "Yes", value: "confirm" },
          { id: "other", label: "No", value: "other" },
        ],
      },
      output: { interrupted: true },
      errorText: "Superseded",
    }],
  }] satisfies UIMessage[];

  const pending = findPendingOutcomeBrief(messages, {
    pendingUiTool: {
      toolCallId: "confirm-1",
      toolName: "confirmOutcomeBrief",
      input: {
        briefHash: "a".repeat(64),
        question: "Ready?",
        options: [
          { id: "confirm", label: "Yes", value: "confirm" },
          { id: "other", label: "No", value: "other" },
        ],
      },
    },
  });
  assert.equal(pending?.toolCallId, "confirm-1");
  assert.equal(pending?.confirmPrompt.question, "Ready?");
});

test("findPendingOutcomeBrief ignores optimistically resolved tool calls", async () => {
  const { findPendingOutcomeBrief } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-confirmOutcomeBrief",
      toolCallId: "confirm-1",
      state: "input-available",
      input: {
        briefHash: "a".repeat(64),
        question: "Ready?",
        options: [
          { id: "confirm", label: "Yes", value: "confirm" },
          { id: "other", label: "No", value: "other" },
        ],
      },
    }],
  }] satisfies UIMessage[];

  assert.equal(findPendingOutcomeBrief(messages)?.toolCallId, "confirm-1");
  assert.equal(
    findPendingOutcomeBrief(messages, null, new Set(["confirm-1"])),
    null,
  );
});

test("hasUnansweredUiToolCalls ignores stale phaseProgress when transcript already answered", async () => {
  const { hasUnansweredUiToolCalls } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-confirmOutcomeBrief",
      toolCallId: "confirm-1",
      state: "output-available",
      input: {
        briefHash: "a".repeat(64),
        question: "Ready?",
        options: [
          { id: "confirm", label: "Yes", value: "confirm" },
          { id: "other", label: "No", value: "other" },
        ],
      },
      output: {
        action: "confirm",
        briefHash: "a".repeat(64),
        selectedOptionIds: ["confirm"],
        selectedValues: ["confirm"],
        answerText: "Yes",
      },
    }],
  }] satisfies UIMessage[];

  assert.equal(hasUnansweredUiToolCalls(messages, {
    pendingUiTool: {
      toolCallId: "confirm-1",
      toolName: "confirmOutcomeBrief",
      input: {
        briefHash: "a".repeat(64),
        question: "Ready?",
        options: [
          { id: "confirm", label: "Yes", value: "confirm" },
          { id: "other", label: "No", value: "other" },
        ],
      },
    },
  }), false);
});

test("findPendingInteractivePrompts restores an event-log question missing from transcript", async () => {
  const { findPendingInteractivePrompts } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const prompts = findPendingInteractivePrompts([], null, {
    phase: "intent",
    pendingUiTool: {
      toolCallId: "question-restored",
      toolName: "askQuestion",
      input: {
        questionId: "review-policy",
        question: "Review replies?",
        options: [
          { id: "review", label: "Review", value: "review" },
          { id: "automatic", label: "Automatic", value: "automatic" },
        ],
      },
    },
  });

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.toolCallId, "question-restored");
});

test("tool result status follows execution outcome instead of transport completion", async () => {
  const { resolveConductorToolResultStatus } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  assert.equal(resolveConductorToolResultStatus({ ok: true }), undefined);
  assert.equal(resolveConductorToolResultStatus({ ok: false, turnOutcome: "blocked" }), "blocked");
  assert.equal(resolveConductorToolResultStatus({ ok: false }), "failed");
  assert.equal(resolveConductorToolResultStatus({
    ok: false,
    recoveryPhase: "compile",
    turnOutcome: "phase_complete",
  }), "recovering");
});

test("test recovery is summarized as an automatic transition", async () => {
  const { formatTestRunSummary } = await import(
    "../../../dashboard/src/components/conductor/conductor-tool-formatters.ts"
  );
  assert.equal(formatTestRunSummary({
    ok: false,
    recoveryPhase: "compile",
    error: "stale plan",
  }), "Plan changed. Returning to compile automatically.");
});

test("conductor tool-answer client helper posts to tool-answer endpoint", async () => {
  const fs = await import("node:fs/promises");
  const helper = await fs.readFile(
    new URL("../../../dashboard/src/lib/conductor-tool-answer.ts", import.meta.url),
    "utf8",
  );
  assert.match(helper, /\/chat\/tool-answer/);
  assert.match(helper, /consumeStream/);
});

test("conductor builder wires tool-answer and pending prompt helpers", async () => {
  const fs = await import("node:fs/promises");
  const [builder, shared, suggestions] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/lib/conductor-prompt-suggestions.ts", import.meta.url), "utf8"),
  ]);

  assert.match(builder, /phaseProgress/);
  assert.match(builder, /buildProgress\?\.continuationIntent/);
  assert.match(builder, /submitConductorToolAnswer/);
  assert.match(builder, /inFlightToolAnswersRef/);
  assert.match(builder, /findPendingOutcomeBrief\(messages, phaseProgress, optimisticallyResolvedToolCallIds\)/);
  assert.doesNotMatch(builder, /findConductorStall/);
  assert.doesNotMatch(builder, /isStalled/);
  assert.doesNotMatch(builder, /sendAutomaticallyWhen/);
  assert.doesNotMatch(builder, /useConductorContinuation/);
  assert.doesNotMatch(builder, /method: "PUT"/);
  assert.match(shared, /findPendingInteractivePrompts/);
  assert.doesNotMatch(shared, /findConductorStall/);
  assert.doesNotMatch(suggestions, /isStalled/);
});
