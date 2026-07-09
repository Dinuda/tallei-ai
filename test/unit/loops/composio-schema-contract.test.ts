import assert from "node:assert/strict";
import test from "node:test";

import { buildComposioToolContract } from "@tallei/composio-tools/schema-contract.js";

test("schema modifier hides runner-controlled fields while preserving the execution schema", () => {
  const originalInputSchema = {
    type: "object",
    required: ["item_id", "query", "verbose"],
    properties: {
      item_id: { type: "string" },
      query: { type: "string" },
      verbose: { type: "boolean" },
      max_results: { type: "integer" },
    },
  };
  const { contract, composioAction } = buildComposioToolContract({
    toolkit: "generic",
    actionSlug: "GENERIC_FETCH_ITEMS",
    inputSchema: originalInputSchema,
    outputSchema: { type: "object", properties: { items: { type: "array" } } },
    bindingRole: "source",
  });

  assert.deepEqual(contract.originalInputSchema, originalInputSchema);
  assert.deepEqual(Object.keys((contract.modifiedInputSchema.properties ?? {}) as object), ["item_id", "query"]);
  assert.deepEqual(contract.outputSufficiencyPaths, ["items"]);
  assert.deepEqual(
    composioAction.inputInstructions.find((row) => row.field === "verbose")?.sources,
    [{ type: "static", value: true, description: "Runner-controlled default for operational field verbose." }],
  );
});

test("schema modifier does not substitute one required id for another", () => {
  const { composioAction } = buildComposioToolContract({
    toolkit: "generic",
    actionSlug: "GENERIC_UPDATE_ITEM",
    inputSchema: {
      type: "object",
      required: ["item_id"],
      properties: { item_id: { type: "string" } },
    },
  });
  const sources = composioAction.inputInstructions[0]!.sources;

  assert.deepEqual(sources.map((source) => source.path), ["item_id", "item_id"]);
  assert.equal(sources.some((source) => source.type === "planner"), false);
});
