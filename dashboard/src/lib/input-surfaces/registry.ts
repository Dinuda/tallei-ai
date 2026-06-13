export type InputSurface =
  | "input.text"
  | "input.markdown"
  | "input.contacts_csv"
  | "input.audience_id"
  | "input.file"
  | "review.draft"
  | "review.email"
  | "review.preview"
  | "review.sources"
  | "review.memories"
  | "confirm.send";

export type CheckpointSurface = {
  key: string;
  surface: InputSurface;
  required: boolean;
  satisfied: boolean;
  label?: string;
  description?: string;
  props?: Record<string, unknown>;
};

export function readCheckpointSurfaces(gatePayload?: Record<string, unknown> | null): CheckpointSurface[] {
  if (!gatePayload || typeof gatePayload !== "object") return [];
  const rawSurfaces = Array.isArray(gatePayload.surfaces)
    ? gatePayload.surfaces
    : gatePayload.checkpoint && typeof gatePayload.checkpoint === "object" && !Array.isArray(gatePayload.checkpoint)
      && Array.isArray((gatePayload.checkpoint as Record<string, unknown>).surfaces)
      ? (gatePayload.checkpoint as Record<string, unknown>).surfaces as unknown[]
      : [];
  return rawSurfaces.filter((item): item is CheckpointSurface =>
    Boolean(item)
    && typeof item === "object"
    && typeof (item as CheckpointSurface).key === "string"
    && typeof (item as CheckpointSurface).surface === "string",
  );
}

export function pendingCheckpointSurfaces(gatePayload?: Record<string, unknown> | null): CheckpointSurface[] {
  return readCheckpointSurfaces(gatePayload).filter((surface) => surface.required && !surface.satisfied);
}

export function primaryInputSurface(gatePayload?: Record<string, unknown> | null): CheckpointSurface | null {
  const pending = pendingCheckpointSurfaces(gatePayload);
  return pending.find((surface) =>
    surface.surface === "input.text"
    || surface.surface === "input.markdown"
    || surface.surface === "input.file",
  ) ?? pending[0] ?? null;
}

export function surfaceUsesTextInput(surface: InputSurface): boolean {
  return surface === "input.text" || surface === "input.markdown" || surface === "input.file";
}

export function surfaceUsesContactsInput(surface: InputSurface): boolean {
  return surface === "input.contacts_csv" || surface === "input.audience_id";
}

type CollectInputItem = {
  requiredValueKey: string;
  surface: InputSurface;
  label?: string;
  description?: string;
  required?: boolean;
  satisfied?: boolean;
};

function readCollectInputItems(gatePayload?: Record<string, unknown> | null): CollectInputItem[] {
  const operatorInteraction = gatePayload?.operatorInteraction;
  if (!operatorInteraction || typeof operatorInteraction !== "object" || Array.isArray(operatorInteraction)) return [];
  const items = (operatorInteraction as { items?: unknown[] }).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const requiredValueKey = typeof row.requiredValueKey === "string" ? row.requiredValueKey.trim() : "";
    const surface = typeof row.surface === "string" ? row.surface.trim() : "";
    if (!requiredValueKey || !surface.startsWith("input.")) return [];
    return [{
      requiredValueKey,
      surface: surface as InputSurface,
      label: typeof row.label === "string" ? row.label : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
      required: row.required !== false,
      satisfied: row.satisfied === true,
    }];
  });
}

export function resolveContactsCheckpointSurface(input: {
  blocks?: Array<{
    id: string;
    surface?: string;
    label?: string;
    description?: string;
    required?: boolean;
    satisfied?: boolean;
  }>;
  gatePayload?: Record<string, unknown> | null;
}): CheckpointSurface | null {
  const fromBlock = input.blocks?.find((block) =>
    block.surface === "input.contacts_csv" || block.surface === "input.audience_id");
  if (fromBlock?.surface === "input.contacts_csv" || fromBlock?.surface === "input.audience_id") {
    return {
      key: fromBlock.id,
      surface: fromBlock.surface,
      required: fromBlock.required ?? true,
      satisfied: fromBlock.satisfied ?? false,
      label: fromBlock.label,
      description: fromBlock.description,
    };
  }
  const fromPayload = readCollectInputItems(input.gatePayload).find((item) =>
    item.surface === "input.contacts_csv" || item.surface === "input.audience_id");
  if (!fromPayload) return null;
  return {
    key: fromPayload.requiredValueKey,
    surface: fromPayload.surface,
    required: fromPayload.required ?? true,
    satisfied: fromPayload.satisfied ?? false,
    label: fromPayload.label,
    description: fromPayload.description,
  };
}

export function buildSurfaceSubmission(input: {
  surface: CheckpointSurface;
  text?: string;
  contacts?: Array<{ email: string; name?: string }>;
  audienceId?: string;
  csvText?: string;
}) {
  return {
    [input.surface.key]: {
      surface: input.surface.surface,
      ...(input.text ? { text: input.text } : {}),
      ...(input.contacts?.length ? { contacts: input.contacts } : {}),
      ...(input.audienceId ? { audienceId: input.audienceId } : {}),
      ...(input.csvText ? { csvText: input.csvText } : {}),
    },
  };
}

export function resolveSurfaceLabel(
  surface: CheckpointSurface | null,
  fallbackInputsRequired?: string[],
  gateQuestion?: string,
): string {
  if (surface?.label) return surface.label;
  if (surface?.key) return surface.key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  const key = fallbackInputsRequired?.[0];
  if (key) return key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  return gateQuestion?.trim() || "Required input";
}
