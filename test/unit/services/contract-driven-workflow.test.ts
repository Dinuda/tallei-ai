import assert from "node:assert/strict";
import test from "node:test";

import { dataContractSchema, normalizeContractSchema } from "../../../src/services/loop-engine/data-contract.js";
import { preprocessArchitectOutput } from "../../../src/services/loop-engine/contracts.js";
import { buildAgentSystemPrompt } from "../../../src/services/loop-executor/tool-catalog.js";
import { agentCollectsRunStartInput } from "../../../src/services/loop-runtime/memory.js";
import { renderArtifact } from "../../../src/services/loop-runtime/artifact-renderers.js";
import { buildLoopDefinition } from "../../../src/services/loop-executor/creator.js";
import { runtimeDefinitionSchema } from "../../../src/services/loop-runtime/types.js";

test("normalizeContractSchema coerces architect shorthand into canonical JSON Schema", () => {
  const normalized = normalizeContractSchema({
    messageId: "string",
    recipientCount: "number",
    sentAt: "string",
  });
  const parsed = dataContractSchema.safeParse({
    description: "Send result",
    representation: "json",
    mediaType: "application/json",
    visibility: "internal",
    schema: normalized,
  });
  assert.equal(parsed.success, true);
  assert.equal((normalized as { type?: string }).type, "object");
});

test("preprocessArchitectOutput normalizes empty handoff binding placeholders", () => {
  const prepared = preprocessArchitectOutput({
    title: "Newsletter",
    summary: "Send newsletter",
    strategyText: "Research, draft, send",
    inputsRequired: [],
    inputRequirements: [],
    delivery: { provider: "none" },
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    agents: [{
      id: "writer",
      name: "Writer Agent",
      goal: "Draft newsletter",
      task: "Write draft",
      tool: "internal.llm_only",
      toolConfig: null,
      inputContract: { description: "Research handoff", schema: "{}" },
      outputContract: {
        description: "Draft",
        schema: "{}",
        representation: "text",
        mediaType: "text/markdown",
        visibility: "operator",
        renderer: "canvas.email",
      },
      handoffBindings: [{
        source: {
          kind: "agent_output",
          agentId: "research",
          key: "",
          path: "",
        },
        targetPath: "/handoff/research",
        required: true,
        valuePolicy: null,
        provenance: null,
        transformation: null,
      }],
      doneCriteria: ["Draft complete"],
      gate: null,
      artifactRole: "draft_body",
      nodeKind: "agent",
    }],
    rationale: [],
    suggestedChannels: ["primary"],
  });
  const agent = (prepared as { agents: Array<{ handoffBindings: Array<{ source: { key?: string; path: string } }> }> }).agents[0];
  assert.equal(agent.handoffBindings.length, 1);
  assert.equal(agent.handoffBindings[0]?.source.key, undefined);
  assert.equal(agent.handoffBindings[0]?.source.path, "/");
});

test("preprocessArchitectOutput normalizes serialized shorthand output schemas", () => {
  const prepared = preprocessArchitectOutput({
    title: "Newsletter",
    summary: "Send newsletter",
    strategyText: "Research, draft, send",
    inputsRequired: [],
    inputRequirements: [],
    delivery: { provider: "none" },
    schedule: { cron: "0 9 * * 5", timezone: "UTC" },
    agents: [{
      id: "sender",
      name: "Sender Agent",
      goal: "Send the newsletter",
      task: "Send via Gmail",
      tool: "composio.gmail.action.gmail_send_email",
      toolConfig: null,
      inputContract: { description: "Draft handoff", schema: "{\"subject\":\"string\",\"body\":\"string\"}" },
      outputContract: {
        description: "Send result",
        schema: "{\"messageId\":\"string\",\"recipientCount\":\"number\"}",
        representation: "json",
        mediaType: "application/json",
        visibility: "internal",
        renderer: null,
      },
      handoffBindings: [],
      doneCriteria: ["Email sent"],
      gate: null,
      artifactRole: "delivery",
      nodeKind: "action",
    }],
    rationale: [],
    suggestedChannels: ["primary"],
  });
  const agent = (prepared as { agents: Array<{ outputContract: { schema: Record<string, unknown> } }> }).agents[0];
  assert.equal(agent.outputContract.schema.type, "object");
});

