import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import { currentRequestTimingStore, runWithRequestTimingStore, createRequestTimingStore } from "../../../src/observability/request-timing.js";

process.env.TALLEI_HTTP__INTERNAL_API_SECRET ??= "test-internal-secret";
process.env.TALLEI_DB__URL ??= "postgresql://test:test@localhost:5432/test";
process.env.TALLEI_AUTH__JWT_SECRET ??= "test-jwt-secret";
process.env.TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH = "true";
process.env.TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH_SHADOW = "true";
process.env.TALLEI_FEATURE__VERTEX_DOCUMENT_SEARCH_NEW_USERS = "true";
process.env.TALLEI_VERTEX_SEARCH__TENANT_ALLOWLIST = "tenant-allow";
process.env.TALLEI_VERTEX_SEARCH__USER_ALLOWLIST = "user-allow";

const { selectDocumentSearchMode } = await import("../../../src/services/documents.js");
const { VertexDocumentSearchRepository } = await import("../../../src/infrastructure/repositories/document-search.repository.js");
const { signAgentEngineToken, verifyAgentEngineToken } = await import("../../../src/infrastructure/auth/agent-engine-token.js");

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "old-user",
    tenantId: "old-tenant",
    authMode: "oauth",
    plan: "pro",
    connectorType: "chatgpt",
    ...overrides,
  };
}

test("old connector users stay on legacy document search", () => {
  assert.equal(selectDocumentSearchMode(auth()), "legacy");
});

test("new Agent Engine users route to Vertex document search", () => {
  assert.equal(selectDocumentSearchMode(auth({ connectorType: "agent_engine" })), "vertex");
});

test("allowlisted old users can opt into Vertex document search", () => {
  assert.equal(selectDocumentSearchMode(auth({ userId: "user-allow" })), "vertex");
  assert.equal(selectDocumentSearchMode(auth({ tenantId: "tenant-allow" })), "vertex");
});

test("Agent Engine token marks requests as new runtime users", () => {
  const token = signAgentEngineToken({
    userId: "11111111-1111-4111-8111-111111111111",
    tenantId: "new-tenant",
    plan: "pro",
  });
  const verified = verifyAgentEngineToken(token);
  assert.equal(verified.connectorType, "agent_engine");
  assert.equal(selectDocumentSearchMode(verified), "vertex");
});

test("Vertex document search records low placeholder latency", async () => {
  const repo = new VertexDocumentSearchRepository();
  const store = createRequestTimingStore();

  await runWithRequestTimingStore(store, async () => {
    const results = await repo.searchDocuments("catalog pricing", auth({ connectorType: "agent_engine" }), 5);
    assert.deepEqual(results, []);
    const fields = currentRequestTimingStore()?.fields ?? {};
    assert.equal(typeof fields["vertex_document_search_ms"], "number");
    assert.ok(Number(fields["vertex_document_search_ms"]) < 50);
  });
});
