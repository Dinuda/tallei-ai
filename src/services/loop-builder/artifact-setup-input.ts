import { z } from "zod";

import { tryParseToolInputJson } from "./tool-input-json-repair.js";

const artifactTemplateIdSchema = z.enum([
  "acknowledgment",
  "troubleshooting",
  "escalation",
  "resolution",
  "blank",
]);

const artifactSetupInputSchema = z.object({
  requirementId: z.string().min(1).default("artifact_contract"),
  draftTemplates: z.array(z.object({
    templateId: artifactTemplateIdSchema,
    name: z.string().optional(),
    props: z.object({
      subject: z.string().optional(),
      previewText: z.string().optional(),
      greeting: z.string().optional(),
      body: z.string().optional(),
      signOff: z.string().optional(),
      agentName: z.string().optional(),
    }).optional(),
  })).optional(),
});

export type ArtifactSetupToolInput = z.infer<typeof artifactSetupInputSchema>;

const SUPPORT_REPLY_TEMPLATE_DEFAULTS: ArtifactSetupToolInput["draftTemplates"] = [
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

function extractTemplateIdsFromBrokenJson(text: string): Array<z.infer<typeof artifactTemplateIdSchema>> {
  const found = new Set<z.infer<typeof artifactTemplateIdSchema>>();
  for (const match of text.matchAll(/templateId["\s:]*["']?(acknowledgment|troubleshooting|escalation|resolution|blank)/gi)) {
    const id = match[1]?.toLowerCase();
    const parsed = artifactTemplateIdSchema.safeParse(id);
    if (parsed.success) found.add(parsed.data);
  }
  return [...found];
}

function extractRequirementId(text: string): string {
  const match = text.match(/requirementId["\s:]*["']([a-z0-9_-]+)/i);
  return match?.[1]?.trim() || "artifact_contract";
}

export function defaultArtifactSetupInput(requirementId = "artifact_contract"): ArtifactSetupToolInput {
  return artifactSetupInputSchema.parse({
    requirementId,
    draftTemplates: SUPPORT_REPLY_TEMPLATE_DEFAULTS,
  });
}

export function normalizeArtifactSetupInput(value: unknown): ArtifactSetupToolInput | null {
  const parsed = artifactSetupInputSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const requirementId = typeof record.requirementId === "string" && record.requirementId.trim()
    ? record.requirementId.trim()
    : "artifact_contract";
  const draftTemplates = Array.isArray(record.draftTemplates)
    ? record.draftTemplates.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      const templateId = artifactTemplateIdSchema.safeParse(row.templateId);
      if (!templateId.success) return [];
      const props = row.props && typeof row.props === "object" && !Array.isArray(row.props)
        ? row.props as Record<string, unknown>
        : undefined;
      return [{
        templateId: templateId.data,
        ...(typeof row.name === "string" ? { name: row.name } : {}),
        ...(props ? {
          props: {
            ...(typeof props.subject === "string" ? { subject: props.subject } : {}),
            ...(typeof props.previewText === "string" ? { previewText: props.previewText } : {}),
            ...(typeof props.greeting === "string" ? { greeting: props.greeting } : {}),
            ...(typeof props.body === "string" ? { body: props.body } : {}),
            ...(typeof props.signOff === "string" ? { signOff: props.signOff } : {}),
            ...(typeof props.agentName === "string" ? { agentName: props.agentName } : {}),
          },
        } : {}),
      }];
    })
    : undefined;
  if (!draftTemplates?.length) return null;
  return artifactSetupInputSchema.parse({ requirementId, draftTemplates });
}

export function repairArtifactSetupToolInput(raw: string): string | null {
  const parsed = tryParseToolInputJson(raw);
  const normalized = parsed ? normalizeArtifactSetupInput(parsed) : null;
  if (normalized) return JSON.stringify(normalized);

  const templateIds = extractTemplateIdsFromBrokenJson(raw);
  if (templateIds.length > 0) {
    const defaults = defaultArtifactSetupInput(extractRequirementId(raw));
    const byId = new Map((defaults.draftTemplates ?? []).map((entry) => [entry.templateId, entry]));
    return JSON.stringify(artifactSetupInputSchema.parse({
      requirementId: extractRequirementId(raw),
      draftTemplates: templateIds.map((templateId) => byId.get(templateId) ?? { templateId }),
    }));
  }

  return JSON.stringify(defaultArtifactSetupInput(extractRequirementId(raw)));
}
