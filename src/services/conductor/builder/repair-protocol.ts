export const BUILDER_REPAIR_MAX_RETRIES = 2;

export type BuilderRepairOutcome =
  | "repair_and_retry"
  | "pause_for_repair"
  | "fail_terminal";

export type BuilderRepairClassification =
  | "retryable_schema_input"
  | "retryable_json_shape"
  | "pause_missing_user_choice"
  | "pause_missing_upstream_artifact"
  | "pause_incompatible_state"
  | "pause_unavailable_tool_or_connector"
  | "fail_terminal_internal";

export type BuilderRepairMetadata = {
  attemptCount: number;
  classification: BuilderRepairClassification;
  outcome: BuilderRepairOutcome;
  blockedAction: string;
  reason: string;
  fieldErrors: string[];
  attemptedFixes: string[];
  lastValidationMessage: string;
  pausedForRepair: boolean;
  terminal: boolean;
};

export function emptyBuilderRepairMetadata(blockedAction: string): BuilderRepairMetadata {
  return {
    attemptCount: 0,
    classification: "retryable_schema_input",
    outcome: "repair_and_retry",
    blockedAction,
    reason: "",
    fieldErrors: [],
    attemptedFixes: [],
    lastValidationMessage: "",
    pausedForRepair: false,
    terminal: false,
  };
}
