import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hookPath = new URL(
  "../../../dashboard/src/hooks/use-animation-frame-text.ts",
  import.meta.url,
);

test("useAnimationFrameText coalesces rapid updates to one urgent rAF flush", async () => {
  const source = await readFile(hookPath, "utf8");
  assert.match(source, /latestTextRef\.current = value/);
  assert.match(source, /if \(frameRef\.current !== null\) return/);
  assert.match(source, /frameRef\.current = window\.requestAnimationFrame\(flush\)/);
  assert.match(source, /setDisplayText\(/);
  assert.doesNotMatch(source, /startTransition\s*\(/);
});

test("conductor builder chat memoizes frozen assistant turns", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-builder-chat.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /assistantTranscriptTurnPropsAreEqual/);
  assert.match(source, /messagePartsRevision/);
  assert.match(source, /TranscriptPartEnter/);
});

test("shimmer uses Framer Motion for thinking labels", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/ai-elements/shimmer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /motion\/react/);
  assert.match(source, /backgroundPosition/);
});

test("messagePartsRevision fingerprints text, reasoning, and tool parts", async () => {
  const source = await readFile(
    new URL("../../../dashboard/src/components/conductor/conductor-shared.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /export function messagePartsRevision/);
  assert.match(source, /part\.type === "reasoning"/);
});
