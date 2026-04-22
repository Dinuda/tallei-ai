import assert from "node:assert/strict";
import test from "node:test";

import { isRetriableProviderError, mapProviderError } from "../../../src/providers/ai/errors.js";
import { ProviderFatalError, ProviderTransientError } from "../../../src/shared/errors/provider-errors.js";

test("mapProviderError treats API connection failures as transient", () => {
  const error = Object.assign(new Error("Connection error."), {
    name: "APIConnectionError",
    cause: new TypeError("fetch failed"),
  });

  const mapped = mapProviderError("ollama", error);
  assert.ok(mapped instanceof ProviderTransientError);
  assert.equal(isRetriableProviderError(error), true);
});

test("mapProviderError keeps unknown non-network errors as fatal", () => {
  const error = new Error("Unexpected invariant failure");
  const mapped = mapProviderError("ollama", error);
  assert.ok(mapped instanceof ProviderFatalError);
});
