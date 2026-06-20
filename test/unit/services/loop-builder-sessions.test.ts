import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

import { normalizeWorkflowBuilderMessages, sanitizeLoopBuilderChatMessages } from "../../../src/services/loop-builder/sessions.js";

test("workflow builder messages discard empty interrupted-stream artifacts", () => {
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Build a loop" }] },
    { id: "assistant-empty", role: "assistant", parts: [] },
    null,
    { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Which schedule?" }] },
  ] satisfies Array<UIMessage | null>;

  assert.deepEqual(
    normalizeWorkflowBuilderMessages(messages).map((message) => message.id),
    ["user-1", "assistant-1"],
  );
});

test("workflow builder messages dedupe repeated message ids", () => {
  const duplicateAssistant = {
    id: "e29DJwYIhuWVY4yS",
    role: "assistant",
    parts: [{ type: "text", text: "First copy" }],
  } satisfies UIMessage;
  const messages = [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
    duplicateAssistant,
    { ...duplicateAssistant, parts: [{ type: "text", text: "Second copy" }] },
  ] satisfies UIMessage[];

  const normalized = normalizeWorkflowBuilderMessages(messages);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[1]?.parts[0]?.type === "text" ? normalized[1].parts[0].text : "", "First copy");
});

test("sanitizeLoopBuilderChatMessages strips OpenAI item ids from replayed history", () => {
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          text: "Planning connector setup",
          providerOptions: { openai: { itemId: "rs_123", reasoningEncryptedContent: "enc" } },
        },
        {
          type: "tool-connectorSetup",
          toolCallId: "call_1",
          state: "output-available",
          input: { requirementId: "connector" },
          output: { ok: true },
          providerMetadata: { openai: { itemId: "fc_456" } },
        } as UIMessage["parts"][number],
      ],
    },
  ] satisfies UIMessage[];

  const sanitized = sanitizeLoopBuilderChatMessages(messages);
  const reasoning = sanitized[0]?.parts[0];
  const toolPart = sanitized[0]?.parts[1] as { providerMetadata?: { openai?: { itemId?: string } } };
  assert.equal((reasoning as { providerOptions?: { openai?: { itemId?: string } } }).providerOptions?.openai?.itemId, undefined);
  assert.equal(toolPart.providerMetadata?.openai?.itemId, undefined);
  assert.equal((reasoning as { providerOptions?: { openai?: { reasoningEncryptedContent?: string } } }).providerOptions?.openai?.reasoningEncryptedContent, "enc");
});

test("sanitizeLoopBuilderChatMessages slims persisted artifact outputs for analyzer replay", () => {
  const messages = [{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "tool-artifactSetup",
      toolCallId: "tool-1",
      state: "output-available",
      input: { requirementId: "artifact_contract" },
      output: {
        requirementId: "artifact_contract",
        mode: "supplied_template",
        templates: [{ id: "t1", name: "Ack", html: "<p>Hi</p>", subject: "Re: ticket" }],
        value: {
          mode: "supplied_template",
          template: JSON.stringify({
            designId: "minimal",
            templates: [{ id: "t1", html: "<p>Hi</p>" }],
          }),
        },
      },
    } as UIMessage["parts"][number]],
  }] satisfies UIMessage[];

  const sanitized = sanitizeLoopBuilderChatMessages(messages);
  const output = sanitized[0]?.parts[0] && "output" in sanitized[0].parts[0]
    ? sanitized[0].parts[0].output as Record<string, unknown>
    : null;
  const template = Array.isArray(output?.templates) ? output.templates[0] as Record<string, unknown> : null;

  assert.equal(template?.html, undefined);
  assert.equal(output?.artifactPersisted, true);
  assert.deepEqual(output?.value, { mode: "supplied_template" });
});
