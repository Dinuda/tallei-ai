import { generateText } from "ai";

import { goalEvalResultSchema, type GoalEvalResult } from "../contracts/goal-eval-schema.js";
import { loopBuilderOpenAiModel, loopBuilderStreamProviderOptions } from "../llm/openai-chat.js";
import { resolveLoopChatLanguageModel } from "../../llm/loop-chat-client.js";
import type { CompiledSpecRunPlan, RunPlanAgent } from "./spec-run-plan.js";
import type { ResolvedHandoff } from "./spec-run-agent-runner.js";
import { RUNNER_BOUNDARY_PROTOCOL_VERSION } from "./runner-boundary.js";

type GenerateTextLike = typeof generateText;

export type EvaluateAgentHandoffInput = {
  plan: CompiledSpecRunPlan;
  agent: RunPlanAgent;
  nextAgent?: RunPlanAgent;
  rawOutput: unknown;
  structuredOutput: unknown;
  normalizedOutput: Record<string, unknown>;
  priorOutputs: Array<{ agentId: string; agentName: string; output: unknown }>;
  resolvedHandoff: ResolvedHandoff;
  contractIssues?: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return asRecord(parsed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      return asRecord(parsed);
    } catch {
      return null;
    }
  }
}

export function buildHandoffEvalPrompt(input: EvaluateAgentHandoffInput): string {
  return [
    `Protocol: ${RUNNER_BOUNDARY_PROTOCOL_VERSION}`,
    "",
    "Evaluate one completed agent boundary. Return only JSON.",
    "Allowed status values: pass, fail, retry, needs_input.",
    "Use fail for wrong deliverable ownership. Use retry for malformed or incomplete output the same agent can fix. Use needs_input only for missing operator/runtime data.",
    "Do not authorize tools, approve gates, or execute actions.",
    "Observational mentions of upstream artifacts are OK; fail only when the agent produced the wrong deliverable or claimed gate/delivery work without an interaction.",
    "",
    "Current agent:",
    JSON.stringify({
      id: input.agent.id,
      name: input.agent.name,
      goal: input.agent.goal,
      guardrails: input.agent.guardrails,
      doneCriteria: input.agent.doneCriteria,
      outputContract: input.agent.outputContract,
    }, null, 2),
    "",
    "Next agent:",
    input.nextAgent ? JSON.stringify({
      id: input.nextAgent.id,
      name: input.nextAgent.name,
      goal: input.nextAgent.goal,
      inputContract: input.nextAgent.inputContract,
      handoffBindings: input.nextAgent.handoffBindings,
    }, null, 2) : "none",
    "",
    "Resolved handoff for current/next boundary:",
    JSON.stringify(input.resolvedHandoff, null, 2),
    "",
    "Prior normalized context:",
    JSON.stringify(input.priorOutputs, null, 2),
    "",
    "Contract/parser issues:",
    JSON.stringify(input.contractIssues ?? [], null, 2),
    "",
    "Worker raw output:",
    JSON.stringify(input.rawOutput, null, 2),
    "",
    "Runtime-shaped output:",
    JSON.stringify(input.structuredOutput, null, 2),
    "",
    "Return JSON matching:",
    JSON.stringify({
      status: "pass | fail | retry | needs_input",
      reason: "operator-readable reason",
      blockers: ["optional blockers"],
      missingRequired: ["optional missing JSON pointer targets"],
      normalizedOutput: "object",
      normalizedHandoff: "object",
    }, null, 2),
  ].join("\n");
}

function fallbackEval(input: EvaluateAgentHandoffInput): GoalEvalResult {
  if (input.resolvedHandoff.missingRequired.length > 0) {
    return {
      status: "needs_input",
      reason: `Missing required handoff bindings: ${input.resolvedHandoff.missingRequired.join(", ")}`,
      blockers: input.resolvedHandoff.missingRequired,
      missingRequired: input.resolvedHandoff.missingRequired,
      normalizedOutput: input.normalizedOutput,
      normalizedHandoff: input.normalizedOutput,
    };
  }
  return {
    status: "pass",
    reason: "Output satisfies the current agent boundary.",
    blockers: [],
    normalizedOutput: input.normalizedOutput,
    normalizedHandoff: input.normalizedOutput,
  };
}

export async function evaluateAgentHandoff(
  input: EvaluateAgentHandoffInput,
  options?: { generateTextImpl?: GenerateTextLike },
): Promise<GoalEvalResult> {
  if (input.resolvedHandoff.missingRequired.length > 0) {
    return goalEvalResultSchema.parse(fallbackEval(input));
  }

  const modelId = loopBuilderOpenAiModel();
  const model = options?.generateTextImpl
    ? ({} as Parameters<GenerateTextLike>[0]["model"])
    : resolveLoopChatLanguageModel(modelId);
  try {
    const result = await (options?.generateTextImpl ?? generateText)({
      model,
      system: [
        "You are a bounded handoff evaluator for an agent workflow runtime.",
        "Return strict JSON only. Never authorize tools, gates, or connector actions.",
      ].join("\n"),
      prompt: buildHandoffEvalPrompt(input),
      providerOptions: loopBuilderStreamProviderOptions(modelId) as never,
    });
    const parsed = extractJsonObject(result.text);
    if (!parsed) throw new Error("Evaluator did not return JSON.");
    const normalizedOutput = asRecord(parsed.normalizedOutput);
    const normalizedHandoff = asRecord(parsed.normalizedHandoff);
    return goalEvalResultSchema.parse({
      ...parsed,
      normalizedOutput: Object.keys(normalizedOutput).length > 0 ? normalizedOutput : input.normalizedOutput,
      normalizedHandoff: Object.keys(normalizedHandoff).length > 0 ? normalizedHandoff : input.normalizedOutput,
    });
  } catch (error) {
    return goalEvalResultSchema.parse({
      status: "retry",
      reason: error instanceof Error ? error.message : "Handoff evaluator failed.",
      blockers: [error instanceof Error ? error.message : "Handoff evaluator failed."],
      normalizedOutput: input.normalizedOutput,
      normalizedHandoff: input.normalizedOutput,
    });
  }
}
