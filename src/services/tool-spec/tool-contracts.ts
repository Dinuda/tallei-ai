import type { ConnectorActionRisk } from "../loop-engine/spec-contracts.js";
import type {
  ToolContract,
  ToolEffect,
  ToolExecutionMode,
  ToolRenderTarget,
} from "./types.js";
import { buildConnectorActionReadinessContract } from "./action-readiness.js";
import { enrichContractPlanningGuidance } from "./contract-planning-guidance.js";

type ActionLike = {
  toolkit: string;
  actionSlug: string;
  name?: string;
  description?: string;
  risk?: ConnectorActionRisk | string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  toolkitVersion?: string;
};

export function normalizeToolRef(ref: string): string {
  return ref.trim().toLowerCase();
}

export function normalizeConnectorActionSlug(slug: string): string {
  return slug.trim().replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").toUpperCase();
}

export function connectorActionToolRef(action: { toolkit: string; actionSlug: string }): string {
  return `composio.${action.toolkit.trim().toLowerCase()}.action.${normalizeConnectorActionSlug(action.actionSlug)}`;
}

/** Canonical persisted tool ref (uppercase Composio action slugs). */
export function canonicalToolRef(ref: string): string {
  const trimmed = ref.trim();
  const parsed = parseConnectorActionToolRef(trimmed);
  if (parsed) {
    return connectorActionToolRef({
      toolkit: parsed.toolkit,
      actionSlug: normalizeConnectorActionSlug(parsed.actionSlug),
    });
  }
  const searchMatch = parseConnectedSearchToolRef(trimmed);
  if (searchMatch) return `composio.${searchMatch.toolkit}.search`;
  if (trimmed.toLowerCase() === "internal.llm_only") return "internal.llm_only";
  return trimmed;
}

export function hasExactComposioActionSchemas(action: Pick<ActionLike, "inputSchema" | "outputSchema">): boolean {
  return Boolean(
    action.inputSchema
    && Object.keys(action.inputSchema).length > 0
    && action.outputSchema
    && Object.keys(action.outputSchema).length > 0,
  );
}

export function parseConnectorActionToolRef(ref: string): { toolkit: string; actionSlug: string } | null {
  const match = normalizeToolRef(ref).match(/^composio\.([a-z0-9_-]+)\.action\.(.+)$/);
  return match ? { toolkit: match[1]!, actionSlug: match[2]! } : null;
}

export function parseConnectedSearchToolRef(ref: string): { toolkit: string } | null {
  const match = normalizeToolRef(ref).match(/^composio\.([a-z0-9_-]+)\.search$/);
  return match ? { toolkit: match[1]! } : null;
}

function effectFromDeclaredRisk(action: ActionLike): ToolEffect {
  const risk = String(action.risk ?? "").toLowerCase();
  if (risk === "destructive") return "irreversible_external";
  if (risk === "read") return "read_external";
  return "write_external";
}

function executionModeForEffect(effect: ToolEffect): ToolExecutionMode {
  if (effect === "none") return "llm_assisted";
  if (effect === "read_external") return "short_circuit";
  return "approval_executed";
}

export function buildComposioActionContract(action: ActionLike): ToolContract {
  if (!hasExactComposioActionSchemas(action)) {
    throw new Error(`Cannot build Composio action contract without exact input and output schemas: ${connectorActionToolRef(action)}`);
  }
  const toolRef = connectorActionToolRef(action);
  const inputSchema = action.inputSchema!;
  const outputSchema = action.outputSchema!;
  const effect = effectFromDeclaredRisk(action);
  const executionMode = executionModeForEffect(effect);
  return enrichContractPlanningGuidance({
    toolRef,
    provider: "composio",
    name: action.name?.trim() || action.actionSlug,
    description: action.description?.trim() || `Composio action ${action.actionSlug}`,
    skillTags: [],
    effect,
    resources: [action.toolkit.toLowerCase()],
    inputSchema,
    outputSchema,
    executionMode,
    approval: {
      required: effect === "write_external" || effect === "irreversible_external",
      ...(effect === "write_external" || effect === "irreversible_external"
        ? { suggestedGate: "pre_send" as const, reason: "External side-effect requires operator approval." }
        : {}),
    },
    renderRecommendations: [],
    constraints: {
      toolkit: action.toolkit,
      actionSlug: action.actionSlug,
      risk: action.risk ?? "write",
      ...(action.toolkitVersion ? { toolkitVersion: action.toolkitVersion } : {}),
    },
    source: "composio_sdk",
    readiness: buildConnectorActionReadinessContract({ toolRef, inputSchema }),
  });
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

export function getStaticToolContract(ref: string): ToolContract | null {
  const normalized = normalizeToolRef(ref);
  if (normalized === "internal.json_transform") {
    return {
      toolRef: normalized,
      provider: "internal",
      name: "JSON Transform",
      description: "Transform typed handoff sources into JSON matching an exact output schema.",
      skillTags: ["transform"],
      effect: "none",
      resources: ["document"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      executionMode: "llm_assisted",
      approval: { required: false },
      renderRecommendations: [],
      constraints: { structuredJson: true },
      source: "static",
    };
  }
  if (normalized === "internal.operator_input") {
    return {
      toolRef: normalized,
      provider: "internal",
      name: "Operator Input",
      description: "Collect structured operator input without language-model synthesis.",
      skillTags: ["retrieve"],
      effect: "none",
      resources: ["document"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      executionMode: "short_circuit",
      approval: { required: false, suggestedGate: "missing_input" },
      renderRecommendations: [],
      constraints: { operatorInput: true },
      source: "static",
    };
  }
  if (normalized === "internal.llm_only") {
    return {
      toolRef: "internal.llm_only",
      provider: "internal",
      name: "LLM Synthesis",
      description: "Pure language model reasoning and text generation.",
      skillTags: ["draft", "summarize", "transform", "analyze"],
      effect: "none",
      resources: ["text", "document", "email", "message"],
      inputSchema: { type: "object", properties: {}, required: [] },
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
      inputSchema: { type: "object", properties: {}, required: [] },
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
      inputSchema: { type: "object", properties: {}, required: [] },
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
