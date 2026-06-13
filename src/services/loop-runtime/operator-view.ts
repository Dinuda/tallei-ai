import type { InputSurface } from "../loop-engine/input-surfaces.js";
import {
  activeOperatorInteractionSchema,
  type ActiveOperatorInteraction,
  type OperatorAction,
  type OperatorInteractionKind,
} from "../loop-engine/operator-interactions.js";

export type OperatorBlock = {
  kind: OperatorInteractionKind;
  id: string;
  surface?: InputSurface;
  required: boolean;
  satisfied: boolean;
  label?: string;
  description?: string;
  data?: unknown;
  interaction: ActiveOperatorInteraction;
};

export type OperatorView = {
  interactionId: string | null;
  workspace: {
    title: string;
    subtitle: string;
    stamp: { tag: string; name: string };
  };
  blocks: OperatorBlock[];
  actions: OperatorAction[];
  meta?: {
    renderTarget?: string;
    canvasArtifactKey?: string;
    agentOutput?: string;
  };
};

type InteractionRow = {
  id: string;
  interaction_kind: OperatorInteractionKind;
  status: string;
  payload_json?: Record<string, unknown>;
};

type ProjectOperatorViewInput = {
  status: string;
  interactions?: InteractionRow[];
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function reviewSurfaceForPayload(
  payload: Record<string, unknown>,
  rendererRef: string | null,
): InputSurface {
  const gateType = typeof payload.gateType === "string" ? payload.gateType : "";
  if (gateType === "memory_confirmation") return "review.memories";
  if (gateType === "source_confirmation") return "review.sources";
  if (gateType === "pre_send") return "confirm.send";
  if (rendererRef === "canvas.email") return "review.email";
  if (rendererRef === "canvas.preview") return "review.preview";
  return "review.draft";
}

function projectActiveInteraction(
  interactionId: string,
  interaction: ActiveOperatorInteraction,
  payload: Record<string, unknown>,
): OperatorView {
  if (interaction.kind === "collect_input") {
    return {
      interactionId,
      workspace: {
        title: interaction.items.length === 1 ? interaction.items[0]!.label : "Provide required inputs",
        subtitle: interaction.items.length === 1 ? interaction.items[0]!.description : "Provide every required value to continue.",
        stamp: { tag: "Input", name: "Required" },
      },
      blocks: interaction.items.map((item) => ({
        kind: "collect_input",
        id: item.requiredValueKey,
        surface: item.surface,
        required: item.required,
        satisfied: item.satisfied,
        label: item.label,
        description: item.description,
        data: { valueType: item.valueType, validationError: item.validationError },
        interaction,
      })),
      actions: [{ id: "submit", command: "submit_input", label: "Submit inputs", enabled: true }],
    };
  }
  if (interaction.kind === "review_artifact") {
    const surface = reviewSurfaceForPayload(payload, interaction.rendererRef);
    const items = Array.isArray(payload.items) ? payload.items : [];
    return {
      interactionId,
      workspace: {
        title: surface === "review.memories"
          ? "Select memories"
          : surface === "review.sources"
            ? "Select sources"
            : surface === "confirm.send"
              ? "Confirm send"
              : "Review artifact",
        subtitle: surface === "review.memories"
          ? "Select which memories the next agent may use."
          : surface === "review.sources"
            ? "Select sources, add custom URLs, then approve or revise."
            : surface === "confirm.send"
              ? "Review the final draft, then approve send."
              : "Review the declared artifact before continuing.",
        stamp: {
          tag: surface === "review.memories" || surface === "review.sources" ? "Review" : "Approval",
          name: surface === "review.memories"
            ? "Memories"
            : surface === "review.sources"
              ? "Sources"
              : surface === "confirm.send"
                ? "Send"
                : "Artifact",
        },
      },
      blocks: [{
        kind: "review_artifact",
        id: interaction.artifactId,
        surface,
        required: true,
        satisfied: false,
        interaction,
        data: {
          agentOutput: interaction.outputText,
          ...(items.length > 0 ? { items } : {}),
        },
      }],
      actions: [
        { id: "reject", command: "reject", label: "Reject", enabled: true },
        { id: "revise", command: "revise", label: "Revise", enabled: interaction.editable },
        { id: "approve", command: "approve", label: "Approve", enabled: true },
      ],
      meta: {
        renderTarget: interaction.rendererRef ?? undefined,
        canvasArtifactKey: typeof payload.canvasArtifactKey === "string"
          ? payload.canvasArtifactKey
          : interaction.rendererRef && interaction.artifactId
            ? `${interaction.artifactId}:${interaction.rendererRef}`
            : undefined,
        agentOutput: interaction.outputText,
      },
    };
  }
  if (interaction.kind === "confirm_action") {
    return {
      interactionId,
      workspace: {
        title: "Confirm external action",
        subtitle: "Review the validated payload and approve the declared external effect.",
        stamp: { tag: "Approval", name: "Action" },
      },
      blocks: [{
        kind: "confirm_action",
        id: interaction.actionNodeId,
        required: true,
        satisfied: false,
        interaction,
        data: {
          contractRef: interaction.contractRef,
          effect: interaction.effect,
          payload: interaction.sanitizedPayload,
          payloadHash: interaction.payloadHash,
          validation: interaction.validation,
        },
      }],
      actions: [
        { id: "reject", command: "reject", label: "Reject", enabled: true },
        {
          id: "approve",
          command: "approve",
          label: "Approve action",
          enabled: interaction.validation.valid,
          ...(interaction.validation.valid ? {} : { disabledReason: "Payload validation failed." }),
        },
      ],
    };
  }
  return {
    interactionId,
    workspace: {
      title: `Connect ${interaction.toolkit}`,
      subtitle: `Connect and verify ${interaction.toolkit}, then continue the paused connector action.`,
      stamp: { tag: "Setup", name: "Connector" },
    },
    blocks: [{
      kind: "connect_connector",
      id: interaction.actionNodeId,
      required: true,
      satisfied: interaction.connected,
      interaction,
      data: { toolkit: interaction.toolkit, actionSlug: interaction.actionSlug, contractRef: interaction.contractRef },
    }],
    actions: [{
      id: "verify_connection",
      command: "verify_connection",
      label: "Verify & Continue",
      enabled: true,
    }],
  };
}

export function projectOperatorView(input: ProjectOperatorViewInput): OperatorView {
  const pending = input.interactions?.find((interaction) => interaction.status === "pending") ?? null;
  if (!pending) {
    return {
      interactionId: null,
      workspace: {
        title: "Agent outputs",
        subtitle: "Review artifacts produced by this run.",
        stamp: { tag: "Output", name: "Artifacts" },
      },
      blocks: [],
      actions: [],
    };
  }
  const payload = asObject(pending.payload_json);
  const parsed = activeOperatorInteractionSchema.safeParse(payload.operatorInteraction);
  if (!parsed.success) {
    throw new Error(`Interaction ${pending.id} is missing valid typed operator state.`);
  }
  if (parsed.data.kind !== pending.interaction_kind) {
    throw new Error(`Interaction ${pending.id} kind does not match persisted typed state.`);
  }
  return projectActiveInteraction(pending.id, parsed.data, payload);
}
