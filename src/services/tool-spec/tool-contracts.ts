import type { ConnectorActionRisk } from "../loop-engine/spec-contracts.js";
import type {
  ToolContract,
  ToolEffect,
  ToolExecutionMode,
  ToolRenderRecommendation,
  ToolRenderTarget,
  ToolSkillTag,
} from "./types.js";

type ActionLike = {
  toolkit: string;
  actionSlug: string;
  name?: string;
  description?: string;
  risk?: ConnectorActionRisk | string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

const GENERIC_ACTION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    output: { type: "object" },
  },
};

const REVIEWED_ACTION_OVERRIDES: Record<string, Partial<ToolContract>> = {
  "composio.resend.action.resend_send_email": {
    skillTags: ["send", "notify"],
    effect: "write_external",
    resources: ["email", "message"],
    approval: {
      required: true,
      suggestedGate: "pre_send",
      reason: "Sends email to external recipients.",
    },
    renderRecommendations: [{
      target: "canvas.email",
      reason: "Useful when the workflow produces editable email copy before the send action.",
      strength: "medium",
    }],
    source: "reviewed_override",
  },
};

export function normalizeToolRef(ref: string): string {
  return ref.trim().toLowerCase();
}

export function connectorActionToolRef(action: { toolkit: string; actionSlug: string }): string {
  return `composio.${action.toolkit.trim().toLowerCase()}.action.${action.actionSlug.trim().toLowerCase()}`;
}

export function parseConnectorActionToolRef(ref: string): { toolkit: string; actionSlug: string } | null {
  const match = normalizeToolRef(ref).match(/^composio\.([a-z0-9_-]+)\.action\.(.+)$/);
  return match ? { toolkit: match[1]!, actionSlug: match[2]! } : null;
}

