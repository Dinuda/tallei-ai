import type { UIMessage } from "ai";

import type { OperatorView } from "@/lib/operator-view-types";

export type SpecRunStep = {
  id: string;
  step_index: number;
  attempt: number;
  agent_id: string;
  agent_snapshot: {
    name?: string;
    task?: string;
    persona?: {
      displayName: string;
      roleKey: string;
      roleLabel: string;
      avatarSeed: string;
      avatarUrl?: string;
    };
  };
  status: string;
  input_json?: Record<string, unknown>;
  output_json?: { text?: string; data?: Record<string, unknown> };
  error_json?: { message?: string };
};

export type SpecRunInteraction = {
  id: string;
  step_attempt_id: string;
  interaction_kind: string;
  status: string;
  question: string;
  payload_json?: Record<string, unknown>;
  decision_json?: Record<string, unknown>;
  created_at?: string;
  completed_at?: string | null;
};

function selectBestStepAttempt(attempts: SpecRunStep[]): SpecRunStep {
  const sorted = [...attempts].sort((left, right) => right.attempt - left.attempt);
  const preferred = sorted.find((step) =>
    step.status === "succeeded"
    || step.status === "waiting_for_interaction"
    || step.status === "running");
  if (preferred) return preferred;
  return sorted[0]!;
}

export function latestAttemptPerStep(steps: SpecRunStep[]): SpecRunStep[] {
  const byIndex = new Map<number, SpecRunStep[]>();
  for (const step of steps) {
    const group = byIndex.get(step.step_index) ?? [];
    group.push(step);
    byIndex.set(step.step_index, group);
  }
  return [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, attempts]) => selectBestStepAttempt(attempts));
}

const DISPLAY_STRING_FIELDS = [
  "text",
  "summary",
  "body",
  "rationale",
  "reasoning",
  "agentOutput",
  "message",
  "reply",
  "draft",
  "analysis",
  "findings",
  "conclusion",
  "notes",
  "recommendedTemplate",
  "customerHistory",
  "priorCustomerHistory",
] as const;

function isInternalPayload(data: Record<string, unknown>): boolean {
  if (data.approved === true && typeof data.interactionKind === "string") {
    const extraKeys = Object.keys(data).filter((key) => !["approved", "interactionKind", "ok", "value"].includes(key));
    return extraKeys.length === 0;
  }
  return data.ok === true && data.approved === true && !data.output && !data.text && !data.summary && !data.body;
}

function looksLikeJsonBlob(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  if (!looksLikeJsonBlob(text)) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readStringField(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  return typeof value === "string" ? value.trim() : "";
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function formatEmailDrafts(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const sections = value.map((draft, index) => {
    const record = draft && typeof draft === "object" && !Array.isArray(draft)
      ? draft as Record<string, unknown>
      : {};
    const subject = readStringField(record, "subject") || `Draft ${index + 1}`;
    const body = readStringField(record, "body")
      || readStringField(record, "text")
      || (typeof record.html === "string" ? stripHtml(record.html) : "");
    return body ? `**${subject}**\n\n${body}` : `**${subject}**`;
  }).filter(Boolean);
  return sections.join("\n\n---\n\n");
}

function formatStructuredData(data: Record<string, unknown>): string {
  const emailDrafts = formatEmailDrafts(data.emailDrafts);
  if (emailDrafts) return emailDrafts;

  for (const field of DISPLAY_STRING_FIELDS) {
    const value = readStringField(data, field);
    if (value) return value;
  }

  const priority = readStringField(data, "priority");
  const rationale = readStringField(data, "rationale");
  if (priority) {
    return rationale ? `**Priority: ${priority}**\n\n${rationale}` : `**Priority: ${priority}**`;
  }

  if (data.ok === true && data.output) return "Saved to your connector.";

  const nested = data.output;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedText = formatStructuredData(nested as Record<string, unknown>);
    if (nestedText) return nestedText;
  }

  if (isInternalPayload(data)) return "";

  const preview = { ...data };
  delete preview.ok;
  delete preview.approved;
  delete preview.interactionKind;
  delete preview.value;
  if (Object.keys(preview).length === 0) return "";

  try {
    const raw = JSON.stringify(preview, null, 2).trim();
    if (!raw || raw === "{}") return "";
    return raw.length > 2_400 ? `${raw.slice(0, 2_400)}\n[truncated]` : raw;
  } catch {
    return "";
  }
}

export function formatAgentStructuredOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (!output || typeof output !== "object" || Array.isArray(output)) return "";

  const record = output as Record<string, unknown>;
  const nestedText = typeof record.text === "string" ? record.text.trim() : "";
  const nestedData = record.data;
  if (nestedText || (nestedData && typeof nestedData === "object" && !Array.isArray(nestedData))) {
    const pseudoStep: SpecRunStep = {
      id: "handoff",
      step_index: 0,
      attempt: 1,
      agent_id: "handoff",
      agent_snapshot: {},
      status: "succeeded",
      output_json: {
        ...(nestedText ? { text: nestedText } : {}),
        ...(nestedData && typeof nestedData === "object" && !Array.isArray(nestedData)
          ? { data: nestedData as Record<string, unknown> }
          : {}),
      },
    };
    const formatted = formatStepOutput(pseudoStep);
    if (formatted) return formatted;
  }

  return formatStructuredData(record);
}

