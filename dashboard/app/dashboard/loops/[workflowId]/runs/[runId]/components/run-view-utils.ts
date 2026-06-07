export const LOOP_ENGINE_V3 = "loop_engine_v3";

export type WorkflowDefinition = {
  goal?: string;
  presetId?: string;
  deliveryType?: string;
  engineVersion?: string;
  builderMeta?: { engineVersion?: string };
  delivery?: { provider?: string; target?: string };
  allowedToolRefs?: string[];
  allowedIntegrations?: string[];
  schedule?: { timezone?: string };
  ceo?: { name: string; task: string; policy: string };
};

export type LoopRunGateView = {
  id: string;
  stageId: string;
  kind: string;
  status: string;
  title: string;
  artifactId: string | null;
  payload: unknown;
};

export type TaskLike = {
  agentId: string;
  agentName: string;
  toolKey: string;
  status: string;
  assignedTools?: Array<{ ref: string }>;
  inputJson?: unknown;
  outputJson?: unknown;
  latestComment?: { body: string } | null;
};

export const CHANNEL_LABELS: Record<string, string> = {
  primary: "Primary channel",
  email: "Email",
  gmail: "Gmail",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

export function isEngineV3Workflow(definition: WorkflowDefinition | null | undefined): boolean {
  if (!definition) return false;
  return definition.engineVersion === LOOP_ENGINE_V3
    || definition.builderMeta?.engineVersion === LOOP_ENGINE_V3;
}

export function readRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function stripMarkdown(v: string): string {
  return v
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/#{1,6}\s*/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function readEngineGateType(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const gateType = (payload as { gateType?: string }).gateType;
  return typeof gateType === "string" ? gateType : null;
}

export function pendingEngineGate(gates: LoopRunGateView[]): LoopRunGateView | null {
  return gates.find((gate) => gate.status === "pending" && readEngineGateType(gate.payload)) ?? null;
}

export function pendingLegacyApprovalGate(gates: LoopRunGateView[]): LoopRunGateView | null {
  return gates.find(
    (gate) => gate.kind === "approval" && gate.status === "pending" && !readEngineGateType(gate.payload),
  ) ?? null;
}

export function engineGateHeadline(gateType: string | null): string {
  if (gateType === "memory_confirmation") return "Confirm memories";
  if (gateType === "missing_input") return "Required input";
  if (gateType === "draft_review") return "Review draft";
  if (gateType === "pre_send") return "Confirm send";
  return "Approval gate";
}

export function looksLikeMissingInputPrompt(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  return /\b(please (provide|paste|send|share)|is missing|not provided|can't generate|cannot generate)\b/i.test(text)
    && /\b(sprint|notes|input|details|content|required|sprint_notes)\b/i.test(text);
}

export function engineGateStatusLabel(gateType: string | null): string {
  if (gateType === "memory_confirmation") return "confirm memories";
  if (gateType === "missing_input") return "awaiting input";
  if (gateType === "draft_review") return "review draft";
  if (gateType === "pre_send") return "confirm send";
  return "waiting for gate";
}

export function gateApprovalChannels(gate: LoopRunGateView | null): string[] {
  if (!gate?.payload || typeof gate.payload !== "object" || Array.isArray(gate.payload)) return ["primary"];
  const stage = (gate.payload as { stage?: { approvalPolicy?: { channels?: string[] } } }).stage;
  const channels = stage?.approvalPolicy?.channels;
  return Array.isArray(channels) && channels.length > 0 ? channels : ["primary"];
}

export function taskToolKey(task: TaskLike): string {
  const refs = (task.assignedTools ?? []).map((tool) => tool.ref).join(" ");
  return `${task.agentId} ${task.agentName} ${task.toolKey} ${refs}`.toLowerCase();
}

export function isWriterTask(task: TaskLike): boolean {
  const key = taskToolKey(task);
  return (
    key.includes("writer")
    || key.includes("creative writer")
    || (key.includes("write") && !key.includes("research") && !key.includes("search") && !key.includes("validator"))
    || (key.includes("draft") && !key.includes("review"))
  );
}

/** Primary draft artifact owner — not every llm_only agent. */
export function isDraftArtifactTask(task: TaskLike): boolean {
  const name = `${task.agentName} ${task.agentId}`.toLowerCase();
  if (name.includes("draft writer") || name.includes("writer")) return true;
  return isWriterTask(task) && !name.includes("validator") && !name.includes("approval");
}

export function isApprovalTask(task: TaskLike): boolean {
  if (isBroadcastDeliveryTask(task) || isEmailBuildTask(task)) return false;
  const key = taskToolKey(task);
  return key.includes("email_approval_request") || key.includes("approval");
}

export function isBroadcastDeliveryTask(task: TaskLike): boolean {
  const key = taskToolKey(task);
  return key.includes("resend_broadcast") || (key.includes("broadcast") && key.includes("delivery"));
}

export function isEmailBuildTask(task: TaskLike): boolean {
  const key = taskToolKey(task);
  return (key.includes("email_builder_compose") || key.includes("email_builder_render"))
    && !key.includes("email_approval_request");
}

export function getTaskOutput(task: Pick<TaskLike, "status" | "outputJson" | "latestComment">): string {
  const out = readRecord(task.outputJson);
  const candidates = [out.text, out.message, out.summary, out.draft, out.artifactBody];
  if (task.status !== "todo" || candidates.some((value) => typeof value === "string" && value.trim())) {
    candidates.push(task.latestComment?.body);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

export function isNewsletterPresetWorkflow(definition: WorkflowDefinition | null | undefined): boolean {
  if (!definition) return false;
  return definition.presetId === "newsletter"
    || definition.deliveryType === "newsletter"
    || /\bnewsletter\b/i.test(definition.goal ?? "")
    || Boolean(definition.allowedToolRefs?.includes("internal.resend_broadcast"));
}

export function isNewsletterDeliveryWorkflow(definition: WorkflowDefinition | null | undefined): boolean {
  if (!definition) return false;
  return definition.presetId === "newsletter"
    || definition.deliveryType === "newsletter"
    || Boolean(definition.allowedToolRefs?.includes("internal.resend_broadcast"));
}

export function contentPanelLabel(input: {
  definition: WorkflowDefinition | null | undefined;
  engineGateType: string | null;
  waitingForStrategy: boolean;
  predefinedNewsletter: boolean;
}): string {
  if (input.engineGateType === "missing_input") return "Required input";
  if (input.engineGateType === "draft_review") return "Draft review";
  if (input.waitingForStrategy && !input.predefinedNewsletter) return "Strategy";
  if (isNewsletterDeliveryWorkflow(input.definition)) return "Newsletter";
  const provider = input.definition?.delivery?.provider;
  if (provider === "internal.resend_broadcast") return "Broadcast";
  if (provider === "composio.gmail") return "Email";
  const goal = input.definition?.goal?.trim();
  if (goal) {
    const short = goal.length > 28 ? `${goal.slice(0, 28)}…` : goal;
    return short;
  }
  return "Run output";
}

export function readGateDraft(payload: unknown): string | null {
  const data = readRecord(payload);
  return typeof data.draft === "string" && data.draft.trim() ? data.draft.trim() : null;
}
