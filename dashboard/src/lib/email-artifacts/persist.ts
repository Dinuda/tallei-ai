import type { ArtifactSetupOutput, EmailArtifactTemplate, EmailDesignId } from "./types";
import { EMAIL_DESIGN_CATALOG } from "./design-catalog";

export function buildArtifactOutput(
  templates: EmailArtifactTemplate[],
  designId: EmailDesignId,
  requirementId: string,
): ArtifactSetupOutput {
  const designName = EMAIL_DESIGN_CATALOG.find((entry) => entry.id === designId)?.name ?? designId;
  const countLabel = templates.length === 1 ? "reply template" : `${templates.length} reply templates`;
  return {
    answerText: `Approved ${countLabel} (${designName} design)`,
    requirementId,
    mode: "supplied_template",
    artifactPersisted: true,
    templates,
    value: { mode: "supplied_template", template: JSON.stringify({ designId, templates }) },
  };
}

export async function persistArtifactBundle(
  sessionId: string,
  output: ArtifactSetupOutput,
  messages?: unknown[],
): Promise<void> {
  const response = await fetch(`/api/conductor/sessions/${sessionId}/artifacts/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirementId: output.requirementId,
      value: output.value,
      ...(messages ? { messages } : {}),
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Could not save artifact templates");
  }
}

export function bundleDesignId(output: ArtifactSetupOutput): string | undefined {
  try {
    const bundle = JSON.parse(output.value.template ?? "{}") as { designId?: string };
    return bundle.designId;
  } catch {
    return undefined;
  }
}
