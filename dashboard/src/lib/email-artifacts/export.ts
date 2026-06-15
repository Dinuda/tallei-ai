import type { EmailArtifactTemplate } from "./types";

export function featuredTemplate(templates: EmailArtifactTemplate[]): EmailArtifactTemplate | null {
  return templates[0] ?? null;
}

export function templateDocumentLines(template: EmailArtifactTemplate): string[] {
  const bodyText = template.text ?? "";
  const lines = [
    template.name,
    template.subject,
    template.previewText?.trim() || "",
    ...bodyText.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6),
  ].filter(Boolean);
  return lines;
}

export async function copyTemplateBundle(templates: EmailArtifactTemplate[]): Promise<void> {
  const text = templates.map((template) => (
    `## ${template.name}\nSubject: ${template.subject}\n\n${(template.text ?? "").trim()}`
  )).join("\n\n---\n\n");
  await navigator.clipboard.writeText(text);
}

export function downloadTemplateHtml(template: EmailArtifactTemplate): void {
  const blob = new Blob([template.html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${template.name.replace(/[^\w.-]+/g, "-").toLowerCase() || "email"}.html`;
  anchor.click();
  URL.revokeObjectURL(url);
}