test("JSON contracts reject shorthand pseudo schemas", () => {
  const parsed = dataContractSchema.safeParse({
    description: "Machine output",
    representation: "json",
    mediaType: "application/json",
    visibility: "internal",
    schema: { text: "string" },
  });
  assert.equal(parsed.success, false);
});

test("contract parsing does not compile unresolved local refs", () => {
  const parsed = dataContractSchema.safeParse({
    description: "SDK response schema fragment",
    representation: "json",
    mediaType: "application/json",
    visibility: "internal",
    schema: { $ref: "#/$defs/GmailMessageResponse" },
  });
  assert.equal(parsed.success, true);
});

test("agent names and use-case vocabulary do not change prompt behavior", () => {
  const contract = {
    description: "Operator-visible markdown artifact",
    representation: "text",
    mediaType: "text/markdown",
    visibility: "operator",
    schema: {},
  };
  const first = buildAgentSystemPrompt({
    goal: "Create content",
    agentName: "Newsletter Email Writer",
    agentTask: "Write a newsletter email",
    nodeKind: "agent",
    outputContract: contract,
    doneCriteria: ["Complete"],
  });
  const second = buildAgentSystemPrompt({
    goal: "Create content",
    agentName: "Artifact Producer",
    agentTask: "Produce the artifact",
    nodeKind: "agent",
    outputContract: contract,
    doneCriteria: ["Complete"],
  });
  assert.equal(first.replace("Newsletter Email Writer", "Artifact Producer"), second);
});

test("operator input ownership comes only from explicit node declarations", () => {
  assert.equal(agentCollectsRunStartInput({ id: "input_validator", name: "Input Validator" }), false);
  assert.equal(agentCollectsRunStartInput({ id: "anything", nodeKind: "operator_input" }), true);
  assert.equal(agentCollectsRunStartInput({ id: "anything", tools: [{ ref: "internal.operator_input" }] }), true);
});

test("renderer plugins are selected by contract renderer and media type", () => {
  const rendered = renderArtifact("canvas.email", "text/markdown", "Subject: Status\n\nBody");
  assert.equal(rendered.kind, "canvas_email");
  assert.match(rendered.body, /Body/);
  const structured = renderArtifact("canvas.email", "application/json", JSON.stringify({ subject: "Status", body: "Body" }));
  assert.equal(structured.kind, "canvas_email");
  assert.match(structured.body, /Body/);
  assert.throws(() => renderArtifact("canvas.email", "text/plain", "Body"), /does not accept/);
});

test("runtime accepts explicit contract graphs and rejects legacy implicit graphs", () => {
  const definition = buildLoopDefinition({
    task: "Produce an artifact",
    cron: "0 9 * * 1",
    timezone: "UTC",
    engineVersion: "loop_engine_v3",
    operatorInteractionPlan: { version: "v1", interactions: [] },
    builderMeta: {
      designedBy: "loop_architect",
      engineVersion: "loop_engine_v3",
      preApproved: true,
      planningIRVersion: "v2",
      planningIR: {},
    },
    agentGraph: {
      parent: { id: "parent", name: "Coordinator", task: "Coordinate", policy: "Use declared contracts." },
      children: [{
        id: "producer",
        name: "Producer",
        nodeKind: "agent",
        task: "Produce an artifact",
        goal: "Produce an artifact",
        tools: [{ ref: "internal.llm_only" }],
        handoffBindings: [],
        outputContract: {
          description: "Operator-visible markdown",
          schema: {},
          representation: "text",
          mediaType: "text/markdown",
          visibility: "operator",
        },
      }],
    },
  });
  assert.equal(runtimeDefinitionSchema.safeParse(definition).success, true);
  assert.equal(runtimeDefinitionSchema.safeParse({ ...definition, operatorInteractionPlan: undefined }).success, false);
});
