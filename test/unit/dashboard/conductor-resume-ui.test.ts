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

test("evaluateConductorStall flags text-only mid-phase stalls for recovery", async () => {
  const { evaluateConductorStall } = await import("@tallei/shared/conductor-turn-budget.js");
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

test("findConductorStall does not stall when loop status is active", async () => {
  const { findConductorStall } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "text",
      text: "Your automation is live.",
    }],
  }] satisfies UIMessage[];
  const stall = findConductorStall({
    messages,
    buildPhase: "activation",
    missingSlots: [],
    chatBusy: false,
    loopStatus: "active",
  });
  assert.equal(stall.stalled, false);
});

test("findConductorStall does not stall after activation when phaseProgress is terminal", async () => {
  const { findConductorStall } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-activateLoop",
        toolCallId: "activate-1",
        state: "output-available",
        input: { confirmedByUser: true },
        output: {
          ok: true,
          turnOutcome: "build_complete",
          alreadyActive: true,
          status: "active",
        },
      }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      parts: [{
        type: "text",
        text: "Your automation is live and ready to run on schedule.",
      }],
    },
  ] satisfies UIMessage[];
  const stall = findConductorStall({
    messages,
    buildPhase: "activation",
    missingSlots: ["activation"],
    chatBusy: false,
    loopStatus: "draft",
    phaseProgress: {
      phase: "activation",
      status: "complete",
      terminal: true,
      reason: "activation_complete",
    },
  });
  assert.equal(stall.stalled, false);
});

test("findConductorStall leaves mid-phase continuation to the server resolver", async () => {
  const { findConductorStall } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "I'll pick up bindings on the next step." }],
  }] satisfies UIMessage[];
  const stall = findConductorStall({
    messages,
    buildPhase: "bindings",
    missingSlots: [],
    chatBusy: false,
    loopStatus: "draft",
    phaseProgress: {
      phase: "bindings",
      status: "in_progress",
      terminal: false,
      nextTool: "discoverBindings",
    },
  });
  assert.equal(stall.stalled, false);
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
    isStalled: true,
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

test("findConductorStall does not stall when phaseProgress reports activation complete", async () => {
  const { findConductorStall } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Your automation is live." }],
  }] satisfies UIMessage[];
  const stall = findConductorStall({
    messages,
    buildPhase: "activation",
    missingSlots: ["activation"],
    chatBusy: false,
    loopStatus: "draft",
    phaseProgress: {
      phase: "activation",
      status: "complete",
      terminal: true,
      reason: "activation_complete",
      nextTool: null,
    },
  });
  assert.equal(stall.stalled, false);
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
    isStalled: true,
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

test("findConductorStall does not stall when phaseProgress is unknown", async () => {
  const { findConductorStall } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Your automation is live." }],
  }] satisfies UIMessage[];
  const stall = findConductorStall({
    messages,
    buildPhase: "activation",
    missingSlots: ["activation"],
    chatBusy: false,
    loopStatus: "draft",
    phaseProgress: null,
  });
  assert.equal(stall.stalled, false);
});

test("hasTerminalExecution treats build_complete as terminal", async () => {
  const { findConductorStall } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-activateLoop",
      toolCallId: "activate-1",
      state: "output-available",
      input: { confirmedByUser: true },
      output: {
        ok: true,
        operationKey: "activation:test:activateLoop:activate:plan",
        parentArtifactHash: "test-hash",
        phaseCompleted: false,
        requiresUserInput: false,
        retryAllowed: true,
        turnOutcome: "build_complete",
        continuation: "stop",
        alreadyActive: true,
        status: "active",
      },
    }],
  }] satisfies UIMessage[];
  const stall = findConductorStall({
    messages,
    buildPhase: "activation",
    missingSlots: [],
    chatBusy: false,
    loopStatus: "draft",
  });
  assert.equal(stall.stalled, false);
});

test("isPhaseHandoffPending detects roster without confirmation", async () => {
  const { isPhaseHandoffPending } = await import("@tallei/shared/conductor-phase-handoff.js");
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

  assert.equal(isPhaseHandoffPending({ messages, buildPhase: "review" }), true);
  assert.equal(isPhaseHandoffPending({ messages, buildPhase: "compile" }), false);
});

test("isPhaseHandoffPending detects connector discovery without pick", async () => {
  const { isPhaseHandoffPending } = await import("@tallei/shared/conductor-phase-handoff.js");
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-discoverConnectorsForBlueprint",
        toolCallId: "discover-1",
        state: "output-available",
        input: {},
        output: {
          ok: true,
          groups: [{
            outcomeId: "read",
            role: "source",
            askOptions: [{ id: "gmail", label: "Gmail", value: "gmail" }],
          }],
        },
      }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      parts: [{ type: "text", text: "Gmail looks like the right app for reading email." }],
    },
  ] satisfies UIMessage[];

  assert.equal(isPhaseHandoffPending({ messages, buildPhase: "connectors" }), true);
});

