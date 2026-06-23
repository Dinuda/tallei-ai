import type { RunnableArtifactTemplate } from "./build-run-context.js";

export function renderArtifactTemplate(
  template: Pick<RunnableArtifactTemplate, "subject" | "text" | "html">,
  variables: Record<string, string>,
): { subject: string; body: string; html: string } {
  const replaceVars = (value: string) => value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    return variables[key] ?? "";
  });

  const subject = replaceVars(template.subject);
  const textBody = template.text?.trim()
    ? replaceVars(template.text)
    : replaceVars(template.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  const html = replaceVars(template.html);

  return { subject, body: textBody, html };
}
