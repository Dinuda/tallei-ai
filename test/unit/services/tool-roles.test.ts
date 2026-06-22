import assert from "node:assert/strict";
import test from "node:test";

import {
  connectorToolRole,
  connectorToolRoleFromContract,
  isPlanReadTool,
  isPlanWriteTool,
  isSendLikeTool,
  toToolRoleInput,
} from "../../../src/services/loop-engine/tool-roles.js";
import type { ToolContract } from "../../../src/services/tool-spec/types.js";

function contract(
  actionSlug: string,
  effect: ToolContract["effect"],
  tags: ToolContract["skillTags"] = [],
): ToolContract {
  return {
    toolRef: `composio.gmail.action.${actionSlug}`,
    provider: "composio",
    name: actionSlug.replace(/_/g, " "),
    description: `Run ${actionSlug}`,
    skillTags: tags,
    effect,
    resources: ["gmail"],
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    executionMode: effect === "read_external" ? "short_circuit" : "approval_executed",
    approval: { required: effect !== "read_external" },
    renderRecommendations: [],
    constraints: { toolkit: "gmail", actionSlug, connected: true },
    source: "composio_sdk",
  };
}

test("connectorToolRole routes delivery slugs and draft_only remaps sends to draft", () => {
  const send = toToolRoleInput(contract("GMAIL_SEND_EMAIL", "irreversible_external", ["send"]));
  assert.equal(connectorToolRole(send, "approve_each_action"), "delivery");
  assert.equal(connectorToolRole(send, "draft_only"), "draft");

  const reply = toToolRoleInput(contract("GMAIL_REPLY_TO_THREAD", "read_external", ["reply"]));
  assert.equal(connectorToolRole(reply, "approve_each_action"), "delivery");
  assert.equal(isPlanReadTool(contract("GMAIL_REPLY_TO_THREAD", "read_external"), "approve_each_action"), false);
  assert.equal(isPlanWriteTool(contract("GMAIL_REPLY_TO_THREAD", "read_external"), "approve_each_action"), true);
});

test("isSendLikeTool detects irreversible and keyword sends", () => {
  assert.equal(isSendLikeTool(toToolRoleInput(contract("GMAIL_SEND_EMAIL", "irreversible_external", ["send"]))), true);
  assert.equal(isSendLikeTool(toToolRoleInput(contract("GMAIL_FETCH_EMAILS", "read_external", ["retrieve"]))), false);
});

test("connectorToolRoleFromContract classifies organize actions", () => {
  assert.equal(
    connectorToolRoleFromContract(contract("GMAIL_CREATE_LABEL", "write_external"), "approve_each_action"),
    "organize",
  );
  assert.equal(
    isPlanWriteTool(contract("GMAIL_CREATE_LABEL", "write_external"), "approve_each_action"),
    true,
  );
});
