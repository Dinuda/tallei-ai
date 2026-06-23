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

export const dataInputSurfaceSchema = z.enum([
  "input.text",
  "input.markdown",
  "input.contacts_csv",
  "input.audience_id",
  "input.file",
]);

export type DataInputSurface = z.infer<typeof dataInputSurfaceSchema>;

export const reviewSurfaceSchema = z.enum([
  "review.draft",
  "review.email",
  "review.preview",
  "review.sources",
  "review.memories",
  "confirm.send",
]);

export type ReviewSurface = z.infer<typeof reviewSurfaceSchema>;

type InputValueType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export function inputSurfaceAcceptsValueType(surface: InputSurface, valueType: InputValueType): boolean {
  if (surface === "input.contacts_csv") return valueType === "array";
  if (surface === "input.file" || surface === "input.audience_id") return valueType === "string";
  if (surface === "input.text" || surface === "input.markdown") return valueType === "string";
  return false;
}

const INPUT_SURFACE_VALUES = inputSurfaceSchema.options;

/** Parse an explicitly declared input surface without semantic guessing. */
export function normalizeInputSurface(value: unknown, _key = ""): InputSurface {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if ((INPUT_SURFACE_VALUES as readonly string[]).includes(trimmed)) {
      return trimmed as InputSurface;
    }
  }
  throw new Error(`Unknown input surface: ${String(value)}`);
}

function normalizeInputRequirementWhen(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().toLowerCase();
  return trimmed;
}

function preprocessInputRequirement(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const key = typeof row.key === "string" ? row.key.trim() : "";
  return {
    ...row,
    key,
    surface: typeof row.surface === "string" ? row.surface.trim().toLowerCase() : row.surface,
    when: normalizeInputRequirementWhen(row.when),
  };
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

export type InputRequirementContext = {
  recipientKind: string;
  deliveryTarget: string;
};

function extractInputRequirementContext(root: Record<string, unknown>): InputRequirementContext {
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
    deliveryTarget: typeof delivery.provider === "string"
      ? delivery.provider
      : typeof delivery.target === "string"
        ? delivery.target
        : "none",
  };
}

export function normalizeSpecInputRequirements(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.inputRequirements)) return value;
  return {
    ...root,
    inputRequirements: root.inputRequirements.map(preprocessInputRequirement),
  };
}

const surfaceSubmissionValueSchema = z.object({
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

export function defaultLabelForKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function isReviewInputSurface(surface: InputSurface): boolean {
  return surface === "review.draft"
    || surface === "review.email"
    || surface === "review.preview"
    || surface === "review.sources"
    || surface === "review.memories"
    || surface === "confirm.send";
}

function isApprovalSurface(surface: InputSurface): boolean {
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

function isConfirmInputKey(key: string): boolean {
  return key.trim().toLowerCase() === "confirm_send";
}

function canonicalizeInputRequirement(
  req: InputRequirement,
  _context: { recipientKind: string; deliveryTarget: string },
): InputRequirement {
  return req;
}

function dedupeInputRequirements(requirements: InputRequirement[]): InputRequirement[] {
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
function requirementSlotKey(req: InputRequirement): string {
  if (req.surface === "confirm.send" || isConfirmInputKey(req.key)) return "slot:confirm_send";
  if (req.surface === "review.email") return "slot:review_email";
  if (req.surface === "review.preview") return "slot:review_preview";
  if (req.surface === "review.draft") return "slot:review_draft";
  return `slot:${req.when}:${req.key}:${req.surface}`;
}

function requirementMatchesSpec(designReq: InputRequirement, specReq: InputRequirement): boolean {
  if (designReq.key === specReq.key) return true;
  return requirementSlotKey(designReq) === requirementSlotKey(specReq);
}

/** True when the approved spec explicitly requires operator-pasted content before agents run. */
export function specRequiresRunStartContent(spec: {
  delivery?: { provider?: string; target?: string };
  inputRequirements?: InputRequirement[];
}): boolean {
  return (spec.inputRequirements ?? []).some((req) => req.when === "run_start" && req.required);
}
