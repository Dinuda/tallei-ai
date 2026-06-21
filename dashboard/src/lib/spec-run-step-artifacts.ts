export type StepArtifactRecord = {
  id: string;
  step_attempt_id?: string | null;
  artifact_key: string;
  kind: string;
  body: string;
  created_at?: string;
  data_json?: Record<string, unknown>;
  invalidated_at?: string | null;
};

export type StepLike = {
  id: string;
  status: string;
};

/** Agent prose that duplicates an inline email artifact panel. */
export function isArtifactSummaryNarration(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /the draft is ready/.test(normalized)
    || /output contract is satisfied/.test(normalized)
    || /proceeding to the delivery specialist/.test(normalized)
    || /the draft includes:/.test(normalized);
}

export function isRenderableOutputArtifact(artifact: StepArtifactRecord): boolean {
  if (artifact.invalidated_at) return false;
  if (
    artifact.kind === "canvas_email"
    || artifact.kind === "canvas_preview"
    || artifact.kind === "markdown"
    || artifact.kind === "preview"
  ) return true;
  const renderer = artifact.data_json?.renderer ?? artifact.data_json?.renderTarget;
  return typeof renderer === "string" && renderer.trim().length > 0;
}

export function resolveStepOutputArtifact(
  artifacts: StepArtifactRecord[] | undefined,
  stepAttemptId: string | undefined,
): StepArtifactRecord | null {
  if (!stepAttemptId || !artifacts?.length) return null;
  const matches = artifacts.filter((artifact) =>
    !artifact.invalidated_at
    && artifact.step_attempt_id === stepAttemptId
    && isRenderableOutputArtifact(artifact));
  if (matches.length === 0) return null;
  return [...matches].sort((left, right) => {
    const leftTime = left.created_at ? Date.parse(left.created_at) : 0;
    const rightTime = right.created_at ? Date.parse(right.created_at) : 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.artifact_key.localeCompare(right.artifact_key);
  })[0] ?? null;
}

export function resolveArtifactForStep(input: {
  artifacts?: StepArtifactRecord[];
  stepAttemptId?: string | null;
  gateArtifact?: StepArtifactRecord | null;
}): StepArtifactRecord | null {
  const stepId = input.stepAttemptId ?? undefined;
  if (!stepId) return null;
  if (input.gateArtifact?.step_attempt_id === stepId) return input.gateArtifact;
  return resolveStepOutputArtifact(input.artifacts, stepId);
}

export function shouldShowStepOutputArtifact(step: StepLike | undefined): boolean {
  if (!step) return false;
  return step.status === "succeeded"
    || step.status === "waiting_for_interaction"
    || step.status === "waiting_for_approval"
    || step.status === "running";
}
