import assert from "node:assert/strict";
import test from "node:test";

import type { UIMessage } from "ai";

test("builderRunningCommandLabel describes saveLoop work", async () => {
  const { builderRunningCommandLabel } = await import(
    "../../../dashboard/src/lib/builder-session-recovery.ts"
  );
  assert.equal(
    builderRunningCommandLabel({ toolName: "saveLoop", status: "running" }),
    "Saving and testing your loop…",
  );
});

test("dashboard recovery does not flag pending UI requirement gates as interrupted", async () => {
  const { detectBuilderRecoveryState } = await import(
    "../../../dashboard/src/lib/builder-session-recovery.ts"
  );
  const state = detectBuilderRecoveryState({
    messages: [{
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool-requirementSetup",
        toolCallId: "tool-1",
        state: "input-available",
        input: {
          requirementId: "review_policy",
          question: "How should replies be reviewed before sending?",
          options: [
            { id: "each", label: "Approve each reply", value: "approve_each_action" },
            { id: "drafts", label: "Create drafts only", value: "draft_only" },
          ],
        },
      }],
    }] as UIMessage[],
    commands: [],
    chatStatus: "ready",
  });
  assert.equal(state.kind, "idle");
});

test("dashboard latestUserPromptText returns the latest user prompt", async () => {
  const { latestUserPromptText } = await import(
    "../../../dashboard/src/lib/builder-session-recovery.ts"
  );
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Create a loop" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Working" }] },
  ] as UIMessage[];

  assert.equal(latestUserPromptText(messages), "Create a loop");
});

test("trimBuilderMessagesForPersistence strips rendered email HTML from artifact outputs", async () => {
  const { trimBuilderMessagesForPersistence } = await import(
    "../../../dashboard/src/lib/builder-session-recovery.ts"
  );
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
        templates: [{
          id: "t1",
          name: "Acknowledgment",
          html: "<html>large rendered body</html>",
          text: "plain text body",
          editorContent: "<p>editor</p>",
          subject: "Re: {{ticket.subject}}",
        }],
        value: {
          mode: "supplied_template",
          template: JSON.stringify({
            designId: "minimal",
            templates: [{
              id: "t1",
              html: "<html>large rendered body</html>",
              text: "plain text body",
              editorContent: "<p>editor</p>",
            }],
          }),
        },
      },
    }],
  }] as UIMessage[];

  const trimmed = trimBuilderMessagesForPersistence(messages);
  const output = trimmed[0]?.parts[0] && "output" in trimmed[0].parts[0]
    ? trimmed[0].parts[0].output as Record<string, unknown>
    : null;
  const template = Array.isArray(output?.templates) ? output.templates[0] as Record<string, unknown> : null;

  assert.equal(template?.subject, "Re: {{ticket.subject}}");
  assert.equal(template?.html, undefined);
  assert.equal(template?.text, undefined);
  assert.equal(template?.editorContent, undefined);
  assert.equal(output?.artifactPersisted, true);
  assert.deepEqual(output?.value, { mode: "supplied_template" });
});
