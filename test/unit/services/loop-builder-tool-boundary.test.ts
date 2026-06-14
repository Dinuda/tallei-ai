import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = new URL("../../../src/transport/http/routes/loopBuilder.ts", import.meta.url);
const dispatcherPath = new URL("../../../src/services/loop-builder/dispatcher.ts", import.meta.url);
const architectPath = new URL("../../../src/services/loop-engine/architect.ts", import.meta.url);
const builderPagePath = new URL("../../../dashboard/app/dashboard/loops/new/page.tsx", import.meta.url);

test("chat exposes real builder tools without synthetic intent tools", async () => {
  const [route, dispatcher] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(dispatcherPath, "utf8"),
  ]);

  assert.doesNotMatch(route, /nextChatCommand/);
  assert.doesNotMatch(dispatcher, /\|\s*"analyzeIntent"/);
  assert.doesNotMatch(dispatcher, /\|\s*"resolveClarifications"/);
  assert.match(dispatcher, /\|\s*"getAvailableTools"/);
  assert.match(route, /needsApproval:\s*true/);
});

test("option-based clarification uses the UI-only interactive prompt capability", async () => {
  const [route, dispatcher] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(dispatcherPath, "utf8"),
  ]);

  assert.match(route, /interactivePrompt:\s*tool\(/);
  assert.match(route, /including binary yes\/no questions/);
  assert.doesNotMatch(dispatcher, /\|\s*"interactivePrompt"/);
});

test("free text resolves a dismissed interactive prompt before continuing", async () => {
  const builderPage = await readFile(builderPagePath, "utf8");

  assert.match(builderPage, /activePromptId === dismissedPromptId/);
  assert.match(builderPage, /state:\s*"output-available",\s*output:\s*answer\s*}\s*as ToolPart/);
  assert.match(builderPage, /otherText:\s*answerText/);
  assert.match(builderPage, /role:\s*"user",\s*parts:\s*\[\{ type:\s*"text",\s*text:\s*answerText \}\]/);
  assert.match(builderPage, /await sendMessage\(\)/);
});

test("workflow architect consumes persisted contracts without Composio discovery", async () => {
  const architect = await readFile(architectPath, "utf8");

  assert.doesNotMatch(architect, /discoverToolsForLoopBuild/);
  assert.doesNotMatch(architect, /mergeDiscoveredTools/);
  assert.match(architect, /input\.discoveredToolContracts \?\? \[\]/);
  assert.match(architect, /requires persisted connector contracts discovered before drafting/);
});
