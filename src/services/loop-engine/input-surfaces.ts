import { z } from "zod";

export const inputSurfaceSchema = z.enum([
  "input.text",
  "input.markdown",
  "input.contacts_csv",
  "input.audience_id",
  "input.file",
  "review.draft",
  "review.email",
  "review.preview",
  "review.sources",
  "review.memories",
  "confirm.send",
]);

export type InputSurface = z.infer<typeof inputSurfaceSchema>;

const INPUT_SURFACE_VALUES = inputSurfaceSchema.options;

/** Coerce LLM-invented surface strings to a supported InputSurface. */
export function normalizeInputSurface(value: unknown, key = ""): InputSurface {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if ((INPUT_SURFACE_VALUES as readonly string[]).includes(trimmed)) {
      return trimmed as InputSurface;
    }
    if (/boolean|bool|checkbox|toggle|switch|yes_no|yesno/.test(trimmed)) {
      if (/confirm|approve|send|acknowledge|consent/i.test(key)) return "confirm.send";
      return "input.text";
    }
    if (/markdown|rich.?text|long.?text|notes|document/.test(trimmed)) return "input.markdown";
    if (/csv|contact|recipient|subscriber|email.?list|mailing/.test(trimmed)) return "input.contacts_csv";
    if (/audience|list.?id|segment/.test(trimmed)) return "input.audience_id";
    if (/file|upload|attachment/.test(trimmed)) return "input.file";
    if (/source|web.?search|url/i.test(trimmed)) return "review.sources";
    if (/memor/i.test(trimmed)) return "review.memories";
    if (/final.?preview|read.?only.?preview|review\.preview/.test(trimmed)) return "review.preview";
    if (/review|draft|preview/.test(trimmed)) return "review.draft";
    if (/email.?review|canvas/.test(trimmed)) return "review.email";
    if (/confirm|approve|send/.test(trimmed)) return "confirm.send";
    if (/text|string|input|textarea|freeform/.test(trimmed)) return "input.text";
  }
  return defaultSurfaceForKey(key);
}

function normalizeInputRequirementWhen(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "run_start" || trimmed === "before_send" || trimmed === "before_step") return trimmed;
  if (/send|pre.?send|delivery|recipient/.test(trimmed)) return "before_send";
  if (/step|agent|mid.?run/.test(trimmed)) return "before_step";
  return "run_start";
}

function preprocessInputRequirement(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const key = typeof row.key === "string" ? row.key.trim() : "";
  return {
    ...row,
    key,
    surface: normalizeInputSurface(row.surface, key),
    when: normalizeInputRequirementWhen(row.when),
  };
}

export function normalizeInputRequirementsArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(preprocessInputRequirement);
}

export const inputRequirementWhenSchema = z.enum(["run_start", "before_send", "before_step"]);

export type InputRequirementWhen = z.infer<typeof inputRequirementWhenSchema>;

export const inputRequirementSchema = z.preprocess(
  preprocessInputRequirement,
  z.object({
    key: z.string().min(1).trim(),
    surface: inputSurfaceSchema,
    label: z.string().min(1).trim().optional(),
    description: z.string().min(1).trim().optional(),
    required: z.boolean().default(true),
    when: inputRequirementWhenSchema.default("run_start"),
  }),
);

export type InputRequirement = z.infer<typeof inputRequirementSchema>;

function isDeliveryConfigInputKey(key: string): boolean {
  return /subscriber|audience|recipient|mailing.?list|contact.?list|list.?id|send.?to|broadcast.?list/i.test(key.trim());
}

export type InputRequirementContext = {
  recipientKind: string;
  deliveryTarget: string;
};

export function extractInputRequirementContext(root: Record<string, unknown>): InputRequirementContext {
  const delivery = root.delivery && typeof root.delivery === "object" && !Array.isArray(root.delivery)
    ? root.delivery as Record<string, unknown>
    : {};
  const connectorPolicy = root.connectorPolicy && typeof root.connectorPolicy === "object" && !Array.isArray(root.connectorPolicy)
    ? root.connectorPolicy as Record<string, unknown>
    : {};
  const recipientSource = connectorPolicy.recipientSource && typeof connectorPolicy.recipientSource === "object" && !Array.isArray(connectorPolicy.recipientSource)
    ? connectorPolicy.recipientSource as Record<string, unknown>
    : {};
  return {
    recipientKind: typeof recipientSource.kind === "string" ? recipientSource.kind : "none",
    deliveryTarget: typeof delivery.target === "string" ? delivery.target : "none",
  };
}

