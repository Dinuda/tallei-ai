import { BUILDER_ARTIFACT_DESIGN_ID } from "./builder-defaults";
import { defaultEditorContent } from "./render-design";
import { normalizeEmailTemplateProps, parseEmailTemplateProps } from "./templates";
import type { EmailArtifactTemplate, EmailDesignId } from "./types";

export type CanvasEmailTemplateData = {
  design?: unknown;
  designId?: EmailDesignId;
  html?: string;
  text?: string;
  subject?: string;
  preview?: string;
  reactEmailSource?: string;
  editorContent?: string;
  updatedAt?: string;
  source?: string;
  finalUse?: boolean;
};

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function stripLeadingSubjectFromBody(subject: string, body: string): string {
  let result = body.trim();
  const subj = subject.trim();
  if (!subj || !result) return result;
  const escaped = subj.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let changed = true;
  while (changed) {
    changed = false;
    const next = result.replace(new RegExp(`^${escaped}(?:\\s*\\n|\\s+|$)`, "i"), "").trim();
    if (next !== result) {
      result = next;
      changed = true;
    }
  }
  return result;
}

function plainTextToEditorContent(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length === 0) return "<p></p>";
  return paragraphs.map((part) => `<p>${part.replace(/\n/g, "<br/>")}</p>`).join("\n");
}

export function htmlToEditorContent(html: string): string {
  const trimmed = html.trim();
  const bodyMatch = trimmed.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const inner = (bodyMatch ? bodyMatch[1] : trimmed).trim();
  if (!/<[a-z][\s\S]*>/i.test(inner)) {
    return plainTextToEditorContent(inner);
  }
  return inner;
}

/** Agent drafts are already complete emails — don't wrap them in builder greeting/sign-off. */
export function looksLikeCompleteAgentEmail(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (/^re:\s/m.test(trimmed)) return true;
  if (lower.includes("dear ") && /regards/i.test(trimmed)) return true;
  if (lower.includes("hi there") && trimmed.length > 80) return true;
  return trimmed.length > 160;
}

function isStructuredBuilderSource(source: string): boolean {
  const props = parseEmailTemplateProps(source);
  if (!props) return false;
  if (looksLikeCompleteAgentEmail(props.body)) return false;
  return Boolean(props.greeting?.trim() && props.signOff?.trim());
}

function sanitizeAgentReactEmailSource(source: string): string {
  const props = parseEmailTemplateProps(source);
  if (!props || !looksLikeCompleteAgentEmail(props.body)) return source;
  return JSON.stringify(normalizeEmailTemplateProps({
    subject: props.subject,
    previewText: props.previewText,
    greeting: "",
    body: props.body,
    signOff: "",
    agentName: "",
  }));
}

export function inferReactEmailSource(template: CanvasEmailTemplateData): string {
  if (typeof template.reactEmailSource === "string" && template.reactEmailSource.trim()) {
    return sanitizeAgentReactEmailSource(template.reactEmailSource);
  }

  const subject = template.subject?.trim() || "Draft";
  const rawBody = template.text?.trim()
    || stripHtml(template.html ?? "")
    || "Draft content";
  const body = stripLeadingSubjectFromBody(subject, rawBody);
  const isComplete = looksLikeCompleteAgentEmail(body);

  return JSON.stringify(normalizeEmailTemplateProps({
    subject,
    previewText: template.preview?.trim() || subject,
    greeting: isComplete ? "" : "Hi there,",
    body,
    signOff: isComplete ? "" : "Best regards,",
    agentName: isComplete ? "" : "Support Team",
  }));
}

export function resolveCanvasEmailEditorContent(template: CanvasEmailTemplateData): string {
  if (typeof template.editorContent === "string" && template.editorContent.trim()) {
    return htmlToEditorContent(template.editorContent);
  }
  if (typeof template.html === "string" && template.html.trim()) {
    return htmlToEditorContent(template.html);
  }
  if (typeof template.text === "string" && template.text.trim()) {
    return plainTextToEditorContent(template.text);
  }

  const reactEmailSource = inferReactEmailSource(template);
  const props = parseEmailTemplateProps(reactEmailSource);
  if (props && looksLikeCompleteAgentEmail(props.body)) {
    return plainTextToEditorContent(props.body);
  }
  if (isStructuredBuilderSource(reactEmailSource)) {
    return defaultEditorContent(reactEmailSource);
  }
  if (props?.body?.trim()) {
    return plainTextToEditorContent(props.body);
  }
  return "<p></p>";
}

export function resolveCanvasEmailDesignId(template: CanvasEmailTemplateData): EmailDesignId {
  if (template.designId) return template.designId;
  return BUILDER_ARTIFACT_DESIGN_ID;
}

export function buildEmailArtifactTemplateFromCanvas(
  artifactKey: string,
  template: CanvasEmailTemplateData,
  options?: { name?: string },
): EmailArtifactTemplate | null {
  const html = template.html?.trim();
  const text = template.text?.trim();
  const subject = template.subject?.trim();
  if (!html && !text && !subject) return null;

  const reactEmailSource = inferReactEmailSource(template);
  const editorContent = resolveCanvasEmailEditorContent(template);

  return {
    id: artifactKey,
    name: options?.name ?? subject ?? "Draft reply",
    templateId: "blank",
    designId: resolveCanvasEmailDesignId(template),
    reactEmailSource,
    editorContent,
    subject: subject ?? "Draft reply",
    previewText: template.preview?.trim() || subject,
    html: html ?? editorContent,
    text,
  };
}

export function canvasEmailSavePayload(input: {
  template: CanvasEmailTemplateData;
  editorContent: string;
  rendered: { html: string; text: string };
  subject: string;
  preview: string;
}) {
  const bodyText = input.rendered.text.trim();
  const reactEmailSource = JSON.stringify(normalizeEmailTemplateProps({
    subject: input.subject,
    previewText: input.preview || input.subject,
    greeting: "",
    body: bodyText,
    signOff: "",
    agentName: "",
  }));
  return {
    design: { variant: "react-email", designId: resolveCanvasEmailDesignId(input.template) },
    html: input.rendered.html,
    text: input.rendered.text,
    subject: input.subject,
    preview: input.preview,
    reactEmailSource,
    editorContent: input.editorContent,
    source: "dashboard",
    updatedAt: new Date().toISOString(),
  };
}