export function formatStepOutput(step: SpecRunStep): string {
  const text = step.output_json?.text?.trim();
  if (text) {
    const parsed = parseJsonRecord(text);
    if (parsed) {
      const formatted = formatStructuredData(parsed);
      if (formatted) return formatted;
    } else {
      return text;
    }
  }

  const data = step.output_json?.data;
  if (data && !isInternalPayload(data)) {
    const formatted = formatStructuredData(data);
    if (formatted) return formatted;
  }

  if (step.error_json?.message?.trim()) return step.error_json.message.trim();
  return "";
}

export function resolveStepInteractionRationale(
  stepId: string,
  interactions: SpecRunInteraction[],
): string {
  const related = interactions
    .filter((interaction) => interaction.step_attempt_id === stepId)
    .sort((left, right) => String(right.created_at ?? "")
      .localeCompare(String(left.created_at ?? "")));

  for (const interaction of related) {
    const payload = interaction.payload_json ?? {};
    const meta = payload.meta;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const agentOutput = readStringField(meta as Record<string, unknown>, "agentOutput");
      if (agentOutput) return agentOutput;
    }

    const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const blockData = (block as Record<string, unknown>).data;
      if (blockData && typeof blockData === "object" && !Array.isArray(blockData)) {
        const agentOutput = readStringField(blockData as Record<string, unknown>, "agentOutput");
        if (agentOutput) return agentOutput;
      }
    }

    const rationale = readStringField(payload, "rationale");
    if (rationale) return rationale;

  }

  return "";
}

export function resolvePriorAgentHandoff(step: SpecRunStep, steps: SpecRunStep[]): string {
  const laterSteps = steps
    .filter((entry) => entry.step_index > step.step_index)
    .sort((left, right) => left.step_index - right.step_index);

  for (const laterStep of laterSteps) {
    const priorOutputs = laterStep.input_json?.priorOutputs;
    if (!Array.isArray(priorOutputs)) continue;

    for (const entry of priorOutputs) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      const agentName = typeof record.agentName === "string" ? record.agentName : "";
      const matchesId = Boolean(agentId && agentId === step.agent_id);
      const matchesName = Boolean(
        agentName
        && step.agent_snapshot.name
        && agentName.toLowerCase() === step.agent_snapshot.name.toLowerCase(),
      );
      if (!matchesId && !matchesName) continue;
      const formatted = formatAgentStructuredOutput(record.output);
      if (formatted) return formatted;
    }
  }

  return "";
}

export function resolveStepDisplayText(
  step: SpecRunStep,
  interactions: SpecRunInteraction[] = [],
  context?: {
    steps?: SpecRunStep[];
    messages?: UIMessage[];
    resolveFinalizeAgent?: (step: SpecRunStep, messages: UIMessage[]) => string;
  },
): string {
  const output = formatStepOutput(step);
  if (output) return output;

  if (context?.messages?.length && context.resolveFinalizeAgent) {
    const fromFinalize = context.resolveFinalizeAgent(step, context.messages);
    if (fromFinalize) return fromFinalize;
  }

  if (context?.steps?.length) {
    const fromHandoff = resolvePriorAgentHandoff(step, context.steps);
    if (fromHandoff) return fromHandoff;
  }

  return resolveStepInteractionRationale(step.id, interactions);
}

export function formatInteractionDecision(interaction: SpecRunInteraction): string | null {
  if (interaction.status === "pending") return null;
  const gateType = typeof interaction.payload_json?.gateType === "string"
    ? interaction.payload_json.gateType
    : interaction.interaction_kind;
  const decision = interaction.decision_json ?? {};

  if (interaction.status === "approved") {
    if (gateType === "draft_review" || gateType === "review_artifact") return "Approved the draft";
    if (gateType === "pre_send") return "Approved send";
    return "Approved";
  }
  if (interaction.status === "submitted") {
    const input = decision.input && typeof decision.input === "object" && !Array.isArray(decision.input)
      ? decision.input as Record<string, unknown>
      : {};
    const text = typeof input.text === "string" ? input.text.trim() : "";
    return text || "Submitted input";
  }
  if (interaction.status === "rejected") {
    const reason = typeof decision.reason === "string" ? decision.reason.trim() : "";
    if (decision.command === "revise") return reason ? `Requested changes: ${reason}` : "Requested changes";
    return reason ? `Rejected: ${reason}` : "Rejected";
  }
  return null;
}

