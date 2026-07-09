import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transcriptPath = new URL(
  "../../../dashboard/src/components/conductor/conductor-builder-chat.tsx",
  import.meta.url,
);

test("conductor builder chat renders reasoning, text, and tool transcript parts", async () => {
  const source = await readFile(transcriptPath, "utf8");
  assert.match(source, /renderTranscriptPart/);
  assert.match(source, /ConductorReasoningPart/);
  assert.match(source, /ConductorToolPart/);
  assert.match(source, /MessageResponse/);
  assert.match(source, /buildTranscriptSegments/);
  assert.match(source, /AssistantTranscriptTurn/);
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
  assert.match(source, /isAnimating && isText/);
  assert.match(source, /whitespace-pre-wrap break-words/);
});

test("animation frame text hook batches via requestAnimationFrame without deferring transitions", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/hooks/use-animation-frame-text.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /cancelAnimationFrame/);
  assert.doesNotMatch(source, /startTransition\s*\(/);
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
