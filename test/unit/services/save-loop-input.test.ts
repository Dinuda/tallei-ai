import assert from "node:assert/strict";
import test from "node:test";

test("saveLoop input accepts null placeholders and normalizes them away", async () => {
  const {
    normalizeSaveLoopInput,
    saveLoopInputSchema,
    saveLoopRequestSchema,
  } = await import("../../../src/services/conductor/inputs/save-loop-input.ts?t=nullable");

  const parsedInput = saveLoopInputSchema.parse({
    cron: null,
    timezone: null,
    workspaceId: null,
  });
  assert.deepEqual(parsedInput, {
    cron: null,
    timezone: null,
    workspaceId: null,
  });

  assert.deepEqual(normalizeSaveLoopInput(parsedInput), {});

  const request = saveLoopRequestSchema.parse({
    sessionId: "11111111-1111-4111-8111-111111111111",
    cron: null,
    timezone: null,
    workspaceId: null,
  });
  assert.equal(request.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(normalizeSaveLoopInput(request), {});
});
