import { z } from "zod";

import { goalEvalResultSchema, type GoalEvalResult } from "../loop-engine/contracts.js";

export const RUNNER_BOUNDARY_PROTOCOL_VERSION = "runner-boundary-v1" as const;

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
