import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { buildTranscriptSegments, reorderAssistantTranscriptParts } = await import(
  "../../../dashboard/src/components/conductor/transcript-stream-order.ts"
);

const text = (value: string) => ({ type: "text" as const, text: value });
const thought = (value: string) => ({ type: "reasoning" as const, text: value, state: "done" as const });
const tool = (toolName: string) => ({
  type: "dynamic-tool" as const,
  toolName,
  toolCallId: `${toolName}-1`,
  state: "output-available" as const,
});

describe("reorderAssistantTranscriptParts", () => {
  it("keeps prose → tool → thought when already in narrative order", () => {
    const parts = [
      text("All using Gmail — nice and simple!"),
      tool("patchLoopSpec"),
      thought("Planning the Gmail lookup."),
      text("Now let me look up the available actions."),
    ];

    assert.deepEqual(reorderAssistantTranscriptParts(parts), parts);
  });

  it("moves thought after non-patch tools when prose is followed by thought then tool", () => {
    const parts = [
      text("Looking up Gmail triggers."),
      thought("Calling listTriggers."),
      tool("listTriggers"),
      text("Now let me look up the available actions."),
    ];

    assert.deepEqual(reorderAssistantTranscriptParts(parts), [
      text("Looking up Gmail triggers."),
      tool("listTriggers"),
      thought("Calling listTriggers."),
      text("Now let me look up the available actions."),
    ]);
  });

  it("keeps thought before patchLoopSpec when prose is followed by thought then patch", () => {
    const parts = [
      text("Now I have all the details."),
      thought("Updating the spec."),
      tool("patchLoopSpec"),
    ];

    assert.deepEqual(reorderAssistantTranscriptParts(parts), parts);
  });

  it("moves leading thought into the patch beat", () => {
    const parts = [
      thought("Starting patch."),
      text("Now I have all the details."),
      tool("patchLoopSpec"),
    ];

    assert.deepEqual(reorderAssistantTranscriptParts(parts), parts);
  });
});

describe("buildTranscriptSegments", () => {
  it("clusters thought, prose, and patch into one beat", () => {
    const parts = [
      tool("listTriggers"),
      thought("Fetched triggers."),
      tool("listActions"),
      thought("Fetched actions."),
      text("Now I have all the details."),
      tool("patchLoopSpec"),
    ];

    assert.deepEqual(buildTranscriptSegments(parts), [
      { type: "part", part: tool("listTriggers") },
      { type: "part", part: thought("Fetched triggers.") },
      { type: "part", part: tool("listActions") },
      {
        type: "patch-beat",
        parts: [
          thought("Fetched actions."),
          text("Now I have all the details."),
          tool("patchLoopSpec"),
        ],
      },
    ]);
  });

  it("includes leading thought inside the patch beat", () => {
    const parts = [
      tool("listActions"),
      thought("Ready to patch."),
      text("Now I have all the details."),
      tool("patchLoopSpec"),
    ];

    assert.deepEqual(buildTranscriptSegments(parts), [
      { type: "part", part: tool("listActions") },
      {
        type: "patch-beat",
        parts: [
          thought("Ready to patch."),
          text("Now I have all the details."),
          tool("patchLoopSpec"),
        ],
      },
    ]);
  });
});
