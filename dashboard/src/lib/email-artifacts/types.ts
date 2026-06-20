export type EmailTemplateId =
  | "acknowledgment"
  | "troubleshooting"
  | "escalation"
  | "resolution"
  | "blank";

/** Visual layouts from the React Email template library (community designs). */
export type EmailDesignId =
  | "minimal"
  | "vercel-invite"
  | "stripe-receipt"
  | "notion-magic-link"
  | "linear-welcome"
  | "apple-receipt";

export type EmailTemplateProps = {
  subject: string;
  previewText?: string;
  greeting: string;
  body: string;
  signOff: string;
  agentName?: string;
};

export type EmailArtifactTemplate = {
  id: string;
  name: string;
  templateId: EmailTemplateId;
  designId: EmailDesignId;
  reactEmailSource: string;
  subject: string;
  previewText?: string;
  html: string;
  text?: string;
  /** TipTap / React Email editor document or exported body HTML after manual edits. */
  editorContent?: string;
};

export type ArtifactSetupOutput = {
  answerText: string;
  requirementId: string;
  mode: "supplied_template" | "approved_generated_structure" | "none";
  /** Set when the full rendered bundle was persisted server-side during approval. */
  artifactPersisted?: boolean;
  templates?: EmailArtifactTemplate[];
  structure?: string;
  value: {
    mode: "supplied_template" | "approved_generated_structure" | "none";
    template?: string;
    structure?: string;
  };
};
