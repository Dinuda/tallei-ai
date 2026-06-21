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

export type OperatorCommand = "submit_input" | "approve" | "revise" | "reject" | "verify_connection";

export type OperatorAction = {
  id: string;
  command: OperatorCommand;
  label: string;
  enabled: boolean;
  disabledReason?: string;
};

export type OperatorBlock = {
  kind: "collect_input" | "review_artifact" | "confirm_action" | "connect_connector";
  id: string;
  surface?: InputSurface;
  required: boolean;
  satisfied: boolean;
  label?: string;
  description?: string;
  props?: Record<string, unknown>;
  data?: unknown;
  interaction?: Record<string, unknown>;
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
    nextAgentName?: string;
    renderTarget?: string;
    canvasArtifactKey?: string;
    agentOutput?: string;
  };
};

export type ContactSourceKind = "none" | "configured" | "uploaded" | "operator_input";

export function primaryPendingBlock(view: OperatorView | null | undefined): OperatorBlock | null {
  if (!view) return null;
  return view.blocks.find((block) => block.required && !block.satisfied) ?? view.blocks[0] ?? null;
}

export function viewHasInputSurface(view: OperatorView | null | undefined): boolean {
  return Boolean(view?.blocks.some((block) => block.surface?.startsWith("input.") && block.required && !block.satisfied));
}

export function viewHasApprovalActions(view: OperatorView | null | undefined): boolean {
  return Boolean(view?.actions.some((action) => action.command === "approve"));
}

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  approve: "Continue",
  revise: "Send back for another pass",
  reject: "Stop this run",
};

/** Map backend operatorView.actions to interactive prompt options. */
export function buildGatePromptOptions(operatorView: OperatorView) {
  const actions = operatorView.actions.filter((action) =>
    action.enabled !== false
    && (action.command === "approve" || action.command === "revise" || action.command === "reject"));

  if (actions.length > 0) {
    return actions.map((action) => ({
      id: action.id,
      label: action.label,
      value: action.command === "approve"
        ? "approve"
        : action.command === "revise"
          ? "revise"
          : "reject",
      description: action.disabledReason ?? COMMAND_DESCRIPTIONS[action.command] ?? "",
    }));
  }

  return [
    { id: "approve", label: "Approve", value: "approve", description: COMMAND_DESCRIPTIONS.approve },
    { id: "revise", label: "Request changes", value: "revise", description: COMMAND_DESCRIPTIONS.revise },
    { id: "reject", label: "Reject run", value: "reject", description: COMMAND_DESCRIPTIONS.reject },
  ];
}
