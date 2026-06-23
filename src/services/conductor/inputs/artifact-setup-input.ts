import { z } from "zod";

import {
  emailDraftTemplateIdSchema,
  SUPPORT_REPLY_DRAFT_TEMPLATES,
} from "../builder/render-type.js";
import { tryParseToolInputJson } from "../repair/tool-input-json-repair.js";

const artifactSetupInputSchema = z.object({
  requirementId: z.string().min(1).default("artifact_contract"),
  draftTemplates: z.array(z.object({
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
  })).optional(),
});

export type ArtifactSetupToolInput = z.infer<typeof artifactSetupInputSchema>;

function extractTemplateIdsFromBrokenJson(text: string): Array<z.infer<typeof emailDraftTemplateIdSchema>> {
  const found = new Set<z.infer<typeof emailDraftTemplateIdSchema>>();
  for (const match of text.matchAll(/templateId["\s:]*["']?(acknowledgment|troubleshooting|escalation|resolution|blank)/gi)) {
    const id = match[1]?.toLowerCase();
    const parsed = emailDraftTemplateIdSchema.safeParse(id);
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
    draftTemplates: SUPPORT_REPLY_DRAFT_TEMPLATES,
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
      const templateId = emailDraftTemplateIdSchema.safeParse(row.templateId);
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