function parseInputRequirementRow(row: unknown): InputRequirement | null {
  const preprocessed = preprocessInputRequirement(row);
  const parsed = inputRequirementSchema.safeParse(preprocessed);
  return parsed.success ? parsed.data : null;
}

export function normalizeSpecInputRequirements(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.inputRequirements)) return value;
  const context = extractInputRequirementContext(root);
  const requirements = root.inputRequirements
    .map((row) => parseInputRequirementRow(row))
    .filter((row): row is InputRequirement => Boolean(row));
  const delivery = root.delivery && typeof root.delivery === "object" && !Array.isArray(root.delivery)
    ? root.delivery as Record<string, unknown>
    : {};
  const target = typeof delivery.target === "string" ? delivery.target : "none";
  return {
    ...root,
    inputRequirements: sanitizeInputRequirementsForDelivery(
      canonicalizeInputRequirementsList(requirements, context),
      target,
    ),
  };
}

export const surfaceSubmissionValueSchema = z.object({
  surface: inputSurfaceSchema,
  text: z.string().optional(),
  contacts: z.array(z.object({
    email: z.string().email(),
    name: z.string().optional(),
  })).optional(),
  audienceId: z.string().min(1).optional(),
  csvText: z.string().optional(),
  fileRef: z.string().min(1).optional(),
});

export type SurfaceSubmissionValue = z.infer<typeof surfaceSubmissionValueSchema>;

export const gateSurfaceSubmissionSchema = z.record(surfaceSubmissionValueSchema);

/** Legacy string keys derived from structured requirements. */
export function inputRequirementKeys(requirements: InputRequirement[]): string[] {
  return [...new Set(requirements.map((req) => req.key))];
}

export function defaultLabelForKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function defaultSurfaceForKey(key: string): InputSurface {
  if (/recipient|contact|subscriber|audience|mailing/i.test(key)) return "input.contacts_csv";
  if (/audience_id|list_id|segment_id/i.test(key)) return "input.audience_id";
  if (/file|document|attachment|csv/i.test(key)) return "input.file";
  if (/confirm|approve|pre.?send/i.test(key)) return "confirm.send";
  if (/notes|brief|content|body|sync|sprint/i.test(key)) return "input.markdown";
  return "input.text";
}

export function isReviewInputSurface(surface: InputSurface): boolean {
  return surface === "review.draft"
    || surface === "review.email"
    || surface === "review.preview"
    || surface === "review.sources"
    || surface === "review.memories"
    || surface === "confirm.send";
}

/** Map legacy agent gate.type to the canonical operator surface (UI contract). */
export function defaultSurfaceForGateType(gateType: string): InputSurface {
  switch (gateType) {
    case "memory_confirmation": return "review.memories";
    case "source_confirmation": return "review.sources";
    case "draft_review": return "review.draft";
    case "pre_send": return "confirm.send";
    case "recipient_upload": return "input.contacts_csv";
    case "missing_input":
    default:
      return "input.markdown";
  }
}

export function isApprovalSurface(surface: InputSurface): boolean {
  return surface === "review.sources"
    || surface === "review.memories"
    || surface === "review.draft"
    || surface === "review.email"
    || surface === "review.preview"
    || surface === "confirm.send";
}

export function isInputSurface(surface: InputSurface): boolean {
  return surface.startsWith("input.");
}

export function isRecipientInputKey(key: string): boolean {
  return /recipient|recipients.?upload|contact.?upload|contacts.?upload|contact.?list|subscriber|audience|mailing.?list|list.?id|segment.?id|send.?to|broadcast.?list/i.test(key.trim());
}

export function isConfirmInputKey(key: string): boolean {
  return /confirm|approve|pre.?send|send.?approval/i.test(key.trim());
}

