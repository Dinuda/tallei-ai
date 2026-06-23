import { z } from "zod";

import { tryParseToolInputJson } from "../repair/tool-input-json-repair.js";

export const emailDraftTemplateIdSchema = z.enum([
  "acknowledgment",
  "troubleshooting",
  "escalation",
  "resolution",
  "blank",
]);

const emailDraftTemplateSchema = z.object({
  templateId: emailDraftTemplateIdSchema,
  name: z.string().optional(),
  props: z.object({
    subject: z.string().optional(),
    previewText: z.string().optional(),
    greeting: z.string().optional(),
    body: z.string().optional(),
    signOff: z.string().optional(),
    agentName: z.string().optional(),
  }).optional(),
});

export const renderTypeInputSchema = z.object({
  renderType: z.literal("canvas.email").default("canvas.email"),
  draftTemplates: z.array(emailDraftTemplateSchema).optional(),
});

export type RenderTypeToolInput = z.infer<typeof renderTypeInputSchema>;

export const SUPPORT_REPLY_DRAFT_TEMPLATES: NonNullable<RenderTypeToolInput["draftTemplates"]> = [
  {
    templateId: "acknowledgment",
    name: "Acknowledgment Reply",
    props: {
      subject: "Re: {{customer_subject}}",
      previewText: "Thanks for reaching out — we've received your request",
      greeting: "Hi {{customer_name}},",
      body: "Thanks for contacting our support team. We've received your message and will get back to you shortly.\n\nYour request has been logged and we'll prioritize it accordingly.",
      signOff: "Best regards,\n{{agent_name}}",
    },
  },
  {
    templateId: "troubleshooting",
    name: "Troubleshooting / Info Request",
    props: {
      subject: "Re: {{customer_subject}}",
      previewText: "A few details to help resolve your issue",
      greeting: "Hi {{customer_name}},",
      body: "Thanks for reaching out. To help resolve your issue as quickly as possible, could you please provide the following details:\n\n1. When did you first notice this issue?\n2. What steps have you tried so far?\n3. Any error messages or screenshots you can share?",
      signOff: "Looking forward to your reply,\n{{agent_name}}",
    },
  },
  {
    templateId: "escalation",
    name: "Escalation Notice",
    props: {
      subject: "Re: {{customer_subject}}",
      previewText: "Your issue has been escalated to our senior team",
      greeting: "Hi {{customer_name}},",
      body: "Thank you for your patience. Due to the nature of your request, I'm escalating this to our senior support team who will follow up with you directly.\n\nThey have all the context from our conversation so you won't need to repeat anything.",
      signOff: "We're on it,\n{{agent_name}}",
    },
  },
  {
    templateId: "resolution",
    name: "Resolution / Follow-up",
    props: {
      subject: "Re: {{customer_subject}}",
      previewText: "Here's how we've resolved your issue",
      greeting: "Hi {{customer_name}},",
      body: "Thanks for your patience while we worked on this.\n\nHere's a summary of what was done and the resolution:\n\n{{resolution_details}}\n\nPlease let us know if everything is working as expected, or if there's anything else we can help with.",
      signOff: "Best regards,\n{{agent_name}}",
    },
  },
];

export function defaultRenderTypeInput(): RenderTypeToolInput {
  return renderTypeInputSchema.parse({
    renderType: "canvas.email",
    draftTemplates: SUPPORT_REPLY_DRAFT_TEMPLATES,
  });
}

function extractTemplateIdsFromBrokenJson(text: string): Array<z.infer<typeof emailDraftTemplateIdSchema>> {
  const found = new Set<z.infer<typeof emailDraftTemplateIdSchema>>();
  for (const match of text.matchAll(/templateId["\s:]*["']?(acknowledgment|troubleshooting|escalation|resolution|blank)/gi)) {
    const id = match[1]?.toLowerCase();
    const parsed = emailDraftTemplateIdSchema.safeParse(id);
    if (parsed.success) found.add(parsed.data);
  }
  return [...found];
}

export function repairRenderTypeToolInput(raw: string): string | null {
  const parsed = tryParseToolInputJson(raw);
  const normalized = parsed ? renderTypeInputSchema.safeParse(parsed) : null;
  if (normalized?.success) return JSON.stringify(normalized.data);

  const templateIds = extractTemplateIdsFromBrokenJson(raw);
  if (templateIds.length > 0) {
    const defaults = defaultRenderTypeInput();
    const byId = new Map((defaults.draftTemplates ?? []).map((entry) => [entry.templateId, entry]));
    return JSON.stringify(renderTypeInputSchema.parse({
      renderType: "canvas.email",
      draftTemplates: templateIds.map((templateId) => byId.get(templateId) ?? { templateId }),
    }));
  }

  return JSON.stringify(defaultRenderTypeInput());
}
