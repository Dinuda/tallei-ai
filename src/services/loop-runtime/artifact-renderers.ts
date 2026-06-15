import { buildCanvasEmailTemplate } from "./email-canvas.js";

type RenderedArtifact = {
  kind: string;
  body: string;
  data: Record<string, unknown>;
  marksPreview?: boolean;
};

type ArtifactRendererPlugin = {
  id: string;
  mediaTypes: string[];
  render(value: string): RenderedArtifact;
};

const renderers = new Map<string, ArtifactRendererPlugin>();

function registerArtifactRenderer(plugin: ArtifactRendererPlugin): void {
  renderers.set(plugin.id, plugin);
}

export function renderArtifact(rendererId: string, mediaType: string, value: string): RenderedArtifact {
  const renderer = renderers.get(rendererId);
  if (!renderer) throw new Error(`Unknown artifact renderer: ${rendererId}`);
  if (!renderer.mediaTypes.includes(mediaType)) {
    throw new Error(`Renderer ${rendererId} does not accept ${mediaType}`);
  }
  return renderer.render(value);
}

function structuredEmailMarkdown(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
  const row = parsed as Record<string, unknown>;
  const stringEntries = Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
  const subject = stringEntries.find(([key]) => /^(?:subject|title|headline)$/i.test(key))?.[1];
  const preview = stringEntries.find(([key]) => /^(?:preview|preheader|summary)$/i.test(key))?.[1];
  const body = stringEntries.find(([key]) => /^(?:body|content|message|markdown|text)$/i.test(key))?.[1]
    ?? stringEntries.find(([key]) => !/^(?:subject|title|headline|preview|preheader|summary)$/i.test(key))?.[1]
    ?? value;
  return [subject ? `Subject: ${subject}` : null, preview ? `Preview: ${preview}` : null, body]
    .filter(Boolean)
    .join("\n\n");
}

registerArtifactRenderer({
  id: "canvas.email",
  mediaTypes: ["text/markdown", "application/json"],
  render(value) {
    const emailTemplate = buildCanvasEmailTemplate({ markdown: structuredEmailMarkdown(value), finalUse: false });
    return { kind: "canvas_email", body: emailTemplate.html, data: { emailTemplate } };
  },
});

registerArtifactRenderer({
  id: "canvas.preview",
  mediaTypes: ["text/markdown", "application/json"],
  render(value) {
    const emailTemplate = buildCanvasEmailTemplate({ markdown: structuredEmailMarkdown(value), finalUse: true });
    return { kind: "canvas_preview", body: emailTemplate.html, data: { emailTemplate }, marksPreview: true };
  },
});
