import { z } from "zod";

import { goalEvalResultSchema, type GoalEvalResult } from "../contracts/goal-eval-schema.js";

export const RUNNER_BOUNDARY_PROTOCOL_VERSION = "runner-boundary-v2" as const;

export const boundaryRouterDecisionSchema = z.enum([
  "continue",
  "pause_for_input",
  "retry_step",
  "fail_run",
  "finish_no_action",
]);

export type BoundaryRouterDecision = z.infer<typeof boundaryRouterDecisionSchema>;

export const agentBoundaryEnvelopeSchema = z.object({
  protocolVersion: z.literal(RUNNER_BOUNDARY_PROTOCOL_VERSION),
  rawOutput: z.unknown(),
  structuredOutput: z.unknown(),
  normalizedOutput: z.record(z.unknown()),
  normalizedHandoff: z.record(z.unknown()),
  goalEval: goalEvalResultSchema,
});

export type AgentBoundaryEnvelope = z.infer<typeof agentBoundaryEnvelopeSchema>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function readBoundaryEnvelope(outputJson: unknown): AgentBoundaryEnvelope | null {
  const output = asRecord(outputJson);
  const direct = agentBoundaryEnvelopeSchema.safeParse(output);
  if (direct.success) return direct.data;
  const nested = agentBoundaryEnvelopeSchema.safeParse(asRecord(output.data).boundaryEnvelope);
  return nested.success ? nested.data : null;
}

export function normalizedHandoffFromStepOutput(outputJson: unknown): Record<string, unknown> {
  const envelope = readBoundaryEnvelope(outputJson);
  if (envelope) return envelope.normalizedHandoff;
  const output = asRecord(outputJson);
  const data = asRecord(output.data);
  if (data.normalizedHandoff && typeof data.normalizedHandoff === "object" && !Array.isArray(data.normalizedHandoff)) {
    return data.normalizedHandoff as Record<string, unknown>;
  }
  if (data.structuredOutput && typeof data.structuredOutput === "object" && !Array.isArray(data.structuredOutput)) {
    return data.structuredOutput as Record<string, unknown>;
  }
  if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
    return data.data as Record<string, unknown>;
  }
  return data;
}

export function buildBoundaryEnvelope(input: {
  rawOutput: unknown;
  structuredOutput: unknown;
  normalizedOutput: Record<string, unknown>;
  normalizedHandoff: Record<string, unknown>;
  goalEval: GoalEvalResult;
}): AgentBoundaryEnvelope {
  return agentBoundaryEnvelopeSchema.parse({
    protocolVersion: RUNNER_BOUNDARY_PROTOCOL_VERSION,
    rawOutput: input.rawOutput,
    structuredOutput: input.structuredOutput,
    normalizedOutput: input.normalizedOutput,
    normalizedHandoff: input.normalizedHandoff,
    goalEval: input.goalEval,
  });
}

function statusFromOutput(output: Record<string, unknown>): string {
  const status = output.status;
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

export function isNoActionRequiredBoundaryOutput(output: unknown): boolean {
  const record = asRecord(output);
  const status = statusFromOutput(record);
  return status === "no_action_required" || status === "no_tickets_found" || status === "no_ticket_found";
}

export function routeBoundary(input: {
  goalEval: GoalEvalResult;
  normalizedOutput: Record<string, unknown>;
  structuredOutput?: unknown;
}): BoundaryRouterDecision {
  if (input.goalEval.status === "needs_input") return "pause_for_input";
  if (input.goalEval.status === "retry") return "retry_step";
  if (input.goalEval.status === "fail") return "fail_run";
  if (
    isNoActionRequiredBoundaryOutput(input.normalizedOutput)
    || isNoActionRequiredBoundaryOutput(input.structuredOutput)
  ) {
    return "finish_no_action";
  }
  return "continue";
}

export function projectStepOutputFromBoundary(input: {
  envelope: AgentBoundaryEnvelope;
  text?: string;
}): Record<string, unknown> {
  const text = input.text ?? (
    typeof asRecord(input.envelope.structuredOutput).text === "string"
      ? String(asRecord(input.envelope.structuredOutput).text)
      : ""
  );
  return {
    protocolVersion: input.envelope.protocolVersion,
    rawOutput: input.envelope.rawOutput,
    structuredOutput: input.envelope.structuredOutput,
    normalizedOutput: input.envelope.normalizedOutput,
    normalizedHandoff: input.envelope.normalizedHandoff,
    goalEval: input.envelope.goalEval,
    boundaryEnvelope: input.envelope,
    data: {
      structuredOutput: input.envelope.structuredOutput,
      data: input.envelope.structuredOutput,
      normalizedOutput: input.envelope.normalizedOutput,
      normalizedHandoff: input.envelope.normalizedHandoff,
      goalEval: input.envelope.goalEval,
      boundaryEnvelope: input.envelope,
    },
    text,
  };
}
