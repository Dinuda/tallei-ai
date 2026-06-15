import type { EmailArtifactTemplate } from "./types";

export function templatesSignature(templates: EmailArtifactTemplate[]): string {
  return JSON.stringify(templates.map((template) => ({
    id: template.id,
    templateId: template.templateId,
    subject: template.subject,
    html: template.html,
    editorContent: template.editorContent,
    reactEmailSource: template.reactEmailSource,
  })));
}
