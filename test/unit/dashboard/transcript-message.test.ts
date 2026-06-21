import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transcriptPath = new URL(
  "../../../dashboard/src/components/ai-elements/transcript-message.tsx",
  import.meta.url,
);

test("transcript message renderer handles text, reasoning, tools, and agent persona", async () => {
  const source = await readFile(transcriptPath, "utf8");
  assert.match(source, /renderMessagePart/);
  assert.match(source, /TranscriptMessageContent/);
  assert.match(source, /coalesceAdjacentTextParts/);
  assert.match(source, /ExpandedReasoningBlock|expandReasoning/);
  assert.match(source, /AgentTurnHeader/);
  assert.match(source, /phase === "working"\s*\?\s*null/);
  assert.doesNotMatch(source, /statusText === "Running"/);
  assert.match(source, /isDataAgentPart/);
  assert.match(source, /CollapsibleTool/);
  assert.match(source, /findActiveToolPart/);
  const toolSource = await readFile(
    new URL("../../../dashboard/src/components/ai-elements/tool.tsx", import.meta.url),
    "utf8",
  );
  assert.match(toolSource, /data-tool-call/);
});

test("message response batches streamed text to animation frames", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/ai-elements/message.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /useAnimationFrameText/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /cancelAnimationFrame/);
});

test("code block highlighter does not set state during render", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/ai-elements/code-block.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /subscribers/);
  assert.match(source, /requestHighlightedTokens/);
  assert.doesNotMatch(source, /if\s*\([^)]*asyncKeyRef[\s\S]*?setAsyncTokens/);
});
