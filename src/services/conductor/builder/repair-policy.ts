import { InvalidToolInputError } from "ai";

import type { BuilderRepairClassification, BuilderRepairMetadata, BuilderRepairOutcome } from "./repair-protocol.js";

export type BuilderRepairDecision = {
  classification: BuilderRepairClassification;
  outcome: BuilderRepairOutcome;
  reason: string;
  fieldErrors: string[];
  lastValidationMessage: string;
};

function extractMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
  }
  return String(error ?? "");
}

function extractFieldErrors(message: string): string[] {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const fieldLines = lines.filter((line) =>
    /Array must contain at most|required|Expected|Invalid enum|too_big|too_small|invalid_type|missing/i.test(line));
  return [...new Set(fieldLines)].slice(0, 8);
}

export function classifyBuilderRepairFailure(input: {
  toolName: string;
  error: unknown;
}): BuilderRepairDecision {
  const message = extractMessage(input.error);
  const normalized = message.toLowerCase();
  const fieldErrors = extractFieldErrors(message);

  if (
    InvalidToolInputError.isInstance(input.error)
    || /json parsing failed|unexpected end|unterminated|stringified json|invalid json|tool input/i.test(normalized)
  ) {
    if (/unexpected end|unterminated|json parsing failed|invalid json|malformed json|expected ','|expected ':'/i.test(normalized)) {
      return {
        classification: "retryable_json_shape",
        outcome: "repair_and_retry",
        reason: `The ${input.toolName} payload was malformed and can be repaired automatically.`,
        fieldErrors,
        lastValidationMessage: message,
      };
    }
    if (/too_big|too_small|required|missing|required field|invalid enum|invalid_type|expected/i.test(normalized)) {
      return {
        classification: "retryable_schema_input",
        outcome: "repair_and_retry",
        reason: `The ${input.toolName} payload shape can be normalized and retried automatically.`,
        fieldErrors,
        lastValidationMessage: message,
      };
    }
  }

  if (/missing upstream artifact|artifact .* required|no .* artifact/i.test(normalized)) {
    return {
      classification: "pause_missing_upstream_artifact",
      outcome: "pause_for_repair",
      reason: `The ${input.toolName} step depends on an artifact that is not ready yet.`,
      fieldErrors,
      lastValidationMessage: message,
    };
  }

  if (/changed while this turn was running|wrong state|incompatible state|is not available while/i.test(normalized)) {
    return {
      classification: "pause_incompatible_state",
      outcome: "pause_for_repair",
      reason: `The builder state changed or no longer allows ${input.toolName}.`,
      fieldErrors,
      lastValidationMessage: message,
    };
  }

  if (/unavailable tool|model tried to call unavailable tool|connector .* required|connector .* unavailable|tool .* unavailable/i.test(normalized)) {
    return {
      classification: "pause_unavailable_tool_or_connector",
      outcome: "pause_for_repair",
      reason: `The required tool or connector for ${input.toolName} is not available in this builder state.`,
      fieldErrors,
      lastValidationMessage: message,
    };
  }

  if (/missing user choice|choose|select|operator input|approval required|requires explicit approval/i.test(normalized)) {
    return {
      classification: "pause_missing_user_choice",
      outcome: "pause_for_repair",
      reason: `The ${input.toolName} step needs a user choice before it can continue.`,
      fieldErrors,
      lastValidationMessage: message,
    };
  }

  return {
    classification: "fail_terminal_internal",
    outcome: "fail_terminal",
    reason: `The ${input.toolName} step failed outside the builder repair scope.`,
    fieldErrors,
    lastValidationMessage: message,
  };
}

export function buildRepairMetadata(
  blockedAction: string,
  attemptCount: number,
  decision: BuilderRepairDecision,
  attemptedFixes: string[],
): BuilderRepairMetadata {
  return {
    attemptCount,
    classification: decision.classification,
    outcome: decision.outcome,
    blockedAction,
    reason: decision.reason,
    fieldErrors: decision.fieldErrors,
    attemptedFixes,
    lastValidationMessage: decision.lastValidationMessage,
    pausedForRepair: decision.outcome === "pause_for_repair",
    terminal: decision.outcome === "fail_terminal",
  };
}
