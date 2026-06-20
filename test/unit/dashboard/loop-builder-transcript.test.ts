import assert from "node:assert/strict";
import test from "node:test";

test("shouldRenderBuilderTranscriptText keeps short pre-tool narration visible", async () => {
  const { shouldRenderBuilderTranscriptText } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );
  const parts = [
    { type: "text", text: "Great" },
    { type: "tool-appSelection", toolCallId: "1", state: "input-available", input: {}, output: {} },
  ] as never[];

  assert.equal(
    shouldRenderBuilderTranscriptText({ text: "Great", partIndex: 0, parts, messageRole: "assistant" }),
    true,
  );
});

test("builderFallbackNarration waits until the assistant turn stops streaming", async () => {
  const { builderFallbackNarration } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );
  const parts = [
    { type: "tool-appSelection", toolCallId: "1", state: "input-available", input: {
      question: "Which app do your customers use to reach out for support?",
    }, output: {} },
  ] as never[];

  assert.equal(
    builderFallbackNarration(parts, { isStreaming: true }),
    null,
  );
  assert.equal(
    builderFallbackNarration(parts, { isStreaming: false }),
    "Which app do your customers use to reach out for support?",
  );
});

test("builderFallbackNarration is skipped when visible narration already exists", async () => {
  const { builderFallbackNarration } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );
  const parts = [
    { type: "text", text: "Your loop is ready to review." },
    { type: "tool-appSelection", toolCallId: "1", state: "input-available", input: {
      question: "Which app do your customers use to reach out for support?",
    }, output: {} },
  ] as never[];

  assert.equal(builderFallbackNarration(parts), null);
});

test("shouldRenderBuilderTranscriptText shows every substantive block after streaming settles", async () => {
  const { shouldRenderBuilderTranscriptText } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );
  const parts = [
    { type: "text", text: "Let me start by understanding the intent and getting the apps you'd like to use." },
    { type: "tool-getAvailableTools", toolCallId: "1", state: "output-available", input: {}, output: {} },
    { type: "text", text: "First, where do your support tickets come from — what app handles your ticketing?" },
    { type: "tool-appSelection", toolCallId: "2", state: "input-available", input: {}, output: {} },
  ] as never[];

  assert.equal(
    shouldRenderBuilderTranscriptText({
      text: "Let me start by understanding the intent and getting the apps you'd like to use.",
      partIndex: 0,
      parts,
      messageRole: "assistant",
      isStreaming: false,
    }),
    true,
  );
  assert.equal(
    shouldRenderBuilderTranscriptText({
      text: "First, where do your support tickets come from — what app handles your ticketing?",
      partIndex: 2,
      parts,
      messageRole: "assistant",
      isStreaming: false,
    }),
    true,
  );
});

test("shouldRenderBuilderTranscriptText hides all but the final narration in tool turns", async () => {
  const { shouldRenderBuilderTranscriptText } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );
  const parts = [
    { type: "text", text: "Great" },
    { type: "tool-appSelection", toolCallId: "1", state: "output-available", input: {}, output: {} },
    { type: "text", text: "Got it." },
    { type: "tool-connectorSetup", toolCallId: "2", state: "output-available", input: {}, output: {} },
    { type: "text", text: "Your loop is ready to review. I drafted agents for intake, triage, and reply drafting." },
  ] as never[];

  assert.equal(
    shouldRenderBuilderTranscriptText({ text: "Great", partIndex: 0, parts, messageRole: "assistant" }),
    false,
  );
  assert.equal(
    shouldRenderBuilderTranscriptText({ text: "Got it.", partIndex: 2, parts, messageRole: "assistant" }),
    false,
  );
  assert.equal(
    shouldRenderBuilderTranscriptText({
      text: "Your loop is ready to review. I drafted agents for intake, triage, and reply drafting.",
      partIndex: 4,
      parts,
      messageRole: "assistant",
    }),
    true,
  );
});

test("shouldRenderBuilderTranscriptText keeps plain assistant replies", async () => {
  const { shouldRenderBuilderTranscriptText } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );
  const parts = [{ type: "text", text: "Tell me more about your support workflow." }] as never[];
  assert.equal(
    shouldRenderBuilderTranscriptText({
      text: "Tell me more about your support workflow.",
      partIndex: 0,
      parts,
      messageRole: "assistant",
    }),
    true,
  );
});

test("shouldRenderBuilderTranscriptText keeps settled narration visible while streaming", async () => {
  const { shouldRenderBuilderTranscriptText } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );
  const parts = [
    { type: "text", text: "Great, I can see all the Gmail actions available." },
    { type: "tool-getAvailableTools", toolCallId: "1", state: "output-available", input: {}, output: {} },
    { type: "text", text: "Let me connect your Gmail account." },
  ] as never[];

  assert.equal(
    shouldRenderBuilderTranscriptText({
      text: "Let me connect your Gmail account.",
      partIndex: 2,
      parts,
      messageRole: "assistant",
      isStreaming: true,
    }),
    true,
  );
  assert.equal(
    shouldRenderBuilderTranscriptText({
      text: "Great, I can see all the Gmail actions available.",
      partIndex: 0,
      parts,
      messageRole: "assistant",
      isStreaming: true,
    }),
    true,
  );
});

