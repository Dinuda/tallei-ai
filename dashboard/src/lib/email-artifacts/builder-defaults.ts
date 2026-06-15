import type { EmailDesignId, EmailTemplateId, EmailTemplateProps } from "./types";

/** Only layout supported in the builder artifact UI for now. */
export const BUILDER_ARTIFACT_DESIGN_ID: EmailDesignId = "minimal";

export type BuilderDraftTemplate = {
  templateId: EmailTemplateId;
  name?: string;
  props?: Partial<EmailTemplateProps>;
};

export const BUILDER_DEFAULT_TEMPLATES: BuilderDraftTemplate[] = [
  { templateId: "acknowledgment" },
  { templateId: "troubleshooting" },
  { templateId: "escalation" },
  { templateId: "resolution" },
];
