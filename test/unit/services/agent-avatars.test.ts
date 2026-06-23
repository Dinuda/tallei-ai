import assert from "node:assert/strict";
import test from "node:test";

import { pool } from "../../../src/infrastructure/db/index.js";
import {
  allocateAgentAvatars,
  bindAgentAvatar,
} from "../../../src/services/conductor/services/avatar.service.js";

const auth = {
  tenantId: "00000000-0000-4000-8000-000000000010",
  userId: "00000000-0000-4000-8000-000000000011",
  scopes: ["memory:write"],
};

test("allocateAgentAvatars creates unique allocated avatars", async () => {
  const originalQuery = pool.query.bind(pool);
  const inserts: string[] = [];

  try {
    (pool as unknown as { query: typeof pool.query }).query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO loop_agent_avatars")) {
        const seed = String(params?.[2] ?? "");
        inserts.push(seed);
        return {
          rows: [{
            id: `avatar-${inserts.length}`,
            style: "dylan",
            seed,
            status: "allocated",
            bound_spec_id: null,
            bound_agent_id: null,
            bound_at: null,
            created_at: new Date().toISOString(),
          }],
        };
      }
      return originalQuery(sql, params);
    }) as typeof pool.query;

    const avatars = await allocateAgentAvatars(auth, 2);
    assert.equal(avatars.length, 2);
    assert.equal(avatars[0]?.status, "allocated");
    assert.notEqual(avatars[0]?.seed, avatars[1]?.seed);
    assert.match(avatars[0]?.url ?? "", /api\.dicebear\.com\/10\.x\/dylan\/svg/);
  } finally {
    (pool as unknown as { query: typeof pool.query }).query = originalQuery;
  }
});

test("bindAgentAvatar rejects rebinding", async () => {
  const originalQuery = pool.query.bind(pool);
  const avatarId = "00000000-0000-4000-8000-000000000099";
  const specId = "00000000-0000-4000-8000-000000000088";

  try {
    (pool as unknown as { query: typeof pool.query }).query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id, style, seed, status")) {
        return {
          rows: [{
            id: avatarId,
            style: "dylan",
            seed: "seed-1",
            status: "bound",
            bound_spec_id: specId,
            bound_agent_id: "research_agent",
            bound_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          }],
        };
      }
      return originalQuery(sql, params);
    }) as typeof pool.query;

    await assert.rejects(
      () => bindAgentAvatar(auth, avatarId, { specId, agentId: "writer_agent" }),
      /already bound/i,
    );
  } finally {
    (pool as unknown as { query: typeof pool.query }).query = originalQuery;
  }
});
