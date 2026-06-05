import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.OPENAI_API_KEY ??= "test-openai-key";
process.env.DATABASE_URL ??= "postgresql://tallei:tallei@127.0.0.1:5432/tallei";
process.env.DATABASE_URL_FALLBACK ??= process.env.DATABASE_URL;
process.env.REDIS_URL = "";

const SAMPLE_LLM_OUTPUT = {
  title: "Weekly product essay loop",
  summary: "Researches, drafts, and sends for approval before publishing.",
  strategyText: "Run memory search, research, brief, writer, then approval handoff.",
  agentGraph: {
    parent: {
      id: "parent_agent",
      name: "Parent Agent",
      task: "Coordinate weekly product essay production.",
      policy: "Route work to specialists; gate delivery behind approval.",
    },
    children: [
      {
        id: "memory_search",
        name: "Memory Search",
        task: "Search memory for prior essays and voice: casual tone, short paragraphs.",
        tools: [{ ref: "internal.memory_search" }],
      },
      {
        id: "writer",
        name: "Writer",
        task: "Write the essay using memory voice findings.",
        tools: [{ ref: "internal.llm_only" }],
      },
      {
        id: "approval_handoff",
        name: "Approval Handoff",
        task: "Send draft for operator approval.",
        tools: [{ ref: "internal.email_approval_request" }],
      },
    ],
  },
  schedule: { cron: "0 9 * * 5", timezone: "UTC" },
  deliveryType: "plain",
  builderMeta: {
    designedBy: "ceo_llm",
    preApproved: true,
  },
  rationale: ["Borrowed writing companion structure customized for product essays."],
  suggestedChannels: ["email (Resend broadcast)"],
};

test("designLoopFromIntent validates LLM output and builds agentGraph definition", async () => {
  const db = await import("../../../src/infrastructure/db/index.js");
  const originalQuery = db.pool.query.bind(db.pool);
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("FROM connector_accounts")) return { rows: [], rowCount: 0 } as unknown;
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  try {
    const { designLoopFromIntent } = await import("../../../src/services/loop-builder/ceo-designer.js");
    const result = await designLoopFromIntent({
      auth: {
        tenantId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        authMode: "internal",
        plan: "pro",
      },
      prompt: "Write a weekly product essay in my voice",
      testOverrides: {
        chat: async () => ({
          text: JSON.stringify(SAMPLE_LLM_OUTPUT),
          model: "gpt-4o",
        }),
        recallMemories: async () => ({
          memories: [{ id: "mem-1", text: "User writes in a casual product-builder voice." }],
        }),
        listPreferences: async () => [],
      },
    });

    assert.equal(result.design.title, "Weekly product essay loop");
    assert.equal(result.definition.agentGraph?.children.length, 3);
    assert.equal(result.definition.builderMeta?.designedBy, "ceo_llm");
    assert.equal(result.definition.builderMeta?.preApproved, true);
    assert.deepEqual(result.design.suggestedChannels, ["email"]);
    assert.match(result.definition.agentGraph?.children[0]?.task ?? "", /casual tone/i);
    assert.equal(result.definition.plan, undefined);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("buildLoopDefinition rejects presetId combined with approval_gate plan", async () => {
  const { buildLoopDefinition } = await import("../../../src/services/loop-executor/creator.js");
  assert.throws(() => buildLoopDefinition({
    task: "Newsletter loop",
    cron: "0 9 * * 5",
    timezone: "UTC",
    presetId: "newsletter",
    plan: {
      goal: "Newsletter",
      allowedIntegrations: ["internal"],
      allowedToolRefs: ["internal.llm_only"],
      artifacts: [],
      stages: [
        {
          kind: "agent",
          id: "writer",
          name: "Writer",
          task: "Write",
          toolRef: "internal.llm_only",
        },
        {
          kind: "approval_gate",
          id: "approval",
          label: "Approve",
          artifactId: "draft",
          required: true,
        },
      ],
    },
  }), /Cannot combine presetId with a plan containing approval_gate/);
});

test("designLoopFromIntent keeps bespoke broadcast roster without newsletter preset", async () => {
  const db = await import("../../../src/infrastructure/db/index.js");
  const originalQuery = db.pool.query.bind(db.pool);
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("FROM connector_accounts")) return { rows: [], rowCount: 0 } as unknown;
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;

  try {
    const { designLoopFromIntent } = await import("../../../src/services/loop-builder/ceo-designer.js");
    const result = await designLoopFromIntent({
      auth: {
        tenantId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        authMode: "internal",
        plan: "pro",
      },
      prompt: "Send a weekly investor newsletter to subscribers",
      testOverrides: {
        chat: async () => ({
          text: JSON.stringify({
            ...SAMPLE_LLM_OUTPUT,
            deliveryType: "newsletter",
            presetId: "newsletter",
            agentGraph: {
              ...SAMPLE_LLM_OUTPUT.agentGraph,
              children: [
                {
                  id: "writer",
                  name: "Writer",
                  task: "Write the newsletter and prepare it for approval.",
                  tools: [{ ref: "internal.llm_only" }],
                },
                {
                  id: "approval_handoff",
                  name: "Approval Handoff",
                  task: "Send draft for approval and broadcast after approval.",
                  tools: [
                    { ref: "internal.email_approval_request" },
                    { ref: "internal.email_builder_compose" },
                    { ref: "internal.email_builder_render" },
                  ],
                },
              ],
            },
          }),
          model: "gpt-4o",
        }),
        recallMemories: async () => ({ memories: [] }),
        listPreferences: async () => [],
      },
    });

    assert.equal(result.definition.deliveryType, "newsletter");
    assert.equal(result.definition.presetId, undefined);
    const children = result.definition.agentGraph?.children ?? [];
    assert.equal(children[0]?.name, "Newsletter Writer");
    assert.equal(children[1]?.name, "Approval & Email Build Agent");
    assert.match(children[1]?.task ?? "", /approval email only/i);
    assert.equal(children[2]?.name, "Broadcast Delivery Agent");
    assert.match(children[2]?.task ?? "", /Resend broadcast only/i);
    assert.deepEqual(children[2]?.tools.map((tool) => tool.ref), ["internal.resend_broadcast"]);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("buildLoopDefinitionFromCeoDesign stores builderMeta and agentGraph", async () => {
  const { buildLoopDefinitionFromCeoDesign } = await import("../../../src/services/loop-executor/creator.js");
  const definition = buildLoopDefinitionFromCeoDesign({
    goal: "Weekly essay",
    design: {
      agentGraph: SAMPLE_LLM_OUTPUT.agentGraph,
      schedule: SAMPLE_LLM_OUTPUT.schedule,
      deliveryType: "plain",
      builderMeta: {
        designedBy: "ceo_llm",
        preApproved: true,
        sourceTemplateIds: ["writing_companion"],
        model: "gpt-4o",
      },
    },
  });

  assert.equal(definition.builderMeta?.preApproved, true);
  assert.equal(definition.agentGraph?.children.length, 3);
  assert.equal(definition.presetId, undefined);
});