export function isRunPausedForGate(runStatus: string): boolean {
  return runStatus === "waiting_for_interaction" || runStatus === "waiting_for_approval";
}

export type SpecRunArtifact = {
  id: string;
  step_attempt_id?: string | null;
  artifact_key: string;
  kind: string;
  body: string;
  created_at?: string;
  data_json?: Record<string, unknown>;
  invalidated_at?: string | null;
};

function readArtifactEmailTemplate(dataJson: Record<string, unknown> | undefined) {
  const template = dataJson?.emailTemplate;
  if (!template || typeof template !== "object" || Array.isArray(template)) return null;
  const record = template as Record<string, unknown>;
  const subject = readStringField(record, "subject");
  const text = readStringField(record, "text");
  const html = readStringField(record, "html");
  const preview = readStringField(record, "preview");
  if (!subject && !text && !html && !preview) return null;
  return { subject, text, html, preview };
}

function hasEmailArtifactContent(artifact: SpecRunArtifact): boolean {
  if (artifact.invalidated_at) return false;
  if (artifact.kind === "canvas_email" || artifact.kind === "canvas_preview") return true;
  return readArtifactEmailTemplate(artifact.data_json) !== null;
}

export function resolveCanvasArtifactKey(input: {
  operatorView: OperatorView | null;
  pendingInteraction: SpecRunInteraction | null;
}): string | null {
  const fromView = typeof input.operatorView?.meta?.canvasArtifactKey === "string"
    ? input.operatorView.meta.canvasArtifactKey
    : null;
  if (fromView) return fromView;
  const payload = input.pendingInteraction?.payload_json ?? {};
  return typeof payload.canvasArtifactKey === "string" ? payload.canvasArtifactKey : null;
}

export function resolveDisplayArtifact(input: {
  artifacts?: SpecRunArtifact[];
  operatorView: OperatorView | null;
  pendingInteraction: SpecRunInteraction | null;
}): SpecRunArtifact | null {
  const artifacts = (input.artifacts ?? []).filter((artifact) => !artifact.invalidated_at);
  if (artifacts.length === 0) return null;

  const canvasKey = resolveCanvasArtifactKey(input);
  if (canvasKey) {
    return artifacts.find((artifact) => artifact.artifact_key === canvasKey) ?? null;
  }

  const emailArtifacts = artifacts.filter(hasEmailArtifactContent);
  const pool = emailArtifacts.length > 0 ? emailArtifacts : artifacts;
  return [...pool].sort((left, right) => {
    const leftTime = Date.parse(left.created_at ?? "") || 0;
    const rightTime = Date.parse(right.created_at ?? "") || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return right.artifact_key.localeCompare(left.artifact_key);
  })[0] ?? null;
}

export function resolveActiveGate(input: {
  runStatus: string;
  steps: SpecRunStep[];
  pendingInteraction: SpecRunInteraction | null;
  operatorView: OperatorView | null;
}): {
  show: boolean;
  step: SpecRunStep | null;
  interaction: SpecRunInteraction | null;
  operatorView: OperatorView | null;
} {
  if (!input.pendingInteraction || !input.operatorView) {
    return { show: false, step: null, interaction: null, operatorView: null };
  }

  const step = input.steps.find((entry) => entry.id === input.pendingInteraction!.step_attempt_id) ?? null;
  return {
    show: true,
    step,
    interaction: input.pendingInteraction,
    operatorView: input.operatorView,
  };
}

export function toArtifactRecord(artifact: SpecRunArtifact): {
  id: string;
  artifact_key: string;
  version: number;
  kind: string;
  body: string;
  data_json?: Record<string, unknown>;
  invalidated_at: string | null;
} {
  return {
    id: artifact.id,
    artifact_key: artifact.artifact_key,
    version: 1,
    kind: artifact.kind,
    body: artifact.body,
    data_json: artifact.data_json,
    invalidated_at: artifact.invalidated_at ?? null,
  };
}

export function buildGatePromptOptions(operatorView: OperatorView) {
  const isDraft = operatorView.blocks.some((block) =>
    block.surface === "review.email" || block.surface === "review.draft");
  const options = [
    {
      id: "approve",
      label: isDraft ? "Approve draft" : "Approve",
      value: "approve",
      description: isDraft ? "Save edits and continue" : "Continue",
    },
    {
      id: "revise",
      label: "Request changes",
      value: "revise",
      description: "Send back for another pass",
    },
    {
      id: "reject",
      label: "Reject run",
      value: "reject",
      description: "Stop this run",
    },
  ];
  return options;
}
