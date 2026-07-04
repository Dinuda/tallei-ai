import assert from "node:assert/strict";
import test from "node:test";

import { CONDUCTOR_TOOL_DESCRIPTIONS } from "../../../src/loops/conductor-chat-prompts.js";
import {
  activateLoopInputSchema,
  analyzeIntentInputSchema,
  askQuestionInputSchema,
  compileLoopInputSchema,
  connectToolkitInputSchema,
  confirmOutcomeBriefInputSchema,
  discoverBindingsInputSchema,
  discoverConnectorsForBlueprintInputSchema,
  listActionsInputSchema,
  listTriggersInputSchema,
  listWorkspaceConnectorsInputSchema,
  pickConnectorAppInputSchema,
  presentReplyOptionsInputSchema,
  presentAgentTeamInputSchema,
  testRunLoopInputSchema,
  resolveBindingsInputSchema,
} from "../../../src/loops/conductor-tools.js";
import { CONDUCTOR_TOOL_INPUT_EXAMPLES } from "./fixtures/conductor-tool-input-examples.js";

test("test-only conductor examples satisfy production schemas", () => {
  analyzeIntentInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.analyzeIntent);
  askQuestionInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.askQuestion);
  discoverConnectorsForBlueprintInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverConnectorsForBlueprint);
  pickConnectorAppInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.pickConnectorApp);
  assert.equal(pickConnectorAppInputSchema.safeParse({
    ...CONDUCTOR_TOOL_INPUT_EXAMPLES.pickConnectorApp,
    question: "Does that work for you?",
  }).success, false);
  presentReplyOptionsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.presentReplyOptions);
  presentAgentTeamInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.presentAgentTeam);
  listTriggersInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.listTriggers);
  listActionsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.listActions);
  discoverBindingsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverBindings);
  resolveBindingsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.resolveBindings);
  connectToolkitInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.connectToolkit);
  listWorkspaceConnectorsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.listWorkspaceConnectors);
  confirmOutcomeBriefInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.confirmOutcomeBrief);
  compileLoopInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.compileLoop);
  testRunLoopInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.testRunLoop);
  activateLoopInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.activateLoop);
});

test("runtime tool descriptions are generic and contain no serialized examples", () => {
  const descriptions = Object.values(CONDUCTOR_TOOL_DESCRIPTIONS).join("\n");
  assert.doesNotMatch(descriptions, /CONDUCTOR_TOOL_INPUT_EXAMPLES|schema example|matching this shape|Input shape/i);
  assert.doesNotMatch(descriptions, /gmail|email|inbox|mailbox|newsletter|support|ticket|customer|GMAIL_[A-Z_]+/i);
  assert.doesNotMatch(descriptions, /\{\s*"(?:outcome|taskBlueprint|briefHash)"/);
  assert.doesNotMatch(descriptions, /nextQuestion|single follow-up question/i);
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.analyzeIntent, /questions/i);
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.resolveBindings, /never construct/i);
});

test("every runtime tool has a non-empty behavioral description", () => {
  for (const [name, description] of Object.entries(CONDUCTOR_TOOL_DESCRIPTIONS)) {
    assert.ok(description.trim().length >= 40, `${name} needs a meaningful generic description`);
  }
});

test("bindings phase exposes server-driven atomic resolution", async () => {
  const route = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../../../src/transport/http/routes/loops.ts", import.meta.url),
    "utf8",
  ));
  assert.match(route, /case "bindings": return \[[^\]]*"askQuestion"[^\]]*"resolveBindings"/);
  assert.doesNotMatch(
    route.match(/case "connectors": return \[[^\]]*\]/)?.[0] ?? "",
    /resolveBindings|discoverBindings|listTriggers/,
  );
  assert.match(route, /type: "binding\.resolved"/);
  assert.match(route, /type: "binding\.diagnostic"/);
  assert.match(route, /case "compile": return \[[^\]]*"discoverBindings"[^\]]*"connectToolkit"/);
  assert.doesNotMatch(route, /setBindingConfig: tool/);
});

test("binding evaluation waits for explicit resolution before surfacing incomplete-state diagnostics", async () => {
  const route = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../../../src/transport/http/routes/loops.ts", import.meta.url),
    "utf8",
  ));
  const listTriggersBlock = route.slice(
    route.indexOf("listTriggers: tool({"),
    route.indexOf("listActions: tool({"),
  );
  assert.doesNotMatch(listTriggersBlock, /recordBindingsWhenComplete/);
  assert.doesNotMatch(listTriggersBlock, /diagnostics:/);
  assert.doesNotMatch(route, /recordBindingsWhenComplete/);
});

test("binding discovery accepts only a toolkit and resolution accepts no model-authored payload", () => {
  assert.deepEqual(discoverBindingsInputSchema.parse({ toolkit: "gmail" }), { toolkit: "gmail" });
  assert.equal(discoverBindingsInputSchema.safeParse({
    toolkit: "gmail",
    actionOverrides: [{ outcomeId: "send", actionSlug: "GMAIL_REPLY_TO_THREAD" }],
  }).success, false);
  assert.deepEqual(resolveBindingsInputSchema.parse({}), {});
  assert.equal(resolveBindingsInputSchema.safeParse({ config: { userId: "me" } }).success, false);
  assert.equal(discoverBindingsInputSchema.safeParse({
    toolkit: "gmail",
    outcomes: [{ id: "send", description: "Send reply", role: "destination" }],
  }).success, false);
});

test("binding discovery derives outcomes and resolution keys attempts by server evidence", async () => {
  const route = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../../../src/transport/http/routes/loops.ts", import.meta.url),
    "utf8",
  ));
  assert.match(route, /bindingActionOutcomesForToolkit\(currentSpec!, input\.toolkit\)/);
  assert.match(route, /resolveBindings", `evidence:\$\{evidenceHash\}`/);
  assert.match(route, /prepareBindingResolution/);
  assert.match(route, /filterBindingResolutionAnswers/);
});
