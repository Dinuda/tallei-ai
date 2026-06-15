import { render } from "@react-email/render";

import { propsToEditorHtml, renderDesignComponent } from "./designs";
import { normalizeEmailTemplateProps, parseEmailTemplateProps } from "./templates";
import type { EmailDesignId, EmailTemplateProps } from "./types";

export async function renderDesignedEmail(input: {
  designId: EmailDesignId;
  props: EmailTemplateProps;
  editorContent?: string;
}): Promise<{ html: string; text: string }> {
  const props = normalizeEmailTemplateProps(input.props);

  if (input.editorContent?.trim()) {
    const html = input.editorContent.trim();
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { html, text };
  }

  const html = await render(renderDesignComponent(input.designId, props));
  const text = [
    props.subject,
    "",
    props.greeting,
    "",
    props.body,
    "",
    props.signOff,
    props.agentName ?? "Support Team",
  ].join("\n");
  return { html, text };
}

export async function renderDesignedEmailFromArtifact(input: {
  designId: EmailDesignId;
  reactEmailSource: string;
  editorContent?: string;
}): Promise<{ html: string; text: string } | null> {
  const props = parseEmailTemplateProps(input.reactEmailSource);
  if (!props) return null;
  return renderDesignedEmail({
    designId: input.designId,
    props,
    editorContent: input.editorContent,
  });
}

export function defaultEditorContent(reactEmailSource: string): string {
  const props = parseEmailTemplateProps(reactEmailSource);
  if (!props) return "<p></p>";
  return propsToEditorHtml(props);
}
