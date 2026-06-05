import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "test";
process.env.INTERNAL_API_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://tallei:tallei@127.0.0.1:5432/tallei";
process.env.DATABASE_URL_FALLBACK ??= process.env.DATABASE_URL;
process.env.OPENAI_API_KEY ??= "test-openai-key";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.MEMORY_MASTER_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.REDIS_URL = "";

const [loopExecutor, toolCatalog, db] = await Promise.all([
  import("../../../src/services/loop-executor/index.js"),
  import("../../../src/services/loop-executor/tool-catalog.js"),
  import("../../../src/infrastructure/db/index.js"),
]);
const { aiProviderRegistry } = await import("../../../src/providers/ai/index.js");

const auth = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  authMode: "internal" as const,
  plan: "pro" as const,
};

test("creator builds v2 loop definition without fixed agents", () => {
  const definition = loopExecutor.buildLoopDefinition({
    task: "User is writing a newsletter for xyz product every week. Make that a loop.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    integrations: ["internal", "composio"],
  });

  assert.equal(definition.definitionVersion, "loop_executor_v2");
  assert.equal(definition.ceo.name, "Parent Agent");
  assert.ok(Array.isArray(definition.allowedIntegrations));
  assert.equal("agents" in definition, false);
});

test("newsletter preset roster takes precedence over generated content plan", async () => {
  const definition = loopExecutor.buildLoopDefinition({
    task: "User is writing a newsletter for xyz product every week. Make that a loop.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    presetId: "newsletter",
    plan: {
      goal: "Generate weekly newsletter content",
      allowedIntegrations: ["internal"],
      allowedToolRefs: ["internal.llm_only"],
      artifacts: [{ id: "draft", kind: "newsletter", label: "Newsletter draft" }],
      stages: [
        {
          kind: "agent",
          id: "content_generation",
          name: "Content Generation",
          task: "Generate ideas and draft content for the weekly newsletter.",
          toolRef: "internal.llm_only",
          outputArtifactId: "draft",
        },
        {
          kind: "agent",
          id: "editor",
          name: "Editor",
          task: "Review the drafted newsletter for clarity, coherence, and engagement.",
          toolRef: "internal.llm_only",
          outputArtifactId: "draft",
        },
      ],
    },
  });

  const output = await loopExecutor.buildCeoStrategyOutput({ definition } as never);

  assert.match(output.strategyText, /fixed weekly newsletter pipeline/i);
  assert.deepEqual(
    output.agents.map((agent) => agent.id),
    ["search_agent", "web_search_agent", "research_agent", "writer", "approval_handoff"]
  );
});

