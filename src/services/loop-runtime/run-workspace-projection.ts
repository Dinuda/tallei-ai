export type WorkspaceBlockType = "contacts_upload" | "draft_review" | "artifact_output";

export type WorkspaceBlock = {
  type: WorkspaceBlockType;
  required?: boolean;
};

export type ContactSourceKind = "none" | "configured" | "uploaded" | "operator_input";

export type RunWorkspaceInput = {
  status: string;
  errorMessage?: string;
  pendingGate?: {
    gate_type: string;
    status: string;
    payload_json?: Record<string, unknown>;
  } | null;
  gateUiMode?: string | null;
  context?: Record<string, unknown>;
};

const RECIPIENT_ERROR_PATTERN = /requires at least one recipient|requires audience_id|segment_id|list_id/i;

export function isMissingRecipientError(message?: string): boolean {
  return Boolean(message && RECIPIENT_ERROR_PATTERN.test(message));
}

export function readRecipientStatus(gatePayload?: Record<string, unknown>, context?: Record<string, unknown>): "missing" | "ready" {
  const payloadStatus = gatePayload?.recipientStatus;
  if (payloadStatus === "ready" || payloadStatus === "missing") return payloadStatus;
  const deliveryRecipients = context?.deliveryRecipients;
  if (deliveryRecipients && typeof deliveryRecipients === "object" && !Array.isArray(deliveryRecipients)) {
    const count = typeof (deliveryRecipients as Record<string, unknown>).recipientCount === "number"
      ? (deliveryRecipients as Record<string, unknown>).recipientCount as number
      : Array.isArray((deliveryRecipients as Record<string, unknown>).contacts)
        ? ((deliveryRecipients as Record<string, unknown>).contacts as unknown[]).length
        : 0;
    if (count > 0) return "ready";
    const audienceId = (deliveryRecipients as Record<string, unknown>).audienceId;
    if (typeof audienceId === "string" && audienceId.trim()) return "ready";
  }
  return "missing";
}

export function readContactSourceKind(gatePayload?: Record<string, unknown>): ContactSourceKind {
  const contactSource = gatePayload?.contactSource;
  if (contactSource && typeof contactSource === "object" && !Array.isArray(contactSource)) {
    const kind = (contactSource as Record<string, unknown>).kind;
    if (kind === "configured" || kind === "uploaded" || kind === "operator_input" || kind === "none") {
      return kind;
    }
  }
  return "uploaded";
}

function gatePayloadNeedsContacts(gatePayload?: Record<string, unknown>, recipientStatus?: "missing" | "ready"): boolean {
  const uiBlocks = gatePayload?.uiBlocks;
  if (Array.isArray(uiBlocks)) {
    return uiBlocks.some((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "contacts_upload");
  }
  return recipientStatus === "missing";
}

export function projectRunWorkspace(input: RunWorkspaceInput): WorkspaceBlock[] {
  const gatePayload = input.pendingGate?.payload_json;
  const recipientStatus = readRecipientStatus(gatePayload, input.context);
  const gateType = input.pendingGate?.gate_type ?? input.gateUiMode;

  if (gateType === "recipient_upload") {
    return [{ type: "contacts_upload", required: true }];
  }

  if (gateType === "pre_send") {
    if (gatePayloadNeedsContacts(gatePayload, recipientStatus)) {
      return [{ type: "contacts_upload", required: true }];
    }
    return [{ type: "draft_review" }];
  }

  if (
    input.status === "failed"
    && isMissingRecipientError(input.errorMessage)
  ) {
    return [{ type: "contacts_upload", required: true }];
  }

  if (input.pendingGate && input.gateUiMode === "draft_review") {
    return [{ type: "draft_review" }];
  }

  if (!input.pendingGate) {
    return [{ type: "artifact_output" }];
  }

  return [];
}

export function workspaceRequiresContacts(blocks: WorkspaceBlock[]): boolean {
  return blocks.some((block) => block.type === "contacts_upload" && block.required);
}
