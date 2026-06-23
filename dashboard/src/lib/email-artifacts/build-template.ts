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

const renderCache = new Map<string, { html: string; text: string }>();
const renderInflight = new Map<string, Promise<{ html: string; text: string }>>();
const templateBatchCache = new Map<string, EmailArtifactTemplate[]>();
const templateBatchInflight = new Map<string, Promise<EmailArtifactTemplate[]>>();

function renderCacheKey(template: { reactEmailSource: string; editorContent?: string }): string {
  return `${template.reactEmailSource}\0${template.editorContent ?? ""}`;
}

export function draftTemplatesSignature(draftTemplates?: BuilderDraftTemplate[]): string {
  const drafts = resolveBuilderDraftTemplates(draftTemplates);
  return JSON.stringify(drafts.map((draft) => ({
    templateId: draft.templateId,
    name: draft.name,
    props: draft.props,
  })));
}

export async function renderEmailArtifactTemplate(template: {
  reactEmailSource: string;
  editorContent?: string;
}): Promise<{ html: string; text: string }> {
  const cacheKey = renderCacheKey(template);
  const cached = renderCache.get(cacheKey);
  if (cached) return cached;

  const inflight = renderInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const props = JSON.parse(template.reactEmailSource) as EmailTemplateProps;
    const response = await fetch("/api/conductor/render-email-artifact", {
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
    const result = payload as { html: string; text: string };
    renderCache.set(cacheKey, result);
    return result;
  })();

  renderInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    renderInflight.delete(cacheKey);
  }
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

export type BuildEmailArtifactTemplatesOptions = {
  onTemplate?: (template: EmailArtifactTemplate, index: number, total: number) => void;
};

export async function buildEmailArtifactTemplates(
  draftTemplates?: BuilderDraftTemplate[],
  options?: BuildEmailArtifactTemplatesOptions,
): Promise<EmailArtifactTemplate[]> {
  const drafts = resolveBuilderDraftTemplates(draftTemplates);
  const batchKey = draftTemplatesSignature(drafts);
  const cached = templateBatchCache.get(batchKey);
  if (cached) {
    cached.forEach((template, index) => options?.onTemplate?.(template, index, cached.length));
    return cached;
  }

  const inflight = templateBatchInflight.get(batchKey);
  if (inflight) return inflight;

  const built: EmailArtifactTemplate[] = [];
  const promise = (async () => {
    for (let index = 0; index < drafts.length; index += 1) {
      const template = await buildEmailArtifactTemplate(drafts[index]);
      built.push(template);
      options?.onTemplate?.(template, index, drafts.length);
    }
    templateBatchCache.set(batchKey, built);
    return built;
  })();

  templateBatchInflight.set(batchKey, promise);
  try {
    return await promise;
  } finally {
    templateBatchInflight.delete(batchKey);
  }
}
