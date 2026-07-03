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
  testRunLoopInputSchema,
} from "../../../src/loops/conductor-tools.js";
import { specPatchSchema } from "../../../src/loops/spec.js";
import { CONDUCTOR_TOOL_INPUT_EXAMPLES } from "./fixtures/conductor-tool-input-examples.js";

test("test-only conductor examples satisfy production schemas", () => {
  analyzeIntentInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.analyzeIntent);
  askQuestionInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.askQuestion);
  specPatchSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.initialBlueprint);
  specPatchSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.connectorChoice);
  specPatchSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.triggerAndBindings);
  specPatchSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.patchLoopSpec.confirmation);
  discoverConnectorsForBlueprintInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverConnectorsForBlueprint);
  pickConnectorAppInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.pickConnectorApp);
  presentReplyOptionsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.presentReplyOptions);
  listTriggersInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.listTriggers);
  listActionsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.listActions);
  discoverBindingsInputSchema.parse(CONDUCTOR_TOOL_INPUT_EXAMPLES.discoverBindings);
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
  assert.doesNotMatch(descriptions, /gmail|support email|customer reply|GMAIL_[A-Z_]+/i);
  assert.doesNotMatch(descriptions, /\{\s*"(?:outcome|taskBlueprint|briefHash)"/);
});

test("every runtime tool has a non-empty behavioral description", () => {
  for (const [name, description] of Object.entries(CONDUCTOR_TOOL_DESCRIPTIONS)) {
    assert.ok(description.trim().length >= 40, `${name} needs a meaningful generic description`);
  }
});
