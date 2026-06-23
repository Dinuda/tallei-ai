"use server";

import { BUILDER_ARTIFACT_DESIGN_ID } from "./builder-defaults";
import { renderDesignedEmail } from "./render-design";
import { normalizeEmailTemplateProps } from "./templates";
import type { EmailTemplateProps } from "./types";

export async function renderEmailArtifactOnServer(input: {
  reactEmailSource: string;
  editorContent?: string;
}): Promise<{ html: string; text: string }> {
  const props = JSON.parse(input.reactEmailSource) as EmailTemplateProps;
  return renderDesignedEmail({
    designId: BUILDER_ARTIFACT_DESIGN_ID,
    props: normalizeEmailTemplateProps(props),
    editorContent: input.editorContent,
  });
}
