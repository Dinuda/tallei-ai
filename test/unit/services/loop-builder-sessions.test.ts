import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";

import { normalizeWorkflowBuilderMessages } from "../../../src/services/loop-builder/sessions.js";

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