test("evaluateConductorStall stays inert while confirmation is pending", async () => {
  const { isPhaseHandoffPending } = await import("@tallei/shared/conductor-phase-handoff.js");
  const { evaluateConductorStall } = await import("@tallei/shared/conductor-turn-budget.js");
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
    phaseHandoffPending: isPhaseHandoffPending({
      messages,
      buildPhase: "review",
    }),
  });
  assert.equal(stall.stalled, false);
});

test("conductor builder uses server continuation intent instead of transcript auto-send", async () => {
  const fs = await import("node:fs/promises");
  const [builder, continuationHook] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/use-conductor-continuation.ts", import.meta.url), "utf8"),
  ]);
  assert.match(builder, /useConductorContinuation/);
  assert.match(builder, /parseContinuationIntent/);
  assert.match(builder, /continuationIntent/);
  assert.match(builder, /void sendMessage\(\)/);
  // UI-tool answers still use sendAutomaticallyWhen; phase handoff uses server intent.
  assert.match(builder, /sendAutomaticallyWhen/);
  assert.doesNotMatch(builder, /findPendingConductorPhaseHandoff/);
  assert.match(continuationHook, /trigger !== "phase_handoff"/);
  assert.match(continuationHook, /sessionActionRef/);
});

test("shouldAutoSendConductorChat is deprecated in favor of server continuation intent", async () => {
  const fs = await import("node:fs/promises");
  const shared = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );
  assert.match(shared, /@tallei\/shared\/conductor-stall-recovery/);
  assert.doesNotMatch(shared, /Transcript-inferred auto-continue/i);
  assert.match(shared, /return false/);
});

test("shouldAutoSendConductorChat no longer auto-continues on generic non-terminal tool output in source", async () => {
  const fs = await import("node:fs/promises");
  const shared = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );
  assert.match(shared, /return false/);
  assert.doesNotMatch(shared, /executions\.length === 0\) return true/);
});

test("phase handoff continuation is owned by useConductorContinuation", async () => {
  const fs = await import("node:fs/promises");
  const builder = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(builder, /findPendingConductorPhaseHandoff/);
  assert.doesNotMatch(builder, /persistedPhase !== handoff\.nextPhase/);
  assert.match(builder, /useConductorContinuation/);
});

test("shouldAutoSendConductorChat stops auto-continue on recoverable compile prerequisite miss in source", async () => {
  const fs = await import("node:fs/promises");
  const shared = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(shared, /if \(recoverable\) return true/);
  assert.match(shared, /turnOutcome === "phase_complete"/);
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

test("shouldAutoSendConductorChat continues after a fully answered UI tool", async () => {
  const { shouldAutoSendConductorChat } = await import(
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

  assert.equal(shouldAutoSendConductorChat({
    messages,
    buildPhase: "review",
    missingSlots: [],
    loopStatus: "draft",
    phaseProgress: null,
  }), true);
});

test("shouldAutoSendConductorChat continues after mixed-step UI answers despite stale pendingUiTool", async () => {
  const { shouldAutoSendConductorChat } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-mixed",
    role: "assistant",
    parts: [
      { type: "step-start" },
      {
        type: "tool-analyzeIntent",
        toolCallId: "analyze-1",
        state: "output-available",
        input: {},
        output: {
          ok: true,
          operationKey: "intent:root:analyzeIntent:intent",
          parentArtifactHash: "root",
          phaseCompleted: false,
          requiresUserInput: false,
          retryAllowed: true,
          turnOutcome: "progress",
          continuation: "continue_phase",
        },
      },
      { type: "step-start" },
      {
        type: "tool-askQuestion",
        toolCallId: "question-1",
        state: "output-available",
        input: {
          questionId: "review-policy",
          question: "Review replies?",
          options: [
            { id: "review", label: "Review", value: "review" },
            { id: "automatic", label: "Automatic", value: "automatic" },
          ],
        },
        output: {
          questionId: "review-policy",
          answerText: "Review",
          selectedOptionIds: ["review"],
          selectedValues: ["review"],
        },
      },
    ],
  }] satisfies UIMessage[];

  assert.equal(shouldAutoSendConductorChat({
    messages,
    buildPhase: "intent",
    phaseProgress: {
      phase: "intent",
      pendingUiTool: {
        toolCallId: "question-1",
        toolName: "askQuestion",
        input: {},
      },
    },
  }), true);
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

test("phase-complete handoff is detected for rendering but not transcript auto-send", async () => {
  const { findPendingConductorPhaseHandoff, shouldAutoSendConductorChat } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-compileLoop",
      toolCallId: "compile-1",
      state: "output-available",
      input: {},
      output: {
        ok: true,
        operationKey: "compile:review-hash:compileLoop:compile:review-hash",
        parentArtifactHash: "review-hash",
        phaseBefore: "compile",
        phaseAfter: "test",
        phaseCompleted: true,
        requiresUserInput: false,
        retryAllowed: true,
        invalidatedPhases: [],
        turnOutcome: "phase_complete",
        continuation: "next_phase",
        nextPhase: "test",
        handoffId: "compile-to-test",
        compiledPlanId: "22222222-2222-4222-8222-222222222222",
        stepsUsed: 1,
        stepLimit: 8,
      },
    }],
  }] satisfies UIMessage[];

  assert.equal(shouldAutoSendConductorChat({
    messages,
    buildPhase: "compile",
    missingSlots: [],
    loopStatus: "draft",
  }), false);
  assert.equal(findPendingConductorPhaseHandoff(messages)?.nextPhase, "test");
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

test("shouldAutoSendConductorChat does not auto-continue on ordinary progress output", async () => {
  const { shouldAutoSendConductorChat } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-discoverBindings",
      toolCallId: "discover-1",
      state: "output-available",
      input: { toolkit: "gmail" },
      output: {
        ok: true,
        operationKey: "bindings:connector-hash:discoverBindings:toolkit:gmail",
        parentArtifactHash: "connector-hash",
        phaseBefore: "bindings",
        phaseAfter: "bindings",
        phaseCompleted: false,
        requiresUserInput: false,
        retryAllowed: true,
        invalidatedPhases: [],
        turnOutcome: "progress",
        continuation: "continue_phase",
        stepsUsed: 1,
        stepLimit: 12,
      },
    }],
  }] satisfies UIMessage[];

  assert.equal(shouldAutoSendConductorChat({
    messages,
    buildPhase: "bindings",
    missingSlots: ["bindings.trigger"],
    loopStatus: "draft",
    phaseProgress: {
      phase: "bindings",
      status: "in_progress",
      terminal: false,
    },
  }), false);
});

