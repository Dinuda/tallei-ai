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

export type ContactSourceKind = "none" | "configured" | "uploaded" | "operator_input";

export function primaryPendingBlock(view: OperatorView | null | undefined): OperatorBlock | null {
  if (!view) return null;
  return view.blocks.find((block) => block.required && !block.satisfied) ?? view.blocks[0] ?? null;
}

export function viewHasInputSurface(view: OperatorView | null | undefined): boolean {
  return Boolean(view?.blocks.some((block) => block.surface.startsWith("input.") && block.required && !block.satisfied));
}

export function viewHasApprovalActions(view: OperatorView | null | undefined): boolean {
  return Boolean(view?.actions.includes("approve"));
}