test("newsletter preset roster includes real Lenny seed memory, Exa web search, memory search, and topic-selection guidance", async () => {
  const definition = loopExecutor.buildLoopDefinition({
    task: "Lenny writes a weekly product newsletter for product builders.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    presetId: "newsletter",
  });

  const output = await loopExecutor.buildCeoStrategyOutput({ definition } as never);

  assert.match(output.strategyText, /Felix Rieseberg's Claude Cowork workflows \+ Google I\/O 2026 recap/i);
  assert.match(output.strategyText, /Benedict Evans on AI as a 1997 internet moment/i);
  assert.match(output.strategyText, /Codex Goals, Claude Opus 4\.8, and non-technical app building/i);
  assert.match(output.strategyText, /URL: https:\/\/www\.chatprd\.ai\/how-i-ai\/felix-rieseberg-claude-code-cowork-workflows-for-3d-house-design-and-hardware-buddy/i);
  assert.match(output.strategyText, /URL: https:\/\/www\.lennysnewsletter\.com\/p\/a-rational-conversation-on-where/i);
  assert.match(output.strategyText, /Default lead-topic hypothesis to evaluate: Where agentic coding is getting real/i);

  const searchAgent = output.agents.find((agent) => agent.id === "search_agent");
  const webSearchAgent = output.agents.find((agent) => agent.id === "web_search_agent");
  const researchAgent = output.agents.find((agent) => agent.id === "research_agent");
  const writer = output.agents.find((agent) => agent.id === "writer");

  assert.ok(searchAgent);
  assert.ok(webSearchAgent);
  assert.ok(researchAgent);
  assert.ok(writer);

  assert.match(searchAgent?.task ?? "", /three ranked topic candidates grounded in memory/i);
  assert.match(searchAgent?.task ?? "", /summary of Lenny's recent themes and newsletter voice\/style/i);
  assert.match(searchAgent?.task ?? "", /Fetch every relevant memory about Lenny's Newsletter/i);
  assert.deepEqual(searchAgent?.tools.map((tool) => tool.ref), ["internal.memory_search"]);
  assert.equal(searchAgent?.tools[0]?.config?.limit, 20);
  assert.match(String(searchAgent?.tools[0]?.config?.query ?? ""), /Lenny's Newsletter previous issues writing style voice formatting examples/i);
  assert.match(String(searchAgent?.tools[0]?.config?.query ?? ""), /editorial preferences recurring sections tone sign-off/i);

  assert.equal(webSearchAgent?.name, "Web Search Agent");
  assert.match(webSearchAgent?.task ?? "", /Run live web search/i);
  assert.match(webSearchAgent?.task ?? "", /source-grounded evidence/i);
  assert.deepEqual(webSearchAgent?.tools.map((tool) => tool.ref), ["internal.web_search"]);
  assert.deepEqual(webSearchAgent?.tools[0]?.config, {
    searchContextSize: "high",
    country: "US",
    allowedDomains: ["openai.com", "anthropic.com", "blog.google", "github.blog", "linear.app"],
  });

  assert.match(researchAgent?.task ?? "", /Choose one recommended lead topic/i);
  assert.match(researchAgent?.task ?? "", /why the other candidates were not selected/i);
  assert.match(researchAgent?.task ?? "", /selected topic, why now, core arguments, source links to cite, and tone\/structure guidance/i);

  assert.match(writer?.task ?? "", /selected topic and writer briefing from the Research Agent/i);
  assert.match(writer?.task ?? "", /Do not fall back to a generic weekly roundup or broad link dump/i);
});

test("buildLoopDefinition sets newsletter preset for Lenny goal", () => {
  const definition = loopExecutor.buildLoopDefinition({
    task: "Lenny writes a weekly product newsletter for product builders.",
    cron: "0 9 * * 1",
    timezone: "UTC",
  });
  assert.equal(definition.presetId, "newsletter");
  assert.match(definition.goal, /Lenny/i);
  assert.doesNotMatch(definition.goal, /xyz product/i);
});

test("newsletter preset roster passes validation when create-time allowlist was llm_only only", async () => {
  const definition = loopExecutor.buildLoopDefinition({
    task: "Lenny writes a weekly product newsletter for product builders.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    allowedToolRefs: ["internal.llm_only"],
  });

  assert.equal(definition.presetId, "newsletter");
  assert.ok(definition.allowedToolRefs?.includes("internal.memory_search"));
  assert.ok(definition.allowedToolRefs?.includes("internal.email_builder_render"));

  const output = await loopExecutor.buildCeoStrategyOutput({ definition } as never);
  const originalQuery = db.pool.query.bind(db.pool);
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("FROM connector_accounts")) return { rows: [], rowCount: 0 } as unknown;
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;
  try {
    const validation = await toolCatalog.validateAgentRoster({
      agents: output.agents,
      definition: toolCatalog.getEffectiveLoopConstraints(definition),
      auth,
      strictConnectors: false,
    });
    assert.equal(validation.ok, true);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("configured agent graph roster is used without preset re-planning", async () => {
  const definition = loopExecutor.buildLoopDefinition({
    task: "Weekly newsletter for builders",
    cron: "0 9 * * 1",
    timezone: "UTC",
    presetId: "newsletter",
    agentGraph: {
      parent: {
        id: "parent_agent",
        name: "Parent Agent",
        task: "Coordinate the loop",
        policy: "Use configured children only",
      },
      children: [
        {
          id: "search_agent",
          name: "Search Agent",
          task: "Find themes",
          tools: [{ ref: "internal.memory_search" }],
        },
        {
          id: "writer",
          name: "Writer",
          task: "Draft newsletter",
          tools: [{ ref: "internal.llm_only" }],
        },
      ],
    },
  });

  const output = await loopExecutor.buildCeoStrategyOutput({ definition } as never);
  assert.match(output.strategyText, /configured agent roster/i);
  assert.deepEqual(output.agents.map((agent) => agent.id), ["search_agent", "writer"]);
});

test("tool catalog rejects unknown tool refs", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("FROM connector_accounts")) return { rows: [], rowCount: 0 } as unknown;
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;
  try {
    const result = await toolCatalog.validateToolAssignments({
      tools: [{ ref: "unknown.tool" }],
      definition: { allowedIntegrations: ["internal"], allowedToolRefs: undefined },
      auth,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.issues[0]?.code, "unknown_tool");
    }
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("tool catalog allows connector warnings without blocking roster edits", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string) => {
    if (sql.includes("FROM connector_accounts")) return { rows: [], rowCount: 0 } as unknown;
    return { rows: [], rowCount: 0 } as unknown;
  }) as typeof db.pool.query;
  try {
    const result = await toolCatalog.validateToolAssignments({
      tools: [{ ref: "composio.gmail.create_draft" }],
      definition: { allowedIntegrations: ["internal", "composio"], allowedToolRefs: undefined },
      auth,
      strictConnectors: false,
    });
    assert.equal(result.ok, true);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("executor creates a strategy-gated run with proposed roster only", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const originalChat = aiProviderRegistry.chat.bind(aiProviderRegistry);
  const definition = loopExecutor.buildLoopDefinition({
    task: "User prepares a weekly account summary every Monday. Make that a loop.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    integrations: ["internal", "composio"],
  });

  let insertedRunId: string | null = null;
  let insertedTasks = 0;
  let finalStatus: string | null = null;
  let strategyOutput = "";
  let proposedRoster: unknown = null;

  (aiProviderRegistry as unknown as { chat: typeof aiProviderRegistry.chat }).chat = (async () => ({
    text: JSON.stringify({
      strategyText: "CEO strategy: research with memory search, draft with LLM only, prepare Gmail draft.",
      agents: [
        {
          id: "researcher",
          name: "Researcher",
          task: "Gather context",
          tools: [{ ref: "internal.memory_search" }],
        },
        {
          id: "writer",
          name: "Writer",
          task: "Write the draft",
          tools: [{ ref: "internal.llm_only" }],
        },
        {
          id: "publicist",
          name: "Publicist",
          task: "Prepare Gmail draft",
          tools: [{ ref: "composio.gmail.create_draft" }],
        },
      ],
    }),
    model: "gpt-4o-mini",
    finishReason: "stop",
  })) as typeof aiProviderRegistry.chat;

  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT id, title, status, metadata_json") && sql.includes("FROM workflows")) {
      return {
        rows: [{
          id: "33333333-3333-4333-8333-333333333333",
          title: "Newsletter Loop",
          status: "active",
          metadata_json: { loopDefinition: definition },
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("INSERT INTO workflow_runs")) {
      insertedRunId = String(params?.[0]);
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("FROM workflow_runs r") && sql.includes("JOIN workflows w")) {
      return {
        rows: [{
          id: insertedRunId,
          tenant_id: auth.tenantId,
          user_id: auth.userId,
          workflow_id: "33333333-3333-4333-8333-333333333333",
          status: "running",
          draft_output: null,
          metadata_json: {},
          workflow_title: "Newsletter Loop",
          workflow_metadata_json: { loopDefinition: definition },
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("INSERT INTO loop_run_tasks")) {
      insertedTasks += 1;
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("UPDATE workflow_runs") && sql.includes("waiting_for_strategy_approval")) {
      finalStatus = "waiting_for_strategy_approval";
      strategyOutput = String(params?.[3] ?? "");
      const metadata = JSON.parse(String(params?.[4] ?? "{}")) as { loop_executor?: { proposedRoster?: unknown } };
      proposedRoster = metadata.loop_executor?.proposedRoster ?? null;
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("FROM connector_accounts")) {
      return { rows: [], rowCount: 0 } as unknown;
    }
    return { rows: [], rowCount: 1 } as unknown;
  }) as typeof db.pool.query;

  try {
    const result = await loopExecutor.executeLoopWorkflow({
      auth,
      workflowId: "33333333-3333-4333-8333-333333333333",
      runMode: "manual",
      scheduledFor: null,
    });

    assert.equal(result.status, "running");
    assert.equal(result.draftRequired, false);
    assert.equal(result.runId, insertedRunId);
    assert.equal(insertedTasks, 0);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
    (aiProviderRegistry as unknown as { chat: typeof aiProviderRegistry.chat }).chat = originalChat;
  }
});

test("scheduler claims active due loops, recomputes next run, and dispatches through executor", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const originalConnect = db.pool.connect.bind(db.pool);
  const originalChat = aiProviderRegistry.chat.bind(aiProviderRegistry);
  const definition = loopExecutor.buildLoopDefinition({
    task: "User is writing a newsletter for xyz product every week. Make that a loop.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    integrations: ["internal", "composio"],
  });

  let dueQueryCheckedActiveStatus = false;
  let nextRunWritten: string | null = null;
  let insertedRunId: string | null = null;
  (aiProviderRegistry as unknown as { chat: typeof aiProviderRegistry.chat }).chat = (async () => ({
    text: JSON.stringify({
      strategyText: "CEO strategy: ordered plan.",
      agents: [
        { id: "writer", name: "Writer", task: "Write", tools: [{ ref: "internal.llm_only" }] },
      ],
    }),
    model: "gpt-4o-mini",
    finishReason: "stop",
  })) as typeof aiProviderRegistry.chat;
  const fakeClient = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("FROM workflows") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        dueQueryCheckedActiveStatus = sql.includes("status = 'active'");
        return {
          rows: [{
            id: "44444444-4444-4444-8444-444444444444",
            tenant_id: auth.tenantId,
            user_id: auth.userId,
            schedule_rrule: "0 9 * * 1",
            next_run_at: "2026-05-25T09:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE workflows") && params?.[1]) {
        nextRunWritten = String(params[1]);
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      return undefined;
    },
  };

  (db.pool as unknown as { connect: typeof db.pool.connect }).connect = (async () => fakeClient) as typeof db.pool.connect;
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT plan, status FROM subscriptions")) {
      return { rows: [{ plan: "pro", status: "active" }], rowCount: 1 } as unknown;
    }
    if (sql.includes("SELECT id, title, status, metadata_json") && sql.includes("FROM workflows")) {
      return {
        rows: [{
          id: "44444444-4444-4444-8444-444444444444",
          title: "Newsletter Loop",
          status: "active",
          metadata_json: { loopDefinition: definition },
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("INSERT INTO workflow_runs")) {
      insertedRunId = String(params?.[0]);
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("FROM workflow_runs r") && sql.includes("JOIN workflows w")) {
      return {
        rows: [{
          id: insertedRunId,
          tenant_id: auth.tenantId,
          user_id: auth.userId,
          workflow_id: "44444444-4444-4444-8444-444444444444",
          status: "running",
          draft_output: null,
          metadata_json: {},
          workflow_title: "Newsletter Loop",
          workflow_metadata_json: { loopDefinition: definition },
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("FROM connector_accounts")) {
      return { rows: [], rowCount: 0 } as unknown;
    }
    return { rows: [], rowCount: 1 } as unknown;
  }) as typeof db.pool.query;

  try {
    const result = await loopExecutor.dispatchDueLoopWorkflows({ limit: 1, source: "internal" });
    assert.equal(result.claimed, 1);
    assert.equal(result.dispatched, 1);
    assert.equal(result.failed, 0);
    assert.equal(dueQueryCheckedActiveStatus, true);
    assert.equal(nextRunWritten, "2026-06-01T09:00:00.000Z");
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
    (db.pool as unknown as { connect: typeof db.pool.connect }).connect = originalConnect;
    (aiProviderRegistry as unknown as { chat: typeof aiProviderRegistry.chat }).chat = originalChat;
  }
});

test("parseContactListCsv accepts email and optional name columns", async () => {
  const { parseContactListCsv } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const contacts = parseContactListCsv("email,name\na@example.com,Ada\nb@example.com,Bob\n");
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0]?.email, "a@example.com");
  assert.equal(contacts[0]?.name, "Ada");
});

test("newsletter draft update persists builder html for broadcast delivery", async () => {
  const originalQuery = db.pool.query.bind(db.pool);
  const definition = loopExecutor.buildLoopDefinition({
    task: "Lenny writes a weekly product newsletter for product builders.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    presetId: "newsletter",
  });
  let savedDraft = "";
  let savedLoopExecutor: Record<string, unknown> | null = null;
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT id FROM workflow_runs")) {
      return { rows: [{ id: "55555555-5555-4555-8555-555555555555" }], rowCount: 1 } as unknown;
    }
    if (sql.includes("FROM workflow_runs r") && sql.includes("JOIN workflows w")) {
      return {
        rows: [{
          id: "55555555-5555-4555-8555-555555555555",
          tenant_id: auth.tenantId,
          user_id: auth.userId,
          workflow_id: "66666666-6666-4666-8666-666666666666",
          status: "waiting_for_contact_list",
          draft_output: "Old draft",
          metadata_json: { loop_executor: {} },
          workflow_title: "Newsletter Loop",
          workflow_metadata_json: { loopDefinition: definition },
        }],
        rowCount: 1,
      } as unknown;
    }
    if (sql.includes("UPDATE workflow_runs") && sql.includes("draft_output = $4")) {
      savedDraft = String(params?.[3] ?? "");
      const metadata = JSON.parse(String(params?.[4] ?? "{}")) as { loop_executor?: Record<string, unknown> };
      savedLoopExecutor = metadata.loop_executor ?? null;
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("INSERT INTO loop_run_events")) {
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 1 } as unknown;
  }) as typeof db.pool.query;

  try {
    await loopExecutor.updateLoopRunNewsletterDraft(auth, {
      runId: "55555555-5555-4555-8555-555555555555",
      body: "Subject: Hello\n\nHey Product Builders,\n\nA useful update.",
      emailHtml: "<html><body><h1>Edited email from builder</h1></body></html>",
      emailDesign: { body: { rows: [] } },
    });
    assert.match(savedDraft, /Hey Product Builders/);
    assert.equal(savedLoopExecutor?.deliveryEmailHtml, "<html><body><h1>Edited email from builder</h1></body></html>");
    assert.equal(savedLoopExecutor?.deliveryEmailSource, "builder");
    assert.deepEqual((savedLoopExecutor?.emailTemplate as { html?: string } | undefined)?.html, "<html><body><h1>Edited email from builder</h1></body></html>");
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("newsletter approval path can persist backend Unlayer builder output", async () => {
  const { buildUnlayerNewsletterEmail } = await import("../../../src/services/loop-executor/presets/newsletter-unlayer.js");
  const { applyEmailApprovalResult } = await import("../../../src/services/loop-executor/approval.js");
  const originalQuery = db.pool.query.bind(db.pool);
  const definition = loopExecutor.buildLoopDefinition({
    task: "Weekly Tallei newsletter to subscribers.",
    cron: "0 9 * * 1",
    timezone: "UTC",
    presetId: "newsletter",
  });
  const built = buildUnlayerNewsletterEmail({
    subject: "Tallei update",
    markdown: [
      "Subject: Tallei update",
      "Preview: Product progress and industry context.",
      "",
      "Hello,",
      "",
      "A verified update for subscribers.",
    ].join("\n"),
  });

  let savedLoopExecutor: Record<string, unknown> | null = null;
  (db.pool as unknown as { query: typeof db.pool.query }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes("UPDATE workflow_runs SET status = 'waiting_for_email_approval'")) {
      const metadata = JSON.parse(String(params?.[4] ?? "{}")) as { loop_executor?: Record<string, unknown> };
      savedLoopExecutor = metadata.loop_executor ?? null;
      return { rows: [], rowCount: 1 } as unknown;
    }
    if (sql.includes("INSERT INTO loop_run_events")) {
      return { rows: [], rowCount: 1 } as unknown;
    }
    return { rows: [], rowCount: 1 } as unknown;
  }) as typeof db.pool.query;

  try {
    await applyEmailApprovalResult({
      context: {
        runId: "77777777-7777-4777-8777-777777777777",
        tenantId: auth.tenantId,
        userId: auth.userId,
        workflowId: "88888888-8888-4888-8888-888888888888",
        workflowTitle: "Newsletter Loop",
        runStatus: "running",
        draftOutput: null,
        metadataJson: { loop_executor: {} },
        definition,
      },
      taskId: "99999999-9999-4999-8999-999999999999",
      approvalRequest: {
        to: "operator@example.com",
        approvalUrl: "https://example.com/approve",
        token: "approval-token",
        sentAt: "2026-06-05T00:00:00.000Z",
      },
      artifactBody: "Subject: Tallei update\n\nHello,\n\nA verified update for subscribers.",
      emailTemplate: {
        html: built.html,
        text: built.text,
        design: built.design,
        subject: built.subject,
        updatedAt: "2026-06-05T00:00:00.000Z",
        source: "builder",
      },
    });

    assert.equal(savedLoopExecutor?.deliveryEmailSource, "builder");
    assert.match(String(savedLoopExecutor?.deliveryEmailHtml ?? ""), /A verified update for subscribers/);
    assert.ok(savedLoopExecutor?.deliveryEmailDesign);
    assert.equal((savedLoopExecutor?.emailTemplate as { source?: string } | undefined)?.source, "builder");
    assert.match(String((savedLoopExecutor?.emailTemplate as { html?: string } | undefined)?.html ?? ""), /Tallei update/);
  } finally {
    (db.pool as unknown as { query: typeof db.pool.query }).query = originalQuery;
  }
});

test("newsletter formatter strips internal approval instructions", async () => {
  const { formatNewsletterForEmail, sanitizeSubscriberNewsletterBody } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const raw = [
    "### Newsletter Draft",
    "",
    "**Subject:** This Week's Must-Reads**",
    "",
    "Draft Newsletter in Lenny's Voice",
    "",
    "This week's insights aim to help builders.",
    "",
    "**Happy building!**",
    "",
    "Lenny",
    "",
    "---",
    "",
    "Please review this draft and let me know if you would like any changes or additional themes before we proceed to the Publicist for email approval.",
    "",
    "### Operator Approval Email",
    "",
    "**Subject:** Approval Request for Weekly Newsletter Draft",
    "",
    "Hi [Operator's Name],",
    "",
    "Please review the draft and let me know if you approve it for distribution.",
    "",
    "### Next Steps",
    "",
    "1. **Operator Approval**: Await feedback.",
  ].join("\n");

  const sanitized = sanitizeSubscriberNewsletterBody(raw);
  assert.match(sanitized, /This week's insights/);
  assert.doesNotMatch(sanitized, /Operator Approval Email/);
  assert.doesNotMatch(sanitized, /Next Steps/);
  assert.doesNotMatch(sanitized, /Operator's Name/);
  assert.doesNotMatch(sanitized, /Draft Newsletter in Lenny's Voice/i);
  assert.doesNotMatch(sanitized, /Please review this draft and let me know/i);
  assert.doesNotMatch(sanitized, /Publicist for email approval/i);

  const formatted = formatNewsletterForEmail(raw);
  assert.equal(formatted.subject, "This Week's Must-Reads");
  assert.match(formatted.text, /Happy building/);
  assert.doesNotMatch(formatted.text, /Approval Request/);
  assert.doesNotMatch(formatted.text, /Draft Newsletter in Lenny's Voice/i);
  assert.doesNotMatch(formatted.text, /Please review this draft and let me know/i);
  assert.doesNotMatch(formatted.html, /Draft Newsletter in Lenny's Voice/i);
  assert.doesNotMatch(formatted.html, /Please review this draft and let me know/i);
  assert.match(formatted.html, /<strong>Happy building!<\/strong>/);
});

test("newsletter formatter strips leaked draft scaffolding from subscriber copy", async () => {
  const { formatNewsletterForBroadcast, formatNewsletterForEmail, sanitizeSubscriberNewsletterBody } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const raw = [
    "**Subject:** Weekly Insights for Product Builders: Navigating the Evolving Landscape of AI and Algorithms",
    "",
    "The draft for the weekly product newsletter in Lenny's voice is ready. Here it is:",
    "",
    "Hello Product Builders,",
    "",
    "As we dive into another week, it's crucial to stay ahead of the curve in the rapidly evolving world of technology and product development.",
    "",
    "1. The Rise of Always-On AI Agents",
    "",
    "Google has recently introduced its \"Gemini Spark,\" an AI agent designed to operate continuously. Read more here.",
    "",
    "2. AI Integration in Everyday Tools",
    "",
    "The integration of AI agents into common applications is becoming the norm. Explore the details.",
    "",
    "Best,",
    "Lenny",
    "",
    "Would you like to make any adjustments or add specific sections before we proceed to the next step?",
  ].join("\n");

  const sanitized = sanitizeSubscriberNewsletterBody(raw);
  assert.match(sanitized, /Hello Product Builders/);
  assert.doesNotMatch(sanitized, /draft for the weekly product newsletter/i);
  assert.doesNotMatch(sanitized, /Lenny's voice/i);
  assert.doesNotMatch(sanitized, /Best,\nLenny/);
  assert.doesNotMatch(sanitized, /Would you like/i);
  assert.doesNotMatch(sanitized, /next step/i);
  assert.doesNotMatch(sanitized, /Read more here/i);
  assert.doesNotMatch(sanitized, /Explore the details/i);

  const formatted = formatNewsletterForEmail(raw);
  const broadcast = await formatNewsletterForBroadcast(formatted);
  assert.equal(formatted.subject, "Weekly Insights for Product Builders: Navigating the Evolving Landscape of AI and Algorithms");
  assert.doesNotMatch(formatted.text, /draft for the weekly product newsletter/i);
  assert.doesNotMatch(formatted.html, /Weekly Newsletter/);
  assert.doesNotMatch(broadcast.html, /Tallei Newsletter/);
  assert.doesNotMatch(broadcast.text, /Would you like/i);
});

test("newsletter formatter strips leaked options, alternates, social snippets, and notes", async () => {
  const { formatNewsletterForEmail, sanitizeSubscriberNewsletterBody } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const leaked = [
    "Subject line options",
    "- A) Tallei updates + industry signals: your monthly snapshot",
    "- B) What’s new at Tallei: product updates and fintech trends",
    "",
    "Preview text",
    "- A quick look at Tallei’s latest product updates.",
    "",
    "Concise business tone",
    "",
    "Hello,",
    "",
    "Here’s your concise update.",
    "",
    "Tallei updates",
    "- Verified update only.",
    "",
    "1-paragraph text-only version",
    "This alternate version should not be sent.",
    "",
    "Suggested social snippets",
    "LinkedIn copy should not be sent.",
    "",
    "Notes",
    "Swap in exact internal links.",
  ].join("\n");

  const sanitized = sanitizeSubscriberNewsletterBody(leaked);
  assert.match(sanitized, /^Subject: Tallei updates \+ industry signals: your monthly snapshot/m);
  assert.match(sanitized, /Hello,/);
  assert.doesNotMatch(sanitized, /Subject line options/i);
  assert.doesNotMatch(sanitized, /Preview text/i);
  assert.doesNotMatch(sanitized, /1-paragraph/i);
  assert.doesNotMatch(sanitized, /LinkedIn copy/i);
  assert.doesNotMatch(sanitized, /Swap in exact internal links/i);

  const formatted = formatNewsletterForEmail(leaked);
  assert.equal(formatted.subject, "Tallei updates + industry signals: your monthly snapshot");
  assert.doesNotMatch(formatted.text, /Subject line options|Suggested social snippets|Notes/i);
});

test("newsletter formatter strips publicist handoff and third-party draft labels", async () => {
  const { formatNewsletterForEmail, sanitizeSubscriberNewsletterBody } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const raw = [
    "### Draft Newsletter for Lenny's Weekly Product Newsletter",
    "",
    "**Subject:** Embracing the Future: How AI Agents are Transforming Product Management",
    "",
    "Hey Builders,",
    "",
    "This week, we're looking at how AI agents are changing product workflows.",
    "",
    "Best,",
    "Lenny",
    "",
    "### Next Steps:",
    "",
    "- **Publicist:** Please review this draft and prepare it for distribution. Once approved, we can upload the contact list and send it out via Resend.",
  ].join("\n");

  const sanitized = sanitizeSubscriberNewsletterBody(raw);
  assert.match(sanitized, /Hey Builders/);
  assert.doesNotMatch(sanitized, /Draft Newsletter for Lenny/i);
  assert.doesNotMatch(sanitized, /Next Steps/i);
  assert.doesNotMatch(sanitized, /Publicist/i);
  assert.doesNotMatch(sanitized, /Best,\nLenny/i);
  assert.doesNotMatch(sanitized, /upload the contact list/i);

  const formatted = formatNewsletterForEmail(raw);
  assert.equal(formatted.subject, "Embracing the Future: How AI Agents are Transforming Product Management");
  assert.doesNotMatch(formatted.text, /Next Steps/i);
  assert.doesNotMatch(formatted.html, /Publicist/i);
});

test("broadcast formatter includes Resend contact properties and unsubscribe URL", async () => {
  const { formatNewsletterForEmail, formatNewsletterForBroadcast } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const formatted = formatNewsletterForEmail("**Subject:** Hello\n\nBody copy.");
  const broadcast = await formatNewsletterForBroadcast(formatted);
  assert.match(broadcast.html, /\{\{\{contact\.first_name\|there\}\}\}/);
  assert.match(broadcast.html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
  assert.match(broadcast.html, /subscribed to updates[\s\S]*from Tallei/i);
  assert.match(broadcast.text, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
});

test("broadcast formatter uses React Email by default for newsletter delivery", async () => {
  const { formatNewsletterForEmail, formatNewsletterForBroadcast } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const formatted = formatNewsletterForEmail("**Subject:** Hello\n\nBody copy.");
  const legacy = await formatNewsletterForBroadcast(formatted, { templateId: "editorial", useReactEmail: false });
  const templated = await formatNewsletterForBroadcast(formatted, { templateId: "editorial" });

  assert.doesNotMatch(legacy.html, /vercel-logo\.png/);
  assert.match(templated.html, /vercel-logo\.png/);
  assert.match(templated.html, /\{\{\{contact\.first_name\|there\}\}\}/);
});

test("delivery formatter falls back to newsletter formatting from markdown body", async () => {
  const { looksLikeNewsletterContent, resolveDeliveryFormatter } = await import("../../../src/services/loop-executor/delivery-format.js");
  const { newsletterDeliveryFormatter } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const body = "**Streamlining Your Schedule**\n\n### 1. Introduction\n\nHey Product Builders,";
  assert.equal(looksLikeNewsletterContent(body), true);
  const definition = {
    definitionVersion: "loop_executor_v2" as const,
    goal: "Weekly product update",
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    schedulerTarget: "internal" as const,
    allowedIntegrations: ["internal"],
    ceo: { name: "CEO", task: "Own the loop", policy: "Coordinate" },
    draftPolicy: { requireDraftBeforeExternalAction: true, approvalRequiredFor: ["send"] },
  };
  assert.equal(resolveDeliveryFormatter(definition, body), newsletterDeliveryFormatter);
  const formatted = newsletterDeliveryFormatter.formatForDelivery(body);
  assert.equal(formatted.subject, "Streamlining Your Schedule");
});

test("newsletter delivery formatter resolves for resend broadcast loops without presetId", async () => {
  const { isNewsletterLoopDefinition, resolveDeliveryFormatter } = await import("../../../src/services/loop-executor/delivery-format.js");
  const { newsletterDeliveryFormatter } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const definition = {
    definitionVersion: "loop_executor_v2" as const,
    goal: "Weekly newsletter",
    schedule: { cron: "0 9 * * 1", timezone: "UTC" },
    schedulerTarget: "internal" as const,
    allowedIntegrations: ["internal", "react_email"],
    allowedToolRefs: ["internal.resend_broadcast"],
    ceo: { name: "CEO", task: "Own the loop", policy: "Coordinate" },
    draftPolicy: { requireDraftBeforeExternalAction: true, approvalRequiredFor: ["send"] },
  };
  assert.equal(isNewsletterLoopDefinition(definition), true);
  assert.equal(resolveDeliveryFormatter(definition), newsletterDeliveryFormatter);
});

test("stripSubjectDuplicateFromMarkdown removes duplicate headline block", async () => {
  const { stripSubjectDuplicateFromMarkdown } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const markdown = [
    "**Lenny's Weekly Product Newsletter**",
    "",
    "**1. User Experience Trends**",
    "A recent analysis underscores clearer product UX.",
  ].join("\n");
  const stripped = stripSubjectDuplicateFromMarkdown(markdown, "Lenny's Weekly Product Newsletter");
  assert.doesNotMatch(stripped, /Lenny's Weekly Product Newsletter/);
  assert.match(stripped, /User Experience Trends/);
});

test("newsletter formatter uses bold headline as subject and removes it from body", async () => {
  const { formatNewsletterForEmail } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const raw = [
    "**Lenny's Weekly Product Newsletter**",
    "",
    "**1. Introduction**",
    "",
    "Hey Product Builders,",
  ].join("\n");
  const formatted = formatNewsletterForEmail(raw);
  assert.equal(formatted.subject, "Lenny's Weekly Product Newsletter");
  assert.doesNotMatch(formatted.text, /Lenny's Weekly Product Newsletter/);
  assert.match(formatted.text, /Hey Product Builders/);
});

test("newsletter formatter treats repeated subject lines as metadata only", async () => {
  const { formatNewsletterForEmail } = await import("../../../src/services/loop-executor/presets/newsletter.js");
  const raw = [
    "**Subject:** Lenny's Weekly Product Newsletter",
    "",
    "# Lenny's Weekly Product Newsletter",
    "",
    "Here's the final newsletter draft:",
    "",
    "Hey Product Builders,",
    "",
    "This week is about sharper product strategy.",
    "",
    "**Subject:** Approval Request for Weekly Newsletter Draft",
    "",
    "Publicist: Please review this draft and upload the contact list once approved.",
  ].join("\n");
  const formatted = formatNewsletterForEmail(raw);
  assert.equal(formatted.subject, "Lenny's Weekly Product Newsletter");
  assert.doesNotMatch(formatted.text, /Subject:/i);
  assert.doesNotMatch(formatted.text, /Lenny's Weekly Product Newsletter/);
  assert.doesNotMatch(formatted.text, /final newsletter draft/i);
  assert.doesNotMatch(formatted.text, /Publicist/i);
  assert.doesNotMatch(formatted.html, /Subject:/i);
  assert.doesNotMatch(formatted.html, /Lenny&#x27;s Weekly Product Newsletter|Lenny's Weekly Product Newsletter/);
  assert.match(formatted.text, /Hey Product Builders/);
  assert.match(formatted.text, /sharper product strategy/);
});

test("React Email approval template renders markdown before sending", async () => {
  const { renderNewsletterApprovalEmail } = await import("../../../src/services/loop-executor/presets/newsletter-react-email.js");
  const rendered = await renderNewsletterApprovalEmail({
    subject: "Newsletter Loop",
    markdown: "**Lenny's Weekly Product Newsletter**\n\n**1. User Experience Trends**\nA recent analysis underscores the need for clearer product UX.",
    approvalUrl: "https://example.com/approve",
    runUrl: "https://example.com/run",
  });

  assert.doesNotMatch(rendered.html, /\*\*/);
  assert.doesNotMatch(rendered.text, /\*\*/);
  assert.match(rendered.html, /Approve draft/);
  assert.match(rendered.html, /<strong[\s\S]*>1\. User Experience Trends<\/strong/);
});

test("tool catalog includes email approval request tool", () => {
  const tools = loopExecutor.listLoopTools();
  assert.ok(tools.some((tool) => tool.ref === "internal.email_approval_request"));
});