test("shouldAutoSendConductorChat does not replay activation after loop is active", async () => {
  const { shouldAutoSendConductorChat } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-presentReplyOptions",
        toolCallId: "reply-1",
        state: "output-available",
        input: {
          options: [
            { id: "activate", label: "Yes, turn it on!", message: "Yes, turn it on!" },
          ],
        },
        output: {
          selectedOptionId: "activate",
          message: "Yes, turn it on!",
        },
      }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      parts: [{
        type: "tool-activateLoop",
        toolCallId: "activate-1",
        state: "output-available",
        input: { confirmedByUser: true },
        output: {
          ok: true,
          turnOutcome: "build_complete",
          status: "active",
        },
      }],
    },
  ] satisfies UIMessage[];

  assert.equal(shouldAutoSendConductorChat({
    messages,
    buildPhase: "activation",
    missingSlots: [],
    loopStatus: "active",
    phaseProgress: {
      phase: "activation",
      status: "complete",
      terminal: true,
      reason: "activation_complete",
    },
  }), false);
});

test("shouldAutoSendConductorChat does not replay answered UI tools when build is terminal", async () => {
  const { shouldAutoSendConductorChat } = await import(
    "../../../dashboard/src/components/conductor/conductor-shared.ts"
  );
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-presentReplyOptions",
      toolCallId: "reply-1",
      state: "output-available",
      input: {
        options: [
          { id: "activate", label: "Yes, turn it on!", message: "Yes, turn it on!" },
        ],
      },
      output: {
        selectedOptionId: "activate",
        message: "Yes, turn it on!",
      },
    }],
  }] satisfies UIMessage[];

  assert.equal(shouldAutoSendConductorChat({
    messages,
    buildPhase: "activation",
    missingSlots: [],
    loopStatus: "active",
    phaseProgress: {
      phase: "activation",
      status: "complete",
      terminal: true,
      reason: "activation_complete",
    },
  }), false);
});

test("shouldAutoSendConductorChat is a no-op stub after server continuation migration", async () => {
  const fs = await import("node:fs/promises");
  const shared = await fs.readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );
  assert.match(shared, /@tallei\/shared\/conductor-stall-recovery/);
  assert.doesNotMatch(shared, /Transcript-inferred auto-continue/i);
  assert.match(shared, /return false/);
});

test("conductor builder wires server continuation intent and UI answer send", async () => {
  const fs = await import("node:fs/promises");
  const [builder, shared, suggestions] = await Promise.all([
    fs.readFile(new URL("../../../dashboard/src/components/conductor-builder.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../dashboard/src/lib/conductor-prompt-suggestions.ts", import.meta.url), "utf8"),
  ]);

  assert.match(builder, /phaseProgress/);
  assert.match(builder, /buildProgress\?\.continuationIntent/);
  assert.match(builder, /findConductorStall/);
  assert.match(builder, /isStalled/);
  assert.match(builder, /useConductorContinuation/);
  assert.match(builder, /setHydrationReady/);
  assert.match(builder, /answeredToolResumeRef/);
  assert.match(shared, /findConductorStall/);
  assert.match(shared, /findPendingInteractivePrompts/);
  assert.match(suggestions, /isStalled/);
});
