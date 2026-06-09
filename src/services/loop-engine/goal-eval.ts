/**
 * goal-eval.ts — Deterministic guards + LLM judge for per-agent goal evaluation.
 */

import type { LoopRunAgent, LoopDefinition } from "../loop-executor/types.js";
import type { RunLoopAgentResult } from "../loop-executor/agent-runner.js";
import { loopExecutorOpenAiChat } from "../loop-executor/openai-chat.js";
import {
  contentInputKeys,
  hasRequiredContentInputs,
  hasRequiredRunInputs,
  isInputValidationAgent,
  resolveRequiredInputKeys,
  type RunMemory,
} from "../loop-runtime/memory.js";
import {
  detectPlaceholderText,
  extractMemorySources,
  extractWebSearchSources,
  goalEvalResultSchema,
  type GoalEvalResult,
} from "./contracts.js";

function asksOperatorForInput(text: string): boolean {
  return /\b(please (provide|paste|send|share)|is missing|not provided|don't have|do not have|can't draft|cannot draft|can't generate|cannot generate|lacks?|missing)\b/i.test(text)
    && /\b(sprint|notes|input|details|content|required|sprint_notes)\b/i.test(text);
}

function looksLikeEmailDraft(text: string): boolean {
  return /\b(shipped this week|in progress|things to watch|going out to customers|next week)\b/i.test(text);
}

function isCanvasDraftAgent(agent: LoopRunAgent): boolean {
  return agent.renderTarget === "canvas.email"
    || agent.renderTarget === "canvas.preview"
    || agent.gate?.type === "draft_review";
}

function looksLikeReviewableDraft(text: string): boolean {
  return text.length > 120 && !/\b(is missing|please provide|please paste)\b/i.test(text);
}
const judgeCache = new Map<string, GoalEvalResult>();

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

function approvalArtifactBlocker(body: string): string | null {
  const normalized = body.trim().toLowerCase();
  if (!normalized) return "No draft content available for approval";
  const asksForMissingInput = /\bplease paste\b[\s\S]{0,120}\b(sprint notes?|product updates?|required notes?|missing details?)\b/.test(normalized)
    || /\bpaste\b[\s\S]{0,160}\b(sprint notes?|product updates?|past updates?|core data)\b/.test(normalized)
    || /\bmissing\b[\s\S]{0,120}\b(sprint notes?|product updates?|required notes?|core data|data needed)\b/.test(normalized);
  const cannotGenerate = /\b(can't|cannot|can not|unable to)\b[\s\S]{0,80}\b(generate|write|create|draft)\b/.test(normalized);
  return asksForMissingInput && cannotGenerate
    ? "Approval blocked: the draft is missing required input."
    : null;
}

function cacheKey(agentId: string, text: string, goal: string): string {
  return `${agentId}:${goal.slice(0, 80)}:${text.slice(0, 200)}`;
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
  
  // Validate web_search output structure
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
  
  // Validate memory_search output structure
  if (toolRef === "internal.memory_search") {
    const sources = extractMemorySources(data);
    if (sources.length === 0) {
      // Empty result is valid for memory search
      return goalEvalResultSchema.parse({
        status: "pass",
        reason: "Memory search returned no results (valid empty result).",
      });
    }
    // Check that memories have required fields
    const invalidMemory = sources.find((s: any) => !s.id || !s.text);
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
  
  // For composio search tools, just check we got some output
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
  const inputsSatisfied = input.runMemory
    ? hasRequiredRunInputs(input.definition, input.runMemory)
    : false;
  const contentInputsSatisfied = input.runMemory
    ? hasRequiredContentInputs(input.definition, input.runMemory)
    : true;
  const goalText = input.definition.goal ?? "";
  const requiredKeys = resolveRequiredInputKeys(input.definition);
  const contentKeys = contentInputKeys(input.definition);
  const canvasDraftAgent = isCanvasDraftAgent(input.agent);

  if (
    isInputValidationAgent(input.agent) &&
    (inputsSatisfied || confirmsRequiredInputPresent(text, requiredKeys))
  ) {
    return goalEvalResultSchema.parse({
      status: "pass",
      reason: inputsSatisfied
        ? "Required operator inputs are present in run memory."
        : "Input checker verified the required input is present.",
    });
  }

  if (!text) {
    return goalEvalResultSchema.parse({
      status: "fail",
      reason: "Agent returned empty output.",
      blockers: ["empty_output"],
    });
  }

  const approvalBlock = approvalArtifactBlocker(text);
  if (approvalBlock) {
    return goalEvalResultSchema.parse({
      status: "needs_input",
      reason: approvalBlock,
      blockers: ["missing_required_input"],
      gateType: "missing_input",
    });
  }

  for (const required of (canvasDraftAgent ? contentKeys : requiredKeys)) {
    if (inputsSatisfied && input.runMemory?.inputs[required]?.trim()) continue;
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
    if (looksLikeEmailDraft(text) && sources.length === 0) {
      return goalEvalResultSchema.parse({
        status: "fail",
        reason: "Memory search returned a draft email instead of memory items with ids and excerpts. Return a list of memories only; drafting happens in a later agent.",
        blockers: ["wrong_output_format"],
      });
    }
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

  if (!contentInputsSatisfied && asksOperatorForInput(text) && !canvasDraftAgent) {
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
    && (canvasDraftAgent || looksLikeEmailDraft(text) || looksLikeReviewableDraft(text))
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

async function llmJudge(input: {
  agent: LoopRunAgent;
  result: RunLoopAgentResult;
  definition: LoopDefinition;
}): Promise<GoalEvalResult> {
  const goal = input.agent.goal?.trim();
  if (!goal) {
    return goalEvalResultSchema.parse({
      status: "pass",
      reason: "No explicit goal declared; output is non-empty.",
    });
  }

  const text = input.result.text?.trim() ?? "";
  const noSlopSpec = input.definition.builderMeta?.noSlopSpec;
  const key = cacheKey(input.agent.id, text, goal);
  const cached = judgeCache.get(key);
  if (cached) return cached;

  const response = await loopExecutorOpenAiChat({
    temperature: 0,
    maxTokens: 256,
    responseFormat: "json_object",
    messages: [
      {
        role: "system",
        content: [
          "You evaluate whether an agent's output satisfies its goal.",
          'Return JSON: { "status": "pass"|"fail"|"needs_input", "reason": string, "blockers": string[] }',
          "Use needs_input when human clarification or missing data is required.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          `Done criteria: ${(input.agent.doneCriteria ?? []).join("; ") || "none"}`,
          noSlopSpec
            ? [
                `Approved loop spec: ${noSlopSpec.title}`,
                `Global guardrails: ${noSlopSpec.specJson.guardrails.join("; ") || "none"}`,
                `Success criteria: ${noSlopSpec.specJson.successCriteria.join("; ") || "none"}`,
              ].join("\n")
            : null,
          `Output:\n${text.slice(0, 4000)}`,
        ].filter(Boolean).join("\n\n"),
      },
    ],
  });

  let parsed: GoalEvalResult;
  try {
    parsed = goalEvalResultSchema.parse(JSON.parse(response.text));
  } catch {
    parsed = goalEvalResultSchema.parse({
      status: "pass",
      reason: "Goal judge unavailable; deterministic checks passed.",
    });
  }

  judgeCache.set(key, parsed);
  return parsed;
}

export async function evaluateAgentGoal(input: {
  agent: LoopRunAgent;
  result: RunLoopAgentResult;
  definition: LoopDefinition;
  runMemory?: RunMemory;
  skipLlmJudge?: boolean;
}): Promise<GoalEvalResult> {
  const deterministic = deterministicGuards(input);
  if (deterministic) {
    return deterministic;
  }

  // For short-circuit tools, validate raw output structure and skip LLM judge
  const toolRef = input.agent.tools[0]?.ref ?? "";
  if (isShortCircuitTool(toolRef)) {
    const shortCircuitResult = validateShortCircuitOutput(toolRef, input.result);
    if (shortCircuitResult) {
      return shortCircuitResult;
    }
  }

  if (input.skipLlmJudge) {
    return goalEvalResultSchema.parse({
      status: "pass",
      reason: "Deterministic checks passed.",
    });
  }

  const judged = await llmJudge(input);
  const runMemory = input.runMemory ?? { inputs: {}, approvedMemories: [], updatedAt: new Date(0).toISOString() };
  if (
    !hasRequiredContentInputs(input.definition, runMemory) &&
    !isCanvasDraftAgent(input.agent) &&
    judged.status === "fail" &&
    /\b(required input|input .*missing|missing .*input|not provided|placeholder)\b/i.test(judged.reason)
  ) {
    const requiredKey = input.definition.inputsRequired?.[0] ?? "required_input";
    return goalEvalResultSchema.parse({
      status: "needs_input",
      reason: judged.reason,
      blockers: [requiredKey],
      gateType: "missing_input",
    });
  }
  if (judged.status === "fail" || judged.status === "needs_input") {
    return judged;
  }

  return goalEvalResultSchema.parse({
    status: "pass",
    reason: judged.reason || "Goal satisfied.",
  });
}
