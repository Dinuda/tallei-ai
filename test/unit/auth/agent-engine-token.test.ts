import assert from "node:assert/strict";
import test from "node:test";

process.env.TALLEI_HTTP__INTERNAL_API_SECRET ??= "test-internal-secret";
process.env.TALLEI_DB__URL ??= "postgresql://test:test@localhost:5432/test";
process.env.TALLEI_AUTH__JWT_SECRET ??= "test-jwt-secret";

const { signAgentEngineToken, verifyAgentEngineToken } = await import("../../../src/infrastructure/auth/agent-engine-token.js");

test("agent engine token signs tenant and user identity", () => {
  const token = signAgentEngineToken({
    userId: "11111111-1111-4111-8111-111111111111",
    tenantId: "tenant-1",
    plan: "pro",
    expiresInSeconds: 60,
  });

  const auth = verifyAgentEngineToken(token);
  assert.equal(auth.userId, "11111111-1111-4111-8111-111111111111");
  assert.equal(auth.tenantId, "tenant-1");
  assert.equal(auth.plan, "pro");
  assert.equal(auth.authMode, "internal");
});

test("agent engine token rejects invalid signatures", () => {
  assert.throws(() => verifyAgentEngineToken("not-a-token"));
});
