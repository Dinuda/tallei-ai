import assert from "node:assert/strict";
import test from "node:test";

import { plannerRoleForToolContract } from "../../../src/services/conductor/domain/tool-roles.js";
import type { ToolContract } from "../../../src/services/tool-spec/types.js";

function contract(overrides: Partial<ToolContract>): ToolContract {
  return {
    toolRef: "composio.gmail.send_message",
    provider: "composio",
    name: "Send message",
    description: "",
    skillTags: [],
    effect: "write_external",
    resources: [],
    inputSchema: {},
    outputSchema: {},
    executionMode: "approval_executed",
    approval: { required: false },
    renderRecommendations: [],
    constraints: {},
    source: "static",
    ...overrides,
  };
}

test("plannerRoleForToolContract maps read connectors to read", () => {
  assert.equal(plannerRoleForToolContract(contract({ effect: "read_external" })), "read");
});

test("plannerRoleForToolContract maps draft skills to draft", () => {
  assert.equal(plannerRoleForToolContract(contract({ skillTags: ["draft"] })), "draft");
});

test("plannerRoleForToolContract maps write connectors to publish by default", () => {
  assert.equal(plannerRoleForToolContract(contract({ effect: "write_external" })), "publish");
});
