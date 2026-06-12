import type { InputSurface } from "../loop-engine/input-surfaces.js";
import {
  defaultLabelForKey,
  defaultSurfaceForGateType,
  isApprovalSurface,
  isInputSurface,
} from "../loop-engine/input-surfaces.js";
import { validateSurfaceValue } from "./input-satisfaction.js";
import { readOperatorCheckpoint, type OperatorCheckpointSurface } from "./operator-checkpoint.js";

export type OperatorAction = "submit" | "approve" | "revise" | "reject";

export type OperatorBlock = {
  id: string;
  surface: InputSurface;
  required: boolean;
  satisfied: boolean;
  label?: string;
  description?: string;
  props?: Record<string, unknown>;
  data?: unknown;
};

export type OperatorView = {
  gateId: string | null;
  workspace: {
    title: string;
    subtitle: string;
    stamp: { tag: string; name: string };
  };
  blocks: OperatorBlock[];
  actions: OperatorAction[];
  meta?: {
    nextAgentName?: string;
    renderTarget?: string;
    canvasArtifactKey?: string;
    agentOutput?: string;
  };
};

type GateRow = {
  id: string;
  gate_type: string;
  status: string;
  question?: string;
  payload_json?: Record<string, unknown>;
};

type ProjectOperatorViewInput = {
  status: string;
  errorMessage?: string;
  context?: Record<string, unknown>;
  gates?: GateRow[];
  steps?: Array<{ status: string; step_index: number; agent_snapshot?: { name?: string; id?: string } }>;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readCheckpointSurfaces(gatePayload?: Record<string, unknown>): OperatorCheckpointSurface[] {
  if (!gatePayload) return [];
  const checkpoint = readOperatorCheckpoint(gatePayload);
  if (checkpoint?.surfaces.length) return checkpoint.surfaces;
  const rawSurfaces = Array.isArray(gatePayload.surfaces) ? gatePayload.surfaces : [];
  return rawSurfaces.filter((item): item is OperatorCheckpointSurface =>
    Boolean(item)
    && typeof item === "object"
    && typeof (item as OperatorCheckpointSurface).key === "string"
    && typeof (item as OperatorCheckpointSurface).surface === "string",
  );
}

function sourceItemsFromPayload(gatePayload: Record<string, unknown>): unknown[] {
  if (Array.isArray(gatePayload.items) && gatePayload.items.some((item) => {
    const row = asObject(item);
    return typeof row.title === "string" && typeof row.url === "string";
  })) {
    return gatePayload.items;
  }
  const result = asObject(gatePayload.result);
  const data = asObject(result.data);
  const sources = Array.isArray(data.sources) ? data.sources : [];
  return sources.filter((item) => {
    const row = asObject(item);
    return typeof row.title === "string" && typeof row.url === "string";
  });
}

function readContextInputValue(surface: OperatorCheckpointSurface, context?: Record<string, unknown>): unknown {
  const inputs = context?.inputs && typeof context.inputs === "object" && !Array.isArray(context.inputs)
    ? context.inputs as Record<string, unknown>
    : {};
  if (surface.surface === "input.contacts_csv" || surface.surface === "input.audience_id") return inputs[surface.key];
  if (surface.surface === "input.file") {
    const deliveryRecipients = context?.deliveryRecipients;
    const documentRef = deliveryRecipients && typeof deliveryRecipients === "object" && !Array.isArray(deliveryRecipients)
      ? (deliveryRecipients as Record<string, unknown>).documentRef
      : undefined;
    return inputs[surface.key] ?? documentRef;
  }
  return inputs[surface.key];
}

function refreshSurfaceSatisfactionFromContext(
  surface: OperatorCheckpointSurface,
  context?: Record<string, unknown>,
): OperatorCheckpointSurface {
  if (surface.satisfied || !isInputSurface(surface.surface)) return surface;
  const value = readContextInputValue(surface, context);
  if (value === undefined || value === null || value === "") return surface;
  const validation = validateSurfaceValue(surface.surface, value, { key: surface.key, required: surface.required });
  return validation.ok ? { ...surface, satisfied: true } : surface;
}

function surfaceStamp(surface: InputSurface): { tag: string; name: string } {
  if (surface === "review.memories") return { tag: "Approval", name: "Memory" };
  if (surface === "review.sources") return { tag: "Approval", name: "Sources" };
  if (surface === "review.draft") return { tag: "Approval", name: "Draft" };
  if (surface === "review.email") return { tag: "Approval", name: "Email" };
  if (surface === "review.preview") return { tag: "Approval", name: "Preview" };
  if (surface === "confirm.send") return { tag: "Approval", name: "Send" };
  if (surface === "input.contacts_csv" || surface === "input.audience_id") return { tag: "Input", name: "Recipients" };
  if (isInputSurface(surface)) return { tag: "Input", name: "Required" };
  return { tag: "Review", name: "Continue" };
}

function surfaceTitle(surface: InputSurface, label?: string): string {
  if (label) return label;
  if (surface === "review.memories") return "Select memories";
  if (surface === "review.sources") return "Select sources";
  if (surface === "review.draft") return "Review the draft";
  if (surface === "review.email") return "Review the email";
  if (surface === "review.preview") return "Review the final preview";
  if (surface === "confirm.send") return "Approve to send";
  if (surface === "input.contacts_csv" || surface === "input.audience_id") return "Add recipients";
  if (isInputSurface(surface)) return "Input required";
  return "Review and continue";
}

function surfaceSubtitle(surface: InputSurface, gateQuestion?: string): string {
  if (surface === "review.memories") return "Choose what the next agent can use.";
  if (surface === "review.sources") return "Pick search results, add custom sources, then approve or revise to re-search.";
  if (surface === "review.draft") return "Edit in the canvas, then save & approve or revise to re-run the writer.";
  if (surface === "review.email") return "Review the email draft, then save & approve or request changes.";
  if (surface === "review.preview") return "Review the rendered final preview, then approve or request changes.";
  if (surface === "confirm.send") return "Review the final draft and recipients, then approve send.";
  if (surface === "input.contacts_csv" || surface === "input.audience_id") return "Upload or paste recipients, save contacts, then continue.";
  if (isInputSurface(surface)) return gateQuestion?.trim() || "Paste the missing input below, then submit to continue the run.";
  return gateQuestion?.trim() || "Review and decide how to continue.";
}

function actionsForSurfaces(surfaces: InputSurface[]): OperatorAction[] {
  const hasInput = surfaces.some((surface) => isInputSurface(surface));
  const hasApproval = surfaces.some((surface) => isApprovalSurface(surface));
  if (hasInput && !hasApproval) return ["submit"];
  if (hasApproval) return ["reject", "revise", "approve"];
  return ["submit"];
}

function blockFromSurface(
  surface: OperatorCheckpointSurface,
  gatePayload: Record<string, unknown>,
): OperatorBlock {
  let data: unknown;
  if (surface.surface === "review.sources" || surface.surface === "review.memories") {
    data = { items: gatePayload.items ?? [] };
  }
  if (surface.surface === "review.draft" || surface.surface === "review.email" || surface.surface === "review.preview" || surface.surface === "confirm.send") {
    const result = asObject(gatePayload.result);
    data = {
      agentOutput: typeof result.text === "string" ? result.text : "",
      items: gatePayload.items,
    };
  }
  return {
    id: surface.key,
    surface: surface.surface,
    required: surface.required,
    satisfied: surface.satisfied,
    label: surface.label ?? defaultLabelForKey(surface.key),
    description: surface.description,
    props: {
      ...surface.props,
      ...(gatePayload.renderTarget ? { renderTarget: gatePayload.renderTarget } : {}),
      ...(gatePayload.canvasArtifactKey ? { canvasArtifactKey: gatePayload.canvasArtifactKey } : {}),
    },
    ...(data !== undefined ? { data } : {}),
  };
}

function synthesizeBlocksFromGate(gate: GateRow): OperatorBlock[] {
  const payload = asObject(gate.payload_json);
  const inferredSourceItems = sourceItemsFromPayload(payload);
  const surface = gate.gate_type === "draft_review" && inferredSourceItems.length > 0
    ? "review.sources"
    : defaultSurfaceForGateType(gate.gate_type);
  const block: OperatorBlock = {
    id: surface === "review.sources" ? "approved_sources"
      : surface === "review.memories" ? "approved_memories"
        : surface === "confirm.send" ? "confirm_send"
          : surface === "input.contacts_csv" || surface === "input.audience_id" ? "recipients"
            : "required_input",
    surface: gate.gate_type === "draft_review" && payload.renderTarget === "canvas.email"
        ? "review.email"
        : surface,
    required: true,
    satisfied: false,
    label: surfaceTitle(surface),
    description: gate.question,
    props: {
      ...(payload.renderTarget ? { renderTarget: payload.renderTarget } : {}),
      ...(payload.canvasArtifactKey ? { canvasArtifactKey: payload.canvasArtifactKey } : {}),
      ...(payload.contactSource ? { contactSource: payload.contactSource } : {}),
    },
  };
  if (block.surface === "review.sources" || block.surface === "review.memories") {
    block.data = { items: block.surface === "review.sources" ? inferredSourceItems : payload.items ?? [] };
  }
  if (block.surface === "review.draft" || block.surface === "review.email" || block.surface === "review.preview" || block.surface === "confirm.send") {
    const result = asObject(payload.result);
    block.data = { agentOutput: typeof result.text === "string" ? result.text : "" };
  }
  return [block];
}

function resolveNextAgentName(input: ProjectOperatorViewInput, gateStepIndex?: number): string | undefined {
  if (typeof gateStepIndex !== "number" || !input.steps?.length) return undefined;
  const next = input.steps.find((step) => step.step_index === gateStepIndex + 1);
  return next?.agent_snapshot?.name ?? next?.agent_snapshot?.id;
}

export function projectOperatorView(input: ProjectOperatorViewInput): OperatorView {
  const pendingGate = input.gates?.find((gate) => gate.status === "pending") ?? null;
  const idleView: OperatorView = {
    gateId: null,
    workspace: {
      title: "Agent outputs",
      subtitle: "Review artifacts produced by this run.",
      stamp: { tag: "Output", name: "Artifacts" },
    },
    blocks: [],
    actions: [],
  };

  if (!pendingGate) return idleView;

  const payload = asObject(pendingGate.payload_json);
  const checkpointSurfaces = readCheckpointSurfaces(payload)
    .map((surface) => refreshSurfaceSatisfactionFromContext(surface, input.context));
  const pendingSurfaces = checkpointSurfaces.filter((surface) => surface.required && !surface.satisfied);

  let blocks: OperatorBlock[];
  if (pendingSurfaces.length > 0) {
    blocks = pendingSurfaces.map((surface) => blockFromSurface(surface, payload));
  } else if (checkpointSurfaces.length > 0) {
    blocks = checkpointSurfaces.map((surface) => blockFromSurface(surface, payload));
  } else {
    blocks = synthesizeBlocksFromGate(pendingGate);
  }
  const inferredSourceItems = sourceItemsFromPayload(payload);
  if (
    inferredSourceItems.length > 0
    && blocks.length === 1
    && blocks[0]?.surface === "review.draft"
    && !payload.renderTarget
  ) {
    blocks = [{
      ...blocks[0],
      id: "approved_sources",
      surface: "review.sources",
      label: "Select sources",
      data: { items: inferredSourceItems },
    }];
  }

  const primarySurface = blocks[0]?.surface ?? defaultSurfaceForGateType(pendingGate.gate_type);
  const connectorSetup = blocks[0]?.props?.connectorSetup;
  const connectorRow = connectorSetup && typeof connectorSetup === "object" && !Array.isArray(connectorSetup)
    ? connectorSetup as Record<string, unknown>
    : null;
  const connectorToolkit = typeof connectorRow?.toolkit === "string" ? connectorRow.toolkit : null;
  const stamp = connectorToolkit ? { tag: "Setup", name: "Connector" } : surfaceStamp(primarySurface);
  const title = connectorToolkit ? `Connect ${connectorToolkit}` : surfaceTitle(primarySurface, blocks[0]?.label);
  const subtitle = connectorToolkit
    ? `Connect and verify ${connectorToolkit}, then continue the paused connector action.`
    : surfaceSubtitle(primarySurface, pendingGate.question ?? blocks[0]?.description);
  const gateStepIndex = typeof payload.stepIndex === "number" ? payload.stepIndex : undefined;

  return {
    gateId: pendingGate.id,
    workspace: { title, subtitle, stamp },
    blocks,
    actions: actionsForSurfaces(blocks.map((block) => block.surface)),
    meta: {
      nextAgentName: resolveNextAgentName(input, gateStepIndex),
      renderTarget: typeof payload.renderTarget === "string" ? payload.renderTarget : undefined,
      canvasArtifactKey: typeof payload.canvasArtifactKey === "string" ? payload.canvasArtifactKey : undefined,
      agentOutput: (() => {
        const result = asObject(payload.result);
        return typeof result.text === "string" ? result.text : undefined;
      })(),
    },
  };
}
