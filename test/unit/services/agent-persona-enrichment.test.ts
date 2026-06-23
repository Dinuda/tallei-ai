import assert from "node:assert/strict";
import test from "node:test";

import { enrichSpecAgentsWithPersonas } from "../../../src/services/conductor/services/personas/enrichment.js";
import { pickUniqueDisplayName } from "../../../src/services/conductor/services/personas/agent-personas.js";

test("pickUniqueDisplayName avoids duplicate display names in one roster", () => {
  const used = new Set<string>();
  const names = [
    pickUniqueDisplayName("seed-a", 0, used),
    pickUniqueDisplayName("seed-b", 1, used),
    pickUniqueDisplayName("seed-c", 2, used),
  ];
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
});

test("pickUniqueDisplayName respects names already assigned to prior agents", () => {
  const used = new Set<string>(["River"]);
  const next = pickUniqueDisplayName("seed-that-maps-to-river", 0, used);
  assert.notEqual(next, "River");
});

test("enrichSpecAgentsWithPersonas preserves compiled roleKey when reusing avatars", async () => {
  const auth = { tenantId: "tenant", userId: "user" };
  const previousAgent = {
    name: "Writer",
    goal: "Draft the message.",
    tools: ["internal.llm_only"],
    persona: {
      displayName: "Maya",
      roleKey: "generalist" as const,
      roleLabel: "Specialist",
      avatarId: "00000000-0000-4000-8000-000000000001",
      avatarSeed: "seed-1",
    },
  };
  const specJson = {
    purpose: "Draft message",
    agents: [{
      ...previousAgent,
      roleKey: "writer" as const,
      toolDomain: "draft" as const,
    }],
    guardrails: [],
    successCriteria: ["Draft ready"],
    failureModes: [],
    schedule: { description: "Manual" },
    delivery: { provider: "none", description: "Dashboard only" },
    connectorPolicy: { allowedReadActions: [], allowedWriteActions: [] },
    inputRequirements: [],
  };

  const enriched = await enrichSpecAgentsWithPersonas({
    auth,
    specId: "00000000-0000-4000-8000-000000000099",
    specJson,
    previousAgents: [previousAgent],
  });

  assert.equal(enriched.agents[0]?.persona?.displayName, "Maya");
  assert.equal(enriched.agents[0]?.persona?.roleKey, "writer");
  assert.equal(enriched.agents[0]?.persona?.roleLabel, "Writer");
});
