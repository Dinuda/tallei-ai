import assert from "node:assert/strict";
import test from "node:test";

test("personaFromSpecAgent preserves enriched persona fields", async () => {
  const { personaFromSpecAgent } = await import(
    "../../../dashboard/src/components/agent-persona/agent-persona.ts"
  );
  const persona = personaFromSpecAgent({
    name: "Draft Specialist",
    goal: "Draft replies",
    persona: {
      displayName: "Morgan Lee",
      roleKey: "writer",
      roleLabel: "Writer",
      avatarSeed: "seed-1",
    },
  }, 0);
  assert.equal(persona.displayName, "Morgan Lee");
  assert.equal(persona.roleKey, "writer");
});

test("personaFromSpecAgent synthesizes a fallback persona from agent name", async () => {
  const { personaFromSpecAgent } = await import(
    "../../../dashboard/src/components/agent-persona/agent-persona.ts"
  );
  const persona = personaFromSpecAgent({
    name: "Delivery Specialist",
    goal: "Send approved replies",
  }, 2);
  assert.equal(persona.displayName, "Delivery Specialist");
  assert.equal(persona.roleKey, "generalist");
  assert.match(persona.avatarSeed, /builder-delivery-specialist-2/);
});
