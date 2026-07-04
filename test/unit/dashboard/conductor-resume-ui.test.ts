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
  const [menu, picker, connectCard] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/ai-elements/interactive-prompt-menu.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/builder-connector-prompt.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/builder-connect-toolkit-card.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(menu, /placeholder="Search apps…"/);
  assert.match(menu, /max-h-\[21rem\].*overflow-y-auto/);
  assert.match(menu, /More apps/);
  assert.match(picker, /\/api\/connectors\/status\//);
  assert.match(picker, /\/api\/connectors\/authorize\//);
  assert.match(picker, /verifyPendingConnection/);
  assert.match(picker, /Complete authorization.*continue automatically/);
  assert.match(picker, /isn't available to connect yet/);
  assert.match(picker, /window\.location\.assign\(authorization\.redirectUrl\)/);
  assert.doesNotMatch(picker, /window\.open/);
  assert.doesNotMatch(picker, /setInterval/);
  assert.match(picker, /Connection was not completed/);
  assert.doesNotMatch(picker, /text-red-600/);
  assert.match(connectCard, /window\.location\.assign\(redirectUrl\)/);
  assert.doesNotMatch(connectCard, /window\.open/);
});

test("findConductorStall detects text-only mid-phase endings", async () => {
  const { evaluateConductorStall } = await import("../../../shared/conductor-turn-budget.js");
  const stall = evaluateConductorStall({
    chatBusy: false,
    hasMessages: true,
    actionablePhase: true,
    hasUnansweredUiTools: false,
    buildIncomplete: true,
    lastRoleIsAssistant: true,
    hasTerminalExecution: false,
    textOnlyEnding: true,
    hasExecutions: false,
    wouldAutoContinue: false,
    hasAssistantParts: true,
  });
  assert.equal(stall.stalled, true);
  assert.equal(stall.reason, "text_only_mid_phase");
});

test("isReviewConfirmationHandoffPending detects roster without confirmation", async () => {
  const { isReviewConfirmationHandoffPending } = await import("../../../shared/conductor-review-handoff.js");
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-presentAgentTeam",
        toolCallId: "team-1",
        state: "output-available",
        input: { groups: [{ outcomeIds: ["read"] }] },
        output: {
          title: "Team",
          specialists: [{
            id: "specialist-1",
            name: "Alex",
            roleTitle: "Reader",
            description: "Reads email",
            avatarSeed: "seed",
            ownershipSummary: "Read support email",
            steps: [{ outcomeId: "read", role: "source", description: "Read support email" }],
          }],
        },
      }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      parts: [{ type: "text", text: "Here is your specialist team summary." }],
    },
  ] satisfies UIMessage[];

  assert.equal(isReviewConfirmationHandoffPending({ messages, buildPhase: "review" }), true);
  assert.equal(isReviewConfirmationHandoffPending({ messages, buildPhase: "compile" }), false);
});

test("findConductorStall does not stall text summary after roster when confirmation is pending", async () => {
  const { isReviewConfirmationHandoffPending } = await import("../../../shared/conductor-review-handoff.js");
  const { evaluateConductorStall } = await import("../../../shared/conductor-turn-budget.js");
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-presentAgentTeam",
        toolCallId: "team-1",
        state: "output-available",
        input: { groups: [{ outcomeIds: ["read"] }] },
        output: {
          title: "Team",
          specialists: [{
            id: "specialist-1",
            name: "Alex",
            roleTitle: "Reader",
            description: "Reads email",
            avatarSeed: "seed",
            ownershipSummary: "Read support email",
            steps: [{ outcomeId: "read", role: "source", description: "Read support email" }],
          }],
        },
      }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      parts: [{ type: "text", text: "Please confirm the team above." }],
    },
  ] satisfies UIMessage[];

  const stall = evaluateConductorStall({
    chatBusy: false,
    hasMessages: true,
    actionablePhase: true,
    hasUnansweredUiTools: false,
    buildIncomplete: true,
    lastRoleIsAssistant: true,
    hasTerminalExecution: false,
    textOnlyEnding: true,
    hasExecutions: false,
    wouldAutoContinue: false,
    hasAssistantParts: true,
    reviewConfirmationHandoffPending: isReviewConfirmationHandoffPending({
      messages,
      buildPhase: "review",
    }),
  });
  assert.equal(stall.stalled, false);
});

test("shouldAutoSendConductorChat blocks stalled auto-continue in source", async () => {
  const fs = await import("node:fs/promises");
  const shared = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );
  assert.match(shared, /findConductorStall\(/);
  assert.match(shared, /isReviewConfirmationHandoffPending/);
  assert.match(shared, /reviewConfirmationHandoffPending/);
  assert.match(shared, /conductor-review-handoff/);
});

test("shouldAutoSendConductorChat auto-continues on non-terminal tool output in source", async () => {
  const fs = await import("node:fs/promises");
  const shared = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );
  assert.match(shared, /phaseCompleted/);
  assert.match(shared, /requiresUserInput/);
  assert.match(shared, /isRecoverableConductorExecution/);
  assert.match(shared, /executions\.length === 0\) return true/);
});

test("shouldAutoSendConductorChat auto-continues on recoverable compile prerequisite miss in source", async () => {
  const fs = await import("node:fs/promises");
  const shared = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );
  assert.match(shared, /if \(recoverable\) return true/);
  assert.match(shared, /isRecoverableConductorExecution/);
});

test("shouldAutoSendConductorChat still blocks unanswered confirmOutcomeBrief in source", async () => {
  const fs = await import("node:fs/promises");
  const shared = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );
  assert.match(shared, /hasUnansweredUiToolCalls\(messages\)\) return false/);
  assert.match(shared, /confirmOutcomeBrief/);
});

test("conductor builder wires buildPhase and stall-aware auto continue", async () => {
  const fs = await import("node:fs/promises");
  const [builder, shared, suggestions] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/lib/conductor-prompt-suggestions.ts", import.meta.url), "utf8"),
  ]);

  assert.match(builder, /buildProgress\?\.internalPhase/);
  assert.match(builder, /findConductorStall/);
  assert.match(builder, /isStalled/);
  assert.match(builder, /buildPhase: buildPhaseRef\.current/);
  assert.match(shared, /findConductorStall/);
  assert.match(shared, /CONDUCTOR_CONTINUE_SUGGESTIONS/);
  assert.match(suggestions, /isStalled/);
});
