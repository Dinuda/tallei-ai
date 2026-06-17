import { nanoid } from "nanoid";

import {
  BUILDER_ARTIFACT_DESIGN_ID,
  BUILDER_DEFAULT_TEMPLATES,
  type BuilderDraftTemplate,
} from "@/lib/email-artifacts/builder-defaults";
import {
  normalizeEmailTemplateProps,
  templateTypeLabel,
} from "@/lib/email-artifacts/templates";
import type { EmailArtifactTemplate, EmailTemplateProps } from "@/lib/email-artifacts/types";

export async function renderEmailArtifactTemplate(template: {
  reactEmailSource: string;
  editorContent?: string;
}): Promise<{ html: string; text: string }> {
  const props = JSON.parse(template.reactEmailSource) as EmailTemplateProps;
  const response = await fetch("/api/loop-builder/render-email-artifact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      designId: BUILDER_ARTIFACT_DESIGN_ID,
      ...props,
      editorContent: template.editorContent,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Could not render template");
  }
  return payload as { html: string; text: string };
}

export async function buildEmailArtifactTemplate(
  draft: BuilderDraftTemplate,
): Promise<EmailArtifactTemplate> {
  const props = normalizeEmailTemplateProps(draft.props ?? {});
  const reactEmailSource = JSON.stringify(props);
  const rendered = await renderEmailArtifactTemplate({ reactEmailSource });
  return {
    id: nanoid(8),
    name: draft.name ?? templateTypeLabel(draft.templateId),
    templateId: draft.templateId,
    designId: BUILDER_ARTIFACT_DESIGN_ID,
    reactEmailSource,
    subject: props.subject,
    previewText: props.previewText,
    html: rendered.html,
    text: rendered.text,
  };
}

export function resolveBuilderDraftTemplates(
  draftTemplates?: BuilderDraftTemplate[],
): BuilderDraftTemplate[] {
  return draftTemplates?.length ? draftTemplates : BUILDER_DEFAULT_TEMPLATES;
}

export async function buildEmailArtifactTemplates(
  draftTemplates?: BuilderDraftTemplate[],
): Promise<EmailArtifactTemplate[]> {
  const drafts = resolveBuilderDraftTemplates(draftTemplates);
  return Promise.all(drafts.map((draft) => buildEmailArtifactTemplate(draft)));
}
