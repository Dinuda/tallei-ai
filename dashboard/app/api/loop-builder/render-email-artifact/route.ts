import { z } from "zod";

import { renderDesignedEmail } from "@/lib/email-artifacts/render-design";
import { normalizeEmailTemplateProps } from "@/lib/email-artifacts/templates";

const bodySchema = z.object({
  designId: z.enum([
    "minimal",
    "vercel-invite",
    "stripe-receipt",
    "notion-magic-link",
    "linear-welcome",
    "apple-receipt",
  ]).default("minimal"),
  subject: z.string().optional(),
  previewText: z.string().optional(),
  greeting: z.string().optional(),
  body: z.string().optional(),
  signOff: z.string().optional(),
  agentName: z.string().optional(),
  editorContent: z.string().optional(),
}).transform((value) => ({
  designId: value.designId,
  props: normalizeEmailTemplateProps(value),
  editorContent: value.editorContent,
}));

export async function POST(request: Request) {
  try {
    const payload = bodySchema.parse(await request.json());
    const rendered = await renderDesignedEmail(payload);
    return Response.json(rendered);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not render email template";
    return Response.json({ error: message }, { status: 400 });
  }
}
