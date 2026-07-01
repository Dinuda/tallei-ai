import assert from "node:assert/strict";
import test from "node:test";

import { CONDUCTOR_TOOL_DESCRIPTIONS } from "../../../src/loops/conductor-chat-prompts.js";
import {
  CONDUCTOR_TOOL_INPUT_EXAMPLES,
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
  reviewOutcomeBriefInputSchema,
  testRunLoopInputSchema,
} from "../../../src/loops/conductor-tools.js";
import { specPatchSchema } from "../../../src/loops/spec.js";

test("conductor tool examples satisfy their input schemas", () => {
  assert.deepEqual(analyzeIntentInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.analyzeIntent), CONDUCTOR_TOOL_INPUT_EXAMPLES.analyzeIntent);
  assert.deepEqual(askQuestionInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.askQuestion), CONDUCTOR_TOOL_INPUT_EXAMPLES.askQuestion);
  assert.deepEqual(specPatchSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.initialBlueprint), CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.initialBlueprint);
  assert.deepEqual(specPatchSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.connectorChoice), CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.connectorChoice);
  assert.deepEqual(specPatchSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.triggerAndBindings), CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.triggerAndBindings);
  assert.deepEqual(specPatchSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.confirmation), CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.confirmation);
  assert.deepEqual(
    discoverConnectorsForBlueprintInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverConnectorsForBlueprint),
    CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverConnectorsForBlueprint,
  );
  assert.deepEqual(pickConnectorAppInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.pickConnectorApp), CONDUCTOR_TOOL_INPUT_EXAMPLES.pickConnectorApp);
  assert.deepEqual(presentReplyOptionsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.presentReplyOptions), CONDUCTOR_TOOL_INPUT_EXAMPLES.presentReplyOptions);
  assert.deepEqual(listTriggersInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.listTriggers), CONDUCTOR_TOOL_INPUT_EXAMPLES.listTriggers);
  assert.deepEqual(listActionsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.listActions), CONDUCTOR_TOOL_INPUT_EXAMPLES.listActions);
  assert.deepEqual(discoverBindingsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverBindings), CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverBindings);
  assert.deepEqual(connectToolkitInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.connectToolkit), CONDUCTOR_TOOL_INPUT_EXAMPLES.connectToolkit);
  assert.deepEqual(
    listWorkspaceConnectorsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.listWorkspaceConnectors),
    CONDUCTOR_TOOL_INPUT_EXAMPLES.listWorkspaceConnectors,
  );
  assert.deepEqual(reviewOutcomeBriefInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.reviewOutcomeBrief), CONDUCTOR_TOOL_INPUT_EXAMPLES.reviewOutcomeBrief);
  assert.deepEqual(confirmOutcomeBriefInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.confirmOutcomeBrief), CONDUCTOR_TOOL_INPUT_EXAMPLES.confirmOutcomeBrief);
  assert.deepEqual(compileLoopInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.compileLoop), CONDUCTOR_TOOL_INPUT_EXAMPLES.compileLoop);
  assert.deepEqual(testRunLoopInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.testRunLoop), CONDUCTOR_TOOL_INPUT_EXAMPLES.testRunLoop);
  assert.deepEqual(activateLoopInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.activateLoop), CONDUCTOR_TOOL_INPUT_EXAMPLES.activateLoop);
});

test("conductor tool descriptions embed the validated schema examples directly", () => {
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.analyzeIntent, new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.analyzeIntent))));
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.askQuestion, new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.askQuestion))));
  assert.match(
    CONDUCTOR_TOOL_DESCRIPTIONS.patchLoopSpec,
    new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.initialBlueprint))),
  );
  assert.match(
    CONDUCTOR_TOOL_DESCRIPTIONS.patchLoopSpec,
    new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.connectorChoice))),
  );
  assert.match(
    CONDUCTOR_TOOL_DESCRIPTIONS.patchLoopSpec,
    new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.triggerAndBindings))),
  );
  assert.match(
    CONDUCTOR_TOOL_DESCRIPTIONS.patchLoopSpec,
    new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.confirmation))),
  );
  assert.match(
    CONDUCTOR_TOOL_DESCRIPTIONS.discoverConnectorsForBlueprint,
    new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverConnectorsForBlueprint))),
  );
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.pickConnectorApp, new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.pickConnectorApp))));
  assert.match(
    CONDUCTOR_TOOL_DESCRIPTIONS.presentReplyOptions,
    new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.presentReplyOptions))),
  );
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.listTriggers, new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.listTriggers))));
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.listActions, new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.listActions))));
  assert.match(
    CONDUCTOR_TOOL_DESCRIPTIONS.discoverBindings,
    new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverBindings))),
  );
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.connectToolkit, new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.connectToolkit))));
  assert.match(
    CONDUCTOR_TOOL_DESCRIPTIONS.listWorkspaceConnectors,
    new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.listWorkspaceConnectors))),
  );
  assert.match(
    CONDUCTOR_TOOL_DESCRIPTIONS.reviewOutcomeBrief,
    new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.reviewOutcomeBrief))),
  );
  assert.match(
    CONDUCTOR_TOOL_DESCRIPTIONS.confirmOutcomeBrief,
    new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.confirmOutcomeBrief))),
  );
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.compileLoop, new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.compileLoop))));
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.testRunLoop, new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.testRunLoop))));
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.activateLoop, new RegExp(escapeRegExp(JSON.stringify(CONDUCTOR_TOOL_INPUT_EXAMPLES.activateLoop))));
});

test("analyzeIntent prompt matches the canonical approval contract", () => {
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.analyzeIntent, /sensitiveRoles/);
  assert.match(CONDUCTOR_TOOL_DESCRIPTIONS.analyzeIntent, /send automatically => \{\"mode\":\"auto\"/);
  assert.doesNotMatch(CONDUCTOR_TOOL_DESCRIPTIONS.analyzeIntent, /\{\"type\":\"approval\"/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
