import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComposioActionContract,
  getStaticToolContract,
  isRenderTargetCompatible,
} from "../../../src/services/tool-spec/tool-contracts.js";

test("internal tools expose stable contracts and render recommendations", () => {
  const contract = getStaticToolContract("internal.llm_only");
  assert.ok(contract);
  assert.equal(contract.effect, "none");
  assert.equal(contract.executionMode, "llm_assisted");
  assert.equal(contract.approval.required, false);
  assert.equal(contract.renderRecommendations.some((rec) => rec.target === "canvas.email"), true);
});

test("Composio action contracts preserve SDK schemas and declared risk without use-case overrides", () => {
  const contract = buildComposioActionContract({
    toolkit: "resend",
    actionSlug: "RESEND_SEND_EMAIL",
    name: "Send Email",
    description: "Send an email using Resend.",
    risk: "send",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { id: { type: "string" } } },
  });
  assert.equal(contract.toolRef, "composio.resend.action.resend_send_email");
  assert.equal(contract.effect, "write_external");
  assert.equal(contract.approval.required, true);
  assert.equal(contract.source, "composio_sdk");
  assert.deepEqual(contract.resources, ["resend"]);
  assert.deepEqual(contract.renderRecommendations, []);
});

test("ambiguous Composio actions remain approval-gated generic write tools", () => {
  const contract = buildComposioActionContract({
    toolkit: "example",
    actionSlug: "EXAMPLE_DO_THING",
    name: "Do Thing",
    description: "Perform an operation.",
    risk: "write",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });
  assert.equal(contract.effect, "write_external");
  assert.equal(contract.approval.required, true);
  assert.equal(contract.source, "composio_sdk");
});

test("Composio action contracts require exact input and output schemas", () => {
  assert.throws(() => buildComposioActionContract({
    toolkit: "example",
    actionSlug: "EXAMPLE_DO_THING",
    risk: "write",
    inputSchema: { type: "object" },
  }), /without exact input and output schemas/);
});

test("dynamic connector contracts do not infer render behavior from names or descriptions", () => {
  const contract = buildComposioActionContract({
    toolkit: "docs",
    actionSlug: "DOCS_CREATE_PAGE",
    name: "Create Page",
    description: "Create a document page.",
    risk: "write",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { pageId: { type: "string" } } },
  });
  assert.equal(isRenderTargetCompatible(contract, "canvas.preview"), false);

  const opaque = buildComposioActionContract({
    toolkit: "example",
    actionSlug: "EXAMPLE_DO_THING",
    name: "Do Thing",
    description: "Perform an external operation.",
    risk: "write",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });
  assert.equal(isRenderTargetCompatible(opaque, "canvas.preview"), false);
  assert.equal(isRenderTargetCompatible(opaque, "canvas.email"), false);
});
