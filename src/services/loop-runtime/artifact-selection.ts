type ArtifactSelectionRow = {
  artifact_key: string;
  kind: string;
  body: string;
  data_json?: unknown;
  created_at?: string | null;
  version?: number | null;
  step_index?: number | null;
};

type ArtifactEmailTemplate = {
  html?: string;
  text?: string;
  subject?: string;
  preview?: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function artifactTimestamp(artifact: Pick<ArtifactSelectionRow, "created_at">): number {
  if (!artifact.created_at) return 0;
  const timestamp = Date.parse(artifact.created_at);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function artifactPriority(artifact: Pick<ArtifactSelectionRow, "kind" | "data_json">): number {
  const template = readArtifactEmailTemplate(artifact.data_json);
  if (artifact.kind === "canvas_preview") return 3;
  if (artifact.kind === "canvas_email") return 2;
  if (template) return 1;
  return 0;
}

function compareArtifactsChronologically<T extends ArtifactSelectionRow>(left: T, right: T): number {
  const timeDiff = artifactTimestamp(left) - artifactTimestamp(right);
  if (timeDiff !== 0) return timeDiff;
  const stepDiff = (left.step_index ?? 0) - (right.step_index ?? 0);
  if (stepDiff !== 0) return stepDiff;
  const versionDiff = (left.version ?? 0) - (right.version ?? 0);
  if (versionDiff !== 0) return versionDiff;
  return left.artifact_key.localeCompare(right.artifact_key);
}

function compareArtifactsForDisplay<T extends ArtifactSelectionRow>(left: T, right: T): number {
  const priorityDiff = artifactPriority(right) - artifactPriority(left);
  if (priorityDiff !== 0) return priorityDiff;
  const timeDiff = artifactTimestamp(right) - artifactTimestamp(left);
  if (timeDiff !== 0) return timeDiff;
  const stepDiff = (right.step_index ?? 0) - (left.step_index ?? 0);
  if (stepDiff !== 0) return stepDiff;
  const versionDiff = (right.version ?? 0) - (left.version ?? 0);
  if (versionDiff !== 0) return versionDiff;
  return left.artifact_key.localeCompare(right.artifact_key);
}

function readArtifactEmailTemplate(dataJson: unknown): ArtifactEmailTemplate | null {
  const root = asObject(dataJson);
  const template = asObject(root.emailTemplate);
  const html = textOrUndefined(template.html);
  const text = textOrUndefined(template.text);
  const subject = textOrUndefined(template.subject);
  const preview = textOrUndefined(template.preview);
  if (!html && !text && !subject && !preview) return null;
  return {
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(subject ? { subject } : {}),
    ...(preview ? { preview } : {}),
  };
}

function hasDraftEmailContent<T extends Pick<ArtifactSelectionRow, "kind" | "data_json">>(artifact: T): boolean {
  return artifact.kind === "canvas_email"
    || artifact.kind === "canvas_preview"
    || readArtifactEmailTemplate(artifact.data_json) !== null;
}

export function selectLatestArtifactsByKey<T extends ArtifactSelectionRow>(artifacts: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const artifact of [...artifacts].sort(compareArtifactsChronologically)) {
    byKey.set(artifact.artifact_key, artifact);
  }
  return [...byKey.values()].sort(compareArtifactsForDisplay);
}

export function selectPreferredArtifact<T extends ArtifactSelectionRow>(artifacts: T[]): T | null {
  const preferred = artifacts.filter((artifact) => hasDraftEmailContent(artifact));
  const pool = preferred.length > 0 ? preferred : artifacts;
  return [...pool].sort(compareArtifactsForDisplay)[0] ?? null;
}

export function buildArtifactDeliveryPayload<T extends Pick<ArtifactSelectionRow, "body" | "data_json">>(artifact: T | null | undefined) {
  const template = artifact ? readArtifactEmailTemplate(artifact.data_json) : null;
  const html = template?.html ?? "";
  const text = template?.text ?? "";
  const subject = template?.subject ?? "";
  const preview = template?.preview ?? "";
  const content = html || text || artifact?.body?.trim() || "";
  return {
    ...(content ? { content } : {}),
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(subject ? { subject } : {}),
    ...(preview ? { preview } : {}),
  };
}