test("shouldRenderBuilderTranscriptText hides mid-stream frozen fragments during streaming", async () => {
  const { shouldRenderBuilderTranscriptText } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );
  const parts = [
    { type: "tool-getAvailableTools", toolCallId: "1", state: "output-available", input: {}, output: {} },
    { type: "text", text: "Great, I" },
    { type: "text", text: "Great, I can see all the Gmail actions available." },
  ] as never[];

  assert.equal(
    shouldRenderBuilderTranscriptText({
      text: "Great, I can see all the Gmail actions available.",
      partIndex: 2,
      parts,
      messageRole: "assistant",
      isStreaming: true,
    }),
    true,
  );
  assert.equal(
    shouldRenderBuilderTranscriptText({
      text: "Great, I",
      partIndex: 1,
      parts,
      messageRole: "assistant",
      isStreaming: true,
    }),
    false,
  );
});

test("prepareBuilderTranscriptParts preserves step order between tools", async () => {
  const { prepareBuilderTranscriptParts } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );
  const parts = [
    { type: "text", text: "Let me start by understanding the intent." },
    { type: "tool-getAvailableTools", toolCallId: "1", state: "output-available", input: {}, output: {} },
    { type: "text", text: "First, where do your support tickets come from?" },
    { type: "tool-appSelection", toolCallId: "2", state: "input-available", input: {}, output: {} },
  ] as never[];

  const prepared = prepareBuilderTranscriptParts(parts);
  assert.equal(prepared.length, 4);
  assert.equal(prepared[0]?.type, "text");
  assert.equal(prepared[1]?.type, "tool-getAvailableTools");
  assert.equal(prepared[2]?.type, "text");
  assert.equal(prepared[3]?.type, "tool-appSelection");
});

test("isSyntheticAutoContinueMessage detects auto-continue user turns", async () => {
  const { isSyntheticAutoContinueMessage } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );

  assert.equal(
    isSyntheticAutoContinueMessage({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "continue" }],
    }),
    true,
  );
  assert.equal(
    isSyntheticAutoContinueMessage({
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "Resume" }],
    }),
    true,
  );
  assert.equal(
    isSyntheticAutoContinueMessage({
      id: "u3",
      role: "user",
      parts: [{ type: "text", text: "Use Gmail for support" }],
    }),
    false,
  );
  // Empty user messages are NOT synthetic — they may carry tool-output continuations
  assert.equal(
    isSyntheticAutoContinueMessage({
      id: "u4",
      role: "user",
      parts: [],
    }),
    false,
  );
  assert.equal(
    isSyntheticAutoContinueMessage({
      id: "u5",
      role: "user",
      parts: [{ type: "text", text: "" }],
    }),
    false,
  );
});

test("filterBuilderTranscriptMessages removes synthetic auto-continue bubbles", async () => {
  const { filterBuilderTranscriptMessages } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );

  const filtered = filterBuilderTranscriptMessages([
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hello" }] },
    { id: "u1", role: "user", parts: [{ type: "text", text: "continue" }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "Set up Gmail monitoring" }] },
  ] as never[]);

  assert.equal(filtered.length, 2);
  assert.equal(filtered.some((message) => message.id === "u1"), false);
});

test("shouldShowBuilderThinking is true while submitted", async () => {
  const { shouldShowBuilderThinking } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );

  assert.equal(
    shouldShowBuilderThinking({
      status: "submitted",
      messages: [],
      hasComposerGate: false,
    }),
    true,
  );
});

test("shouldShowBuilderThinking is false when composer gate is active", async () => {
  const { shouldShowBuilderThinking } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );

  assert.equal(
    shouldShowBuilderThinking({
      status: "submitted",
      messages: [],
      hasComposerGate: true,
    }),
    false,
  );
});

test("shouldShowBuilderThinking is false when assistant already has visible tool output", async () => {
  const { shouldShowBuilderThinking } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );

  assert.equal(
    shouldShowBuilderThinking({
      status: "streaming",
      messages: [{
        id: "a1",
        role: "assistant",
        parts: [{
          type: "tool-requirementSetup",
          toolCallId: "1",
          state: "output-available",
          input: { question: "Review policy?", options: [{ id: "a", label: "Approve each" }] },
          output: { answerText: "approve_each_action", requirementId: "review_policy" },
        }],
      }],
      hasComposerGate: false,
    }),
    false,
  );
});

test("shouldShowBuilderThinking is true while streaming with no visible assistant content", async () => {
  const { shouldShowBuilderThinking } = await import(
    "../../../dashboard/src/lib/loop-builder-transcript.ts"
  );

  assert.equal(
    shouldShowBuilderThinking({
      status: "streaming",
      messages: [{
        id: "a1",
        role: "assistant",
        parts: [{
          type: "tool-resolveBuildRequirement",
          toolCallId: "1",
          state: "output-available",
          input: {},
          output: {},
        }],
      }],
      hasComposerGate: false,
    }),
    true,
  );
});