export function parseConnectedSearchToolRef(ref: string): { toolkit: string } | null {
  const match = normalizeToolRef(ref).match(/^composio\.([a-z0-9_-]+)\.search$/);
  return match ? { toolkit: match[1]! } : null;
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function actionText(action: ActionLike): string {
  return [
    action.toolkit,
    action.actionSlug,
    action.name ?? "",
    action.description ?? "",
  ].join(" ").toLowerCase().replace(/_/g, " ");
}

function inferSkillTags(action: ActionLike): ToolSkillTag[] {
  const text = actionText(action);
  const tags: ToolSkillTag[] = [];
  if (/\b(search|list|find|get|read|fetch|retrieve|lookup)\b/.test(text)) tags.push("search", "retrieve");
  if (/\b(draft|compose|generate|write)\b/.test(text)) tags.push("draft");
  if (/\b(summary|summarize|digest|analy[sz]e|report)\b/.test(text)) tags.push("summarize", "analyze");
  if (/\b(transform|convert|format|parse)\b/.test(text)) tags.push("transform");
  if (/\b(send|reply|forward|broadcast|publish|post|message|notify|email)\b/.test(text)) tags.push("send", "notify");
  if (/\b(create|add|insert|import|upsert)\b/.test(text)) tags.push("create");
  if (/\b(update|edit|patch|modify|set|assign|move|close|open)\b/.test(text)) tags.push("update");
  if (/\b(delete|remove|destroy|revoke|disable|archive|trash|purge)\b/.test(text)) tags.push("delete");
  if (/\b(schedule|calendar|event|meeting|appointment)\b/.test(text)) tags.push("schedule");
  if (tags.length === 0) tags.push(action.risk === "read" ? "retrieve" : "update");
  return uniq(tags);
}

function inferResources(action: ActionLike): string[] {
  const text = actionText(action);
  const resources: string[] = [];
  if (/\b(email|mail|inbox|newsletter)\b/.test(text)) resources.push("email");
  if (/\b(message|sms|chat|slack|notification|notify|post)\b/.test(text)) resources.push("message");
  if (/\b(contact|subscriber|recipient|audience|lead|customer)\b/.test(text)) resources.push("contact");
  if (/\b(calendar|event|meeting|appointment)\b/.test(text)) resources.push("calendar_event");
  if (/\b(document|doc|page|notion|file|sheet|spreadsheet)\b/.test(text)) resources.push("document");
  if (/\b(issue|ticket|task|linear|github|pull request|pr)\b/.test(text)) resources.push("issue");
  if (/\b(channel|workspace|team)\b/.test(text)) resources.push("channel");
  if (/\b(webhook|domain|api key|apikey)\b/.test(text)) resources.push("integration_config");
  return uniq(resources.length > 0 ? resources : [action.toolkit.toLowerCase()]);
}

function inferEffect(action: ActionLike): ToolEffect {
  const risk = String(action.risk ?? "").toLowerCase();
  if (risk === "destructive") return "irreversible_external";
  if (risk === "read") return "read_external";
  if (risk === "write" || risk === "send") return "write_external";
  const tags = inferSkillTags(action);
  if (tags.includes("delete")) return "irreversible_external";
  if (tags.some((tag) => ["send", "create", "update", "schedule", "notify"].includes(tag))) return "write_external";
  return "read_external";
}

function inferExecutionMode(effect: ToolEffect): ToolExecutionMode {
  if (effect === "none") return "llm_assisted";
  if (effect === "read_external") return "short_circuit";
  return "approval_executed";
}

function inferRenderRecommendations(input: {
  resources: string[];
  skillTags: ToolSkillTag[];
  effect: ToolEffect;
  outputSchema: Record<string, unknown>;
}): ToolRenderRecommendation[] {
  const schemaText = JSON.stringify(input.outputSchema).toLowerCase();
  const recommendations: ToolRenderRecommendation[] = [];
  if (
    input.resources.includes("email")
    && (input.skillTags.includes("draft") || schemaText.includes("subject") || schemaText.includes("html") || schemaText.includes("body"))
  ) {
    recommendations.push({
      target: "canvas.email",
      reason: "Output appears to be editable email content.",
      strength: "medium",
    });
  }
  if (
    input.resources.some((resource) => ["email", "document", "message"].includes(resource))
    && input.effect !== "irreversible_external"
  ) {
    recommendations.push({
      target: "canvas.preview",
      reason: "Output may benefit from visual review before downstream use.",
      strength: "weak",
    });
  }
  return recommendations;
}

function applyReviewedOverride(base: ToolContract): ToolContract {
  const override = REVIEWED_ACTION_OVERRIDES[base.toolRef];
  if (!override) return base;
  return {
    ...base,
    ...override,
    approval: {
      ...base.approval,
      ...(override.approval ?? {}),
    },
    constraints: {
      ...base.constraints,
      ...(override.constraints ?? {}),
      reviewedOverride: true,
    },
    renderRecommendations: override.renderRecommendations ?? base.renderRecommendations,
  };
}

export function buildComposioActionContract(action: ActionLike): ToolContract {
  const toolRef = connectorActionToolRef(action);
  const inputSchema = action.inputSchema ?? { type: "object" };
  const outputSchema = action.outputSchema ?? GENERIC_ACTION_OUTPUT_SCHEMA;
  const effect = inferEffect(action);
  const skillTags = inferSkillTags(action);
  const resources = inferResources(action);
  const executionMode = inferExecutionMode(effect);
  const base: ToolContract = {
    toolRef,
    provider: "composio",
    name: action.name?.trim() || action.actionSlug,
    description: action.description?.trim() || `Composio action ${action.actionSlug}`,
    skillTags,
    effect,
    resources,
    inputSchema,
    outputSchema,
    executionMode,
    approval: {
      required: effect === "write_external" || effect === "irreversible_external",
      ...(effect === "write_external" || effect === "irreversible_external"
        ? { suggestedGate: "pre_send" as const, reason: "External side-effect requires operator approval." }
        : {}),
    },
    renderRecommendations: inferRenderRecommendations({ resources, skillTags, effect, outputSchema }),
    constraints: {
      toolkit: action.toolkit,
      actionSlug: action.actionSlug,
      risk: action.risk ?? "write",
    },
    source: "composio_sdk",
  };
  return applyReviewedOverride(base);
}

export function buildConnectedSearchContract(toolkit: string): ToolContract {
  const normalizedToolkit = toolkit.trim().toLowerCase();
  return {
    toolRef: `composio.${normalizedToolkit}.search`,
    provider: "composio",
    name: `${normalizedToolkit} search`,
    description: `Search and retrieve connected ${normalizedToolkit} data.`,
    skillTags: ["search", "retrieve", "summarize"],
    effect: "read_external",
    resources: [normalizedToolkit],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    executionMode: "short_circuit",
    approval: { required: false },
    renderRecommendations: [],
    constraints: { toolkit: normalizedToolkit, virtualSearchTool: true },
    source: "static",
  };
}

export function buildPolicyActionContract(action: {
  toolkit: string;
  actionSlug: string;
  risk: ConnectorActionRisk | string;
  description?: string;
}): ToolContract {
  return buildComposioActionContract({
    toolkit: action.toolkit,
    actionSlug: action.actionSlug,
    name: action.actionSlug,
    description: action.description,
    risk: action.risk,
    inputSchema: { type: "object" },
  });
}

export function getStaticToolContract(ref: string): ToolContract | null {
  const normalized = normalizeToolRef(ref);
  if (normalized === "internal.llm_only") {
    return {
      toolRef: "internal.llm_only",
      provider: "internal",
      name: "LLM Synthesis",
      description: "Pure language model reasoning and text generation.",
      skillTags: ["draft", "summarize", "transform", "analyze"],
      effect: "none",
      resources: ["text", "document", "email", "message"],
      inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      executionMode: "llm_assisted",
      approval: { required: false },
      renderRecommendations: [
        { target: "canvas.email", reason: "Useful when the generated output is editable email copy.", strength: "weak" },
        { target: "canvas.preview", reason: "Useful when generated output benefits from visual review.", strength: "weak" },
      ],
      constraints: {},
      source: "static",
    };
  }
  if (normalized === "internal.memory_search") {
    return {
      toolRef: "internal.memory_search",
      provider: "internal",
      name: "Memory Search",
      description: "Search saved memories and return validated memory sources.",
      skillTags: ["search", "retrieve"],
      effect: "none",
      resources: ["memory", "text"],
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      outputSchema: { type: "object", properties: { text: { type: "string" }, memories: { type: "array" } }, required: ["text"] },
      executionMode: "short_circuit",
      approval: { required: false, suggestedGate: "memory_confirmation", reason: "Operator may curate returned memories when the workflow needs review." },
      renderRecommendations: [],
      constraints: {},
      source: "static",
    };
  }
  if (normalized === "internal.web_search") {
    return {
      toolRef: "internal.web_search",
      provider: "internal",
      name: "Web Search",
      description: "Search the live web and return raw source results.",
      skillTags: ["search", "retrieve"],
      effect: "read_external",
      resources: ["web", "source", "document"],
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      outputSchema: { type: "object", properties: { text: { type: "string" }, sources: { type: "array" } }, required: ["text"] },
      executionMode: "short_circuit",
      approval: { required: false, suggestedGate: "source_confirmation", reason: "Operator may curate sources when the workflow needs review." },
      renderRecommendations: [],
      constraints: {},
      source: "static",
    };
  }
  const search = parseConnectedSearchToolRef(normalized);
  if (search) return buildConnectedSearchContract(search.toolkit);
  const action = parseConnectorActionToolRef(normalized);
  if (action) {
    return buildPolicyActionContract({
      toolkit: action.toolkit,
      actionSlug: action.actionSlug,
      risk: "write",
    });
  }
  return null;
}

export function effectRank(effect: ToolEffect): number {
  switch (effect) {
    case "none": return 0;
    case "read_external": return 1;
    case "write_external": return 2;
    case "irreversible_external": return 3;
  }
}

export function isRenderTargetCompatible(contract: ToolContract, target: ToolRenderTarget): boolean {
  if (contract.renderRecommendations.some((recommendation) => recommendation.target === target)) return true;
  const schemaText = JSON.stringify(contract.outputSchema).toLowerCase();
  if (target === "canvas.email") {
    return contract.resources.includes("email")
      || schemaText.includes("subject")
      || schemaText.includes("html")
      || schemaText.includes("body");
  }
  if (target === "canvas.preview") {
    return contract.effect !== "irreversible_external"
      && contract.executionMode !== "approval_executed";
  }
  return false;
}

export function contractSupportsExternalWrite(contract: ToolContract): boolean {
  return contract.effect === "write_external" || contract.effect === "irreversible_external";
}