export function canonicalizeInputRequirement(
  req: InputRequirement,
  context: { recipientKind: string; deliveryTarget: string },
): InputRequirement {
  const key = req.key.trim();
  const lowerKey = key.toLowerCase();

  if (isConfirmInputKey(lowerKey) || req.surface === "confirm.send") {
    return {
      ...req,
      key: "confirm_send",
      surface: "confirm.send",
      when: "before_send",
      label: req.label ?? "Confirm send",
    };
  }

  if (isReviewInputSurface(req.surface)) {
    return {
      ...req,
      when: req.when === "run_start" ? "before_send" : req.when,
    };
  }

  if (req.when === "before_send") {
    if (/sync_to_team|team_sync|team_update/i.test(lowerKey) && !isRecipientInputKey(lowerKey)) {
      return {
        ...req,
        key: "sprint_notes",
        surface: "input.markdown",
        when: "run_start",
        label: req.label ?? "Team sync notes",
      };
    }

    if (isRecipientInputKey(lowerKey) || lowerKey === "recipients" || lowerKey === "audience_id") {
      if (context.recipientKind === "configured") {
        return {
          ...req,
          key: "audience_id",
          surface: "input.audience_id",
          when: "before_send",
          label: req.label ?? "Audience or list ID",
        };
      }
      if (context.recipientKind === "uploaded" || context.recipientKind === "operator_input") {
        return {
          ...req,
          key: "recipients",
          surface: "input.contacts_csv",
          when: "before_send",
          label: req.label ?? "Recipients",
        };
      }
    }
  }

  return req;
}

export function dedupeInputRequirements(requirements: InputRequirement[]): InputRequirement[] {
  const byKey = new Map<string, InputRequirement>();
  for (const req of requirements) {
    byKey.set(req.key, req);
  }
  return [...byKey.values()];
}

export function canonicalizeInputRequirementsList(
  requirements: InputRequirement[],
  context: InputRequirementContext,
): InputRequirement[] {
  return dedupeInputRequirements(
    requirements.map((req) => canonicalizeInputRequirement(req, context)),
  );
}

/** Stable slot for comparing spec vs design requirements after key aliasing. */
export function requirementSlotKey(req: InputRequirement): string {
  if (req.surface === "confirm.send" || isConfirmInputKey(req.key)) return "slot:confirm_send";
  if (req.surface === "input.audience_id" || req.key === "audience_id") return "slot:audience_id";
  if (req.surface === "input.contacts_csv" || (isRecipientInputKey(req.key) && req.when === "before_send")) {
    return "slot:recipients";
  }
  if (req.surface === "review.email") return "slot:review_email";
  if (req.surface === "review.preview") return "slot:review_preview";
  if (req.surface === "review.draft") return "slot:review_draft";
  return `slot:${req.when}:${req.key}:${req.surface}`;
}

export function requirementMatchesSpec(designReq: InputRequirement, specReq: InputRequirement): boolean {
  if (designReq.key === specReq.key) return true;
  return requirementSlotKey(designReq) === requirementSlotKey(specReq);
}

/** Infer structured requirements from legacy inputsRequired string keys. */
export function requirementsFromLegacyKeys(keys: string[]): InputRequirement[] {
  return keys.map((key) => ({
    key,
    surface: defaultSurfaceForKey(key),
    label: defaultLabelForKey(key),
    required: true,
    when: isDeliveryConfigInputKey(key) ? "before_send" as const : "run_start" as const,
  }));
}

/** True when the approved spec explicitly requires operator-pasted content before agents run. */
export function specRequiresRunStartContent(spec: {
  delivery?: { target?: string };
  inputRequirements?: InputRequirement[];
}): boolean {
  const target = spec.delivery?.target ?? "none";
  // Newsletters/subscriber sends gather content via research — never operator paste at run_start.
  if (target === "subscriber_list") return false;
  if (target === "team_email") return true;
  return (spec.inputRequirements ?? []).some((req) => req.when === "run_start" && req.required);
}

/** Drop run_start paste requirements that do not apply to self-sourcing delivery targets. */
export function sanitizeInputRequirementsForDelivery(
  requirements: InputRequirement[],
  deliveryTarget: string,
): InputRequirement[] {
  if (deliveryTarget === "subscriber_list") {
    return requirements.filter((req) => req.when !== "run_start");
  }
  return requirements;
}

/** Merge explicit requirements with legacy keys without duplicating keys. */
export function normalizeInputRequirements(input: {
  inputRequirements?: InputRequirement[];
  inputsRequired?: string[];
}): InputRequirement[] {
  const explicit = input.inputRequirements ?? [];
  const explicitKeys = new Set(explicit.map((req) => req.key));
  const legacy = requirementsFromLegacyKeys(
    (input.inputsRequired ?? []).filter((key) => !explicitKeys.has(key)),
  );
  return [...explicit, ...legacy];
}
