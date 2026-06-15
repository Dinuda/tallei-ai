import { renderDesignedEmail, renderDesignedEmailFromArtifact } from "./render-design";
import type { EmailDesignId, EmailTemplateProps } from "./types";

/** @deprecated Use renderDesignedEmail with a designId */
export async function renderEmailTemplate(
  props: EmailTemplateProps,
  designId: EmailDesignId = "minimal",
): Promise<{ html: string; text: string }> {
  return renderDesignedEmail({ designId, props });
}

export async function renderEmailTemplateFromSource(
  reactEmailSource: string,
  designId: EmailDesignId = "minimal",
): Promise<{ html: string; text: string } | null> {
  return renderDesignedEmailFromArtifact({ designId, reactEmailSource });
}
