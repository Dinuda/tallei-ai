import type { UIMessage } from "ai";

import type { OperatorView } from "@/lib/operator-view-types";

export { buildGatePromptOptions } from "@/lib/operator-view-types";

export type SpecRunStep = {
  id: string;
  step_index: number;
  attempt: number;
  agent_id: string;
  agent_snapshot: {
    name?: string;
    task?: string;
    tools?: unknown[];
    inputContract?: Record<string, unknown>;
    outputContract?: Record<string, unknown>;
    handoffBindings?: unknown[];
    doneCriteria?: unknown[];
    gate?: Record<string, unknown>;
    artifactRole?: string;
    renderer?: string;
    outputArtifactId?: string;
    outputArtifactKind?: string;
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

function formatClassifiedEmails(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const sections = value.map((email, index) => {
    if (!email || typeof email !== "object" || Array.isArray(email)) return "";
    const record = email as Record<string, unknown>;
    const subject = readStringField(record, "subject") || `Email ${index + 1}`;
    const senderName = readStringField(record, "senderName");
    const senderEmail = readStringField(record, "senderEmail");
    const priority = readStringField(record, "priority");
    const reasoning = readStringField(record, "reasoning") || readStringField(record, "rationale");
    const lines = [`**${subject}**`];
    const sender = [senderName, senderEmail].filter(Boolean).join(" <");
    if (senderName && senderEmail) lines.push(`From: ${sender}>`);
    else if (senderName || senderEmail) lines.push(`From: ${senderName || senderEmail}`);
    if (priority) lines.push(`Priority: ${priority}`);
    if (reasoning) lines.push(reasoning);
    return lines.join("\n");
  }).filter(Boolean);
  return sections.join("\n\n");
}

function formatStructuredData(data: Record<string, unknown>): string {
  const emailDrafts = formatEmailDrafts(data.emailDrafts);
  if (emailDrafts) return emailDrafts;

  const classifiedEmails = formatClassifiedEmails(data.emails);
  if (classifiedEmails) return classifiedEmails;

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

function collapseValidationError(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "";
  const matches = trimmed.match(/data must NOT have additional properties/g);
  if (!matches || matches.length <= 1) return trimmed;
  const fields = [...trimmed.matchAll(/property '([^']+)'/g)].map((match) => match[1]);
  const uniqueFields = [...new Set(fields.filter(Boolean))];
  if (uniqueFields.length > 0) {
    return `Output has unexpected fields: ${uniqueFields.join(", ")}`;
  }
  return "Output has unexpected additional properties.";
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

  if (step.error_json?.message?.trim()) {
    return collapseValidationError(step.error_json.message);
  }
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
  const output = decision.output && typeof decision.output === "object" && !Array.isArray(decision.output)
    ? decision.output as Record<string, unknown>
    : {};
  const connectorOutput = output.output && typeof output.output === "object" && !Array.isArray(output.output)
    ? output.output as Record<string, unknown>
    : null;

  if (interaction.status === "approved") {
    if (output.ok === true && connectorOutput) {
      const message = typeof connectorOutput.message === "string" ? connectorOutput.message.trim() : "";
      const id = typeof connectorOutput.id === "string" ? connectorOutput.id.trim() : "";
      if (message) return `Connector action completed: ${message}`;
      if (id) return `Connector action completed. ID: ${id}`;
      return "Connector action completed successfully.";
    }
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
    const rawReason = typeof decision.reason === "string" ? decision.reason.trim() : "";
    const reason = rawReason
      .replace(/^requested\s+changes:\s*/gi, "")
      .replace(/^revise(d)?\s*/i, "")
      .trim();
    if (decision.command === "revise") return reason ? `Requested changes: ${reason}` : "Requested changes";
    return reason ? `Rejected: ${reason}` : "Rejected";
  }
  return null;
}

/** Synthetic run narration we hide from the transcript — only show real chat/tool output. */
export function isRunMetaNarration(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /configured .*gate will now/.test(normalized)
    || /delivery specialist will proceed/.test(normalized)
    || /proceeding to .*specialist/.test(normalized)
    || /^now proceeding to /.test(normalized)
    || /^i['’]ll start by /.test(normalized)
    || /^let me /.test(normalized)
    || /^good,\s*i have\b/.test(normalized)
    || /^i also found /.test(normalized)
    || /^context specialist complete\b/.test(normalized)
    || /^draft specialist complete\b/.test(normalized)
    || /^delivery specialist complete\b/.test(normalized)
    || /\blet me now finalize\b/.test(normalized)
    || /all (three )?agents have completed/.test(normalized)
    || /workflow run summary/.test(normalized)
    || /approval required per .*policy/.test(normalized)
    || /operator for review before/.test(normalized)
    || /^i(?:'|’)ll start by /.test(normalized)
    || /^let me (?:now )?(?:check|fetch|look|search|gather|craft|draft|finalize)\b/.test(normalized)
    || /^now let me /.test(normalized)
    || /^good,\s*i have .*now let me /.test(normalized)
    || /^i see the context from /.test(normalized)
    || /^based on (?:the |my )?(?:context|evidence|research)/.test(normalized)
    || /^i(?:'|’)ve (?:gathered|reviewed|analyzed|identified)/.test(normalized)
    || /^here(?:'|’)s (?:the |my )?(?:context|summary|analysis)/.test(normalized)
    || /^subject:\s*.+/i.test(text.trim())
    || /^dear\s+/i.test(normalized)
    || /^hi\s+[a-z]+,/i.test(normalized)
    || /^[a-z\s]+specialist complete\./.test(normalized)
    || /^requested changes:/i.test(text.trim());
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
  if (!canvasKey || !input.pendingInteraction) return null;

  const artifact = artifacts.find((entry) => entry.artifact_key === canvasKey) ?? null;
  if (!artifact) return null;
  if (artifact.step_attempt_id && artifact.step_attempt_id !== input.pendingInteraction.step_attempt_id) {
    return null;
  }
  return artifact;
}

export function isNoActionRequiredValue(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === "string") {
    const normalized = value.replace(/[_-]+/g, " ").toLowerCase();
    return /\bno (new )?(support )?tickets? (found|detected)\b/.test(normalized)
      || /\bno (formal )?support tickets?\b/.test(normalized)
      || /\bno drafts? (were )?(created|needed|could be created)\b/.test(normalized)
      || /\bnothing actionable\b/.test(normalized);
  }
  if (Array.isArray(value)) return value.some(isNoActionRequiredValue);
  if (typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  if (status === "no_action_required" || status === "no_tickets_found" || status === "no_ticket_found") {
    return true;
  }
  for (const key of ["structuredOutput", "data", "summary", "text", "body", "message", "conclusion", "findings"]) {
    if (isNoActionRequiredValue(record[key])) return true;
  }
  return false;
}

export function isNoActionReview(input: {
  operatorView: OperatorView | null;
  pendingInteraction: SpecRunInteraction | null;
  displayArtifact: SpecRunArtifact | null;
}): boolean {
  const surface = input.operatorView?.blocks.find((block) => block.required && !block.satisfied)?.surface
    ?? input.operatorView?.blocks[0]?.surface
    ?? (typeof input.pendingInteraction?.payload_json?.surface === "string"
      ? input.pendingInteraction.payload_json.surface
      : "");
  if (surface !== "review.email" && surface !== "review.draft" && surface !== "review.preview") return false;
  return isNoActionRequiredValue(input.displayArtifact?.data_json)
    || isNoActionRequiredValue(input.displayArtifact?.body)
    || isNoActionRequiredValue(input.pendingInteraction?.payload_json);
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
  if (!input.pendingInteraction) {
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

export function isGateComposerReady(input: {
  gate: ReturnType<typeof resolveActiveGate>;
}): boolean {
  return Boolean(input.gate.show && input.gate.interaction && input.gate.operatorView);
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

export type HandoffFieldRow = {
  key: string;
  preview: string;
  targetPath?: string;
};

export type PriorOutputGroup = {
  agentName: string;
  agentId: string;
  fields: HandoffFieldRow[];
};

export type HandoffTargetGroup = {
  agentName: string;
  fields: string[];
};

const INTERNAL_OUTPUT_KEYS = new Set(["ok", "approved", "interactionKind", "value"]);

function previewFieldValue(value: unknown, maxLen = 120): string {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (typeof value === "object") {
    const formatted = formatAgentStructuredOutput(value);
    if (formatted) {
      const singleLine = formatted.replace(/\s+/g, " ").trim();
      return singleLine.length > maxLen ? `${singleLine.slice(0, maxLen)}…` : singleLine;
    }
    try {
      const raw = JSON.stringify(value);
      return raw.length > maxLen ? `${raw.slice(0, maxLen)}…` : raw;
    } catch {
      return "…";
    }
  }
  return "";
}

function readStructuredOutputFromStep(step: SpecRunStep): Record<string, unknown> | null {
  const data = step.output_json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const structured = data.structuredOutput;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }

  const nested = data.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }

  if (!isInternalPayload(data)) {
    return data;
  }

  return null;
}

function extractTopLevelFields(record: Record<string, unknown>): HandoffFieldRow[] {
  return Object.entries(record)
    .filter(([key]) => !INTERNAL_OUTPUT_KEYS.has(key))
    .map(([key, value]) => ({
      key,
      preview: previewFieldValue(value),
    }))
    .filter((field) => field.preview);
}

function readResolvedHandoffBindings(step: SpecRunStep): Array<Record<string, unknown>> {
  const resolvedHandoff = step.input_json?.resolvedHandoff;
  if (!resolvedHandoff || typeof resolvedHandoff !== "object" || Array.isArray(resolvedHandoff)) {
    return [];
  }
  const bindings = (resolvedHandoff as Record<string, unknown>).resolvedBindings;
  return Array.isArray(bindings)
    ? bindings.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    : [];
}

function readBindingSourceAgentId(binding: Record<string, unknown>): string {
  const source = binding.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return "";
  const agentId = (source as Record<string, unknown>).agentId;
  return typeof agentId === "string" ? agentId : "";
}

function readBindingSourceKind(binding: Record<string, unknown>): string {
  const source = binding.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return "";
  const kind = (source as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : "";
}

function readBindingSourcePath(binding: Record<string, unknown>): string {
  const source = binding.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return "";
  const path = (source as Record<string, unknown>).path;
  return typeof path === "string" && path.trim() ? path.trim() : "/";
}

function sourcePathToFieldKey(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return "output";
  const segments = trimmed.split("/").filter(Boolean);
  return segments.at(-1) ?? "output";
}

function attachTargetPaths(
  group: PriorOutputGroup,
  bindings: Array<Record<string, unknown>>,
): PriorOutputGroup {
  const bindingByKey = new Map<string, string>();
  for (const binding of bindings) {
    if (readBindingSourceKind(binding) !== "agent_output") continue;
    if (readBindingSourceAgentId(binding) !== group.agentId) continue;
    const fieldKey = sourcePathToFieldKey(readBindingSourcePath(binding));
    const targetPath = typeof binding.targetPath === "string" ? binding.targetPath.trim() : "";
    if (fieldKey && targetPath) bindingByKey.set(fieldKey, targetPath);
  }

  return {
    ...group,
    fields: group.fields.map((field) => ({
      ...field,
      targetPath: bindingByKey.get(field.key) ?? field.targetPath,
    })),
  };
}

export function extractPriorOutputGroups(step: SpecRunStep | undefined): PriorOutputGroup[] {
  if (!step) return [];

  const priorOutputs = step.input_json?.priorOutputs;
  if (!Array.isArray(priorOutputs) || priorOutputs.length === 0) return [];

  const bindings = readResolvedHandoffBindings(step);
  const groups = new Map<string, PriorOutputGroup>();

  for (const entry of priorOutputs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const agentId = typeof record.agentId === "string" ? record.agentId : "";
    const agentName = typeof record.agentName === "string" && record.agentName.trim()
      ? record.agentName.trim()
      : agentId || "Prior agent";
    const groupKey = agentId || agentName;
    const output = record.output;
    const fields = output && typeof output === "object" && !Array.isArray(output)
      ? extractTopLevelFields(output as Record<string, unknown>)
      : previewFieldValue(output)
        ? [{ key: "output", preview: previewFieldValue(output) }]
        : [];

    if (fields.length === 0) continue;

    const existing = groups.get(groupKey);
    if (existing) {
      const mergedKeys = new Set(existing.fields.map((field) => field.key));
      for (const field of fields) {
        if (mergedKeys.has(field.key)) continue;
        existing.fields.push(field);
        mergedKeys.add(field.key);
      }
      continue;
    }

    groups.set(groupKey, attachTargetPaths({
      agentName,
      agentId,
      fields,
    }, bindings));
  }

  return [...groups.values()].map((group) => attachTargetPaths(group, bindings));
}

export function extractOutputFields(step: SpecRunStep | undefined): HandoffFieldRow[] {
  if (!step) return [];
  const structured = readStructuredOutputFromStep(step);
  if (!structured) return [];
  return extractTopLevelFields(structured);
}

function stepMatchesPriorOutputEntry(
  step: SpecRunStep,
  entry: Record<string, unknown>,
): boolean {
  const agentId = typeof entry.agentId === "string" ? entry.agentId : "";
  const agentName = typeof entry.agentName === "string" ? entry.agentName : "";
  const matchesId = Boolean(agentId && agentId === step.agent_id);
  const matchesName = Boolean(
    agentName
    && step.agent_snapshot.name
    && agentName.toLowerCase() === step.agent_snapshot.name.toLowerCase(),
  );
  return matchesId || matchesName;
}

export function resolveHandoffTargets(step: SpecRunStep | undefined, allSteps: SpecRunStep[]): HandoffTargetGroup[] {
  if (!step) return [];

  const laterSteps = latestAttemptPerStep(allSteps)
    .filter((entry) => entry.step_index > step.step_index);

  const targets: HandoffTargetGroup[] = [];

  for (const laterStep of laterSteps) {
    const priorOutputs = laterStep.input_json?.priorOutputs;
    if (!Array.isArray(priorOutputs)) continue;

    const matched = priorOutputs.some((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
      && stepMatchesPriorOutputEntry(step, entry as Record<string, unknown>));
    if (!matched) continue;

    const agentName = laterStep.agent_snapshot.name?.trim() || laterStep.agent_id;
    const bindings = readResolvedHandoffBindings(laterStep);
    const fields = bindings
      .filter((binding) =>
        readBindingSourceKind(binding) === "agent_output"
        && readBindingSourceAgentId(binding) === step.agent_id)
      .map((binding) => {
        const targetPath = typeof binding.targetPath === "string" ? binding.targetPath.trim() : "";
        if (targetPath) return targetPath;
        return sourcePathToFieldKey(readBindingSourcePath(binding));
      })
      .filter(Boolean);

    if (fields.length === 0) {
      const matchedEntry = priorOutputs.find((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
        && stepMatchesPriorOutputEntry(step, entry as Record<string, unknown>));
      const output = matchedEntry && typeof matchedEntry === "object" && !Array.isArray(matchedEntry)
        ? (matchedEntry as Record<string, unknown>).output
        : null;
      if (output && typeof output === "object" && !Array.isArray(output)) {
        fields.push(...Object.keys(output as Record<string, unknown>).filter((key) => !INTERNAL_OUTPUT_KEYS.has(key)));
      }
    }

    if (fields.length === 0) continue;

    targets.push({
      agentName,
      fields: [...new Set(fields)],
    });
  }

  return targets;
}
