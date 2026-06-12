/**
 * goal-eval.ts — Deterministic guards for per-agent goal evaluation.
 */

import type { LoopRunAgent, LoopDefinition } from "../loop-executor/types.js";
import type { RunLoopAgentResult } from "../loop-executor/agent-runner.js";
import {
  contentInputKeys,
  hasRequiredContentInputs,
  isInputValidationAgent,
  type RunMemory,
} from "../loop-runtime/memory.js";
import {
  detectPlaceholderText,
  extractMemorySources,
  extractWebSearchSources,
  goalEvalResultSchema,
  type GoalEvalResult,
} from "./contracts.js";
import { contractRenderer, contractUsesJson, validateContractData } from "./data-contract.js";

function asksOperatorForInput(text: string): boolean {
  return /\b(please (provide|paste|send|share)|is missing|not provided|don't have|do not have|can't draft|cannot draft|can't generate|cannot generate|lacks?|missing)\b/i.test(text)
    && /\b(sprint|notes|input|details|content|required|sprint_notes)\b/i.test(text);
}

function isCanvasDraftAgent(agent: LoopRunAgent): boolean {
  const renderer = contractRenderer(agent.outputContract);
  return renderer === "canvas.email"
    || renderer === "canvas.preview"
    || agent.gate?.type === "draft_review";
}

function looksLikeReviewableDraft(text: string): boolean {
  return text.length > 120 && !/\b(is missing|please provide|please paste)\b/i.test(text);
}

function readToolConfidence(data: unknown): string | null {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  return typeof root.confidence === "string" ? root.confidence : null;
}

function confirmsRequiredInputPresent(text: string, requiredKeys: string[]) {
  const normalized = text.toLowerCase();
  const hasPositiveSignal = /\b(input|notes?|content)\s+(?:provided|present|available):?\s*(?:yes|true)\b/i.test(text)
    || /\bprovided:?\s*(?:yes|true)\b/i.test(text)
    || /\bmissing fields?:?\s*(?:none|none detected|no missing fields)\b/i.test(text)
    || /\bno missing fields?\b/i.test(text);
  if (!hasPositiveSignal) return false;
  return requiredKeys.some((key) => normalized.includes(key.toLowerCase()));
}

function isShortCircuitTool(toolRef: string): boolean {
  return toolRef === "internal.web_search"
    || toolRef === "internal.memory_search"
    || toolRef.match(/^composio\.[a-z0-9_-]+\.search$/i) !== null;
}

function validateShortCircuitOutput(toolRef: string, result: RunLoopAgentResult): GoalEvalResult | null {
  const text = result.text?.trim() ?? "";
  const data = result.data ?? {};

  if (!text) {
    return goalEvalResultSchema.parse({
      status: "fail",
      reason: "Short-circuit tool returned empty output.",
      blockers: ["empty_output"],
    });
  }

  if (toolRef === "internal.web_search") {
    const sources = extractWebSearchSources(data);
    if (sources.length === 0) {
      return goalEvalResultSchema.parse({
        status: "fail",
        reason: "Web search returned no sources.",
        blockers: ["no_sources"],
      });
    }
    const invalidSource = sources.find((s) => !s.title || !s.url || !s.snippet);
    if (invalidSource) {
      return goalEvalResultSchema.parse({
        status: "fail",
        reason: "Web search source missing required fields (title, url, snippet).",
        blockers: ["invalid_source_format"],
      });
    }
    return goalEvalResultSchema.parse({
      status: "pass",
      reason: `Web search returned ${sources.length} valid sources.`,
    });
  }

  if (toolRef === "internal.memory_search") {
    const sources = extractMemorySources(data);
    if (sources.length === 0) {
      return goalEvalResultSchema.parse({
        status: "pass",
        reason: "Memory search returned no results (valid empty result).",
      });
    }
    const invalidMemory = sources.find((s: { id?: string; text?: string }) => !s.id || !s.text);
    if (invalidMemory) {
      return goalEvalResultSchema.parse({
        status: "fail",
        reason: "Memory search result missing required fields (id, text).",
        blockers: ["invalid_memory_format"],
      });
    }
    return goalEvalResultSchema.parse({
      status: "pass",
      reason: `Memory search returned ${sources.length} valid memories.`,
    });
  }

  if (toolRef.match(/^composio\.[a-z0-9_-]+\.search$/i)) {
    return goalEvalResultSchema.parse({
      status: "pass",
      reason: "Composio search returned results.",
    });
  }

  return null;
}

function deterministicGuards(input: {
  agent: LoopRunAgent;
  result: RunLoopAgentResult;
  definition: LoopDefinition;
  runMemory?: RunMemory;
}): GoalEvalResult | null {
  const text = input.result.text?.trim() ?? "";
  if (input.agent.nodeKind) {
    if (!text) {
      return goalEvalResultSchema.parse({ status: "fail", reason: "Node returned empty output.", blockers: ["empty_output"] });
    }
    if (detectPlaceholderText(text)) {
      return goalEvalResultSchema.parse({ status: "fail", reason: "Node output contains unresolved placeholders.", blockers: ["placeholder_detected"] });
    }
    if (input.agent.gate) {
      return goalEvalResultSchema.parse({
        status: "needs_input",
        reason: input.agent.gate.question,
        blockers: [],
        gateType: input.agent.gate.type,
      });
    }
    return goalEvalResultSchema.parse({ status: "pass", reason: "Declared output contract satisfied." });
  }
  const contentInputsSatisfied = input.runMemory
    ? hasRequiredContentInputs(input.definition, input.runMemory)
    : true;
  const goalText = input.definition.goal ?? "";
  const contentKeys = contentInputKeys(input.definition);
  const canvasDraftAgent = isCanvasDraftAgent(input.agent);

  if (
    isInputValidationAgent(input.agent) &&
    (contentInputsSatisfied || confirmsRequiredInputPresent(text, contentKeys))
  ) {
    return goalEvalResultSchema.parse({
      status: "pass",
      reason: contentInputsSatisfied
        ? "Required run-start content inputs are present in run memory."
        : "Input checker verified the required input is present.",
    });
  }

  if (!text && !input.result.structuredOutput) {
    return goalEvalResultSchema.parse({
      status: "fail",
      reason: "Agent returned empty output.",
      blockers: ["empty_output"],
    });
  }

  if (asksOperatorForInput(text) && !isInputValidationAgent(input.agent)) {
    return goalEvalResultSchema.parse({
      status: "fail",
      reason: "Internal agent requested operator input instead of completing from its available handoff.",
      blockers: ["invalid_operator_input_request"],
    });
  }

  const keysToCheck = canvasDraftAgent
    ? contentKeys
    : isInputValidationAgent(input.agent)
      ? contentKeys
      : [];
  for (const required of keysToCheck) {
    if (contentInputsSatisfied && input.runMemory?.inputs[required]?.trim()) continue;
    const requiredNorm = required.toLowerCase();
    const normalizedText = text.toLowerCase();
    const goalNeedsInput = goalText.toLowerCase().includes(`[paste ${requiredNorm}`)
      || goalText.toLowerCase().includes(`[${requiredNorm}`);
    const mentionsRequired = normalizedText.includes(requiredNorm);
    const outputMentionsMissing = mentionsRequired && /\b(missing|not provided|no\b|absent|placeholder|actual content has not been provided|need real|paste the actual)\b/i.test(text);
    if (goalNeedsInput || outputMentionsMissing) {
      if (/\b(missing|paste|provide|send|can't|cannot|not provided|no\b|absent|placeholder|need real|actual content)\b/i.test(text)) {
        return goalEvalResultSchema.parse({
          status: "needs_input",
          reason: `Required input "${required}" is missing.`,
          blockers: [required],
          gateType: "missing_input",
        });
      }
    }
  }

  if (detectPlaceholderText(text)) {
    if (isInputValidationAgent(input.agent)) {
      return goalEvalResultSchema.parse({
        status: "needs_input",
        reason: "Output contains placeholder or unfilled template text.",
        blockers: ["placeholder_detected"],
        gateType: "missing_input",
      });
    }
    if (!input.agent.gate && !canvasDraftAgent) {
      return goalEvalResultSchema.parse({
        status: "fail",
        reason: "Internal agent returned placeholder text instead of completing its handoff.",
        blockers: ["placeholder_detected"],
      });
    }
    const reviewGateType = input.agent.gate?.type === "draft_review" || input.agent.gate?.type === "pre_send"
      ? input.agent.gate.type
      : "draft_review";
    return goalEvalResultSchema.parse({
      status: "needs_input",
      reason: "Output contains placeholder or unfilled template text.",
      blockers: ["placeholder_detected"],
      gateType: reviewGateType,
    });
  }

  const toolRef = input.agent.tools[0]?.ref ?? "";
  if (toolRef === "internal.memory_search") {
    const sources = extractMemorySources(input.result.data);
    const mentionsMissingId = /memory id:\s*(not provided|missing|unknown)/i.test(text);
    if (sources.length === 0 && readToolConfidence(input.result.data) === "none") {
      return goalEvalResultSchema.parse({
        status: "pass",
        reason: "Memory search found no validated memories for this run intent.",
      });
    }
    if (sources.length === 0 && /no (verified )?memory|no relevant memory/i.test(text)) {
      return goalEvalResultSchema.parse({
        status: "needs_input",
        reason: "No verified memories found for this loop.",
        blockers: ["no_memories"],
        gateType: "memory_confirmation",
      });
    }
    if (mentionsMissingId || (sources.length > 0 && sources.some((s) => !s.id))) {
      return goalEvalResultSchema.parse({
        status: "fail",
        reason: "Memory search output is missing memory IDs.",
        blockers: ["missing_memory_ids"],
      });
    }
    if (input.agent.gate?.type === "memory_confirmation" && sources.length > 0) {
      return goalEvalResultSchema.parse({
        status: "needs_input",
        reason: "Confirm which memories to include before proceeding.",
        blockers: [],
        gateType: "memory_confirmation",
      });
    }
  }

  if (!contentInputsSatisfied && asksOperatorForInput(text) && !canvasDraftAgent && isInputValidationAgent(input.agent)) {
    const requiredKey = contentKeys[0] ?? input.definition.inputsRequired?.[0] ?? "required_input";
    return goalEvalResultSchema.parse({
      status: "needs_input",
      reason: `Required input is missing. Provide ${requiredKey.replace(/_/g, " ")} to continue.`,
      blockers: contentKeys.length > 0 ? contentKeys : [requiredKey],
      gateType: "missing_input",
    });
  }

  if (
    toolRef === "internal.llm_only"
    && !asksOperatorForInput(text)
    && (canvasDraftAgent || looksLikeReviewableDraft(text))
  ) {
    if (looksLikeReviewableDraft(text)) {
      const reviewGateType = input.agent.gate?.type === "pre_send" ? "pre_send" : "draft_review";
      return goalEvalResultSchema.parse({
        status: "needs_input",
        reason: "Review the draft before proceeding.",
        blockers: [],
        gateType: reviewGateType,
      });
    }
  }

  return null;
}

function validateStructuredOutput(agent: LoopRunAgent, result: RunLoopAgentResult): GoalEvalResult | null {
  const structured = result.structuredOutput;
  if (!structured && !contractUsesJson(agent.outputContract)) return null;
  const schema = agent.outputContract?.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const candidate = structured ?? (() => {
    try {
      const parsed = JSON.parse(result.text?.trim() ?? "");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  })();
  if (!candidate) {
    return goalEvalResultSchema.parse({
      status: "fail",
      reason: "Structured output is missing or not valid JSON.",
      blockers: ["invalid_structured_output"],
    });
  }
  const validation = validateContractData(schema as Record<string, unknown>, candidate);
  if (!validation.valid) {
    return goalEvalResultSchema.parse({
      status: "fail",
      reason: validation.reason,
      blockers: ["schema_validation_failed"],
    });
  }
  return null;
}

function checkDoneCriteria(agent: LoopRunAgent, result: RunLoopAgentResult): GoalEvalResult {
  const criteria = agent.doneCriteria ?? [];
  const text = result.text?.trim() ?? "";
  if (criteria.length > 0 && !text && !result.structuredOutput) {
    return goalEvalResultSchema.parse({
      status: "fail",
      reason: "Agent output is empty but done criteria were declared.",
      blockers: ["empty_output"],
    });
  }
  return goalEvalResultSchema.parse({
    status: "pass",
    reason: criteria.length > 0
      ? `Done criteria satisfied (${criteria.length} declared).`
      : "Deterministic checks passed.",
  });
}

export async function evaluateAgentGoal(input: {
  agent: LoopRunAgent;
  result: RunLoopAgentResult;
  definition: LoopDefinition;
  runMemory?: RunMemory;
}): Promise<GoalEvalResult> {
  const deterministic = deterministicGuards(input);
  if (deterministic) return deterministic;

  const toolRef = input.agent.tools[0]?.ref ?? "";
  if (isShortCircuitTool(toolRef)) {
    const shortCircuitResult = validateShortCircuitOutput(toolRef, input.result);
    if (shortCircuitResult) {
      if (
        shortCircuitResult.status === "pass"
        && input.agent.gate?.type === "source_confirmation"
        && (toolRef === "internal.web_search" || /^composio\.[a-z0-9_-]+\.search$/i.test(toolRef))
      ) {
        return goalEvalResultSchema.parse({
          status: "needs_input",
          reason: "Confirm which sources the next agent may use.",
          blockers: [],
          gateType: "source_confirmation",
        });
      }
      return shortCircuitResult;
    }
  }

  const structuredValidation = validateStructuredOutput(input.agent, input.result);
  if (structuredValidation) return structuredValidation;

  return checkDoneCriteria(input.agent, input.result);
}
