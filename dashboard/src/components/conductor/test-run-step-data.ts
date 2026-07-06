import type {
  AgentTeamSpecialist,
  PresentAgentTeamOutput,
} from "@/components/conductor/conductor-shared";

export type TestRunBeatDataSection = {
  title: string;
  data: unknown;
};

type StoryBeat = {
  id: string;
  kind: "trigger" | "specialist" | "approval" | "result";
  status: string;
  specialistId?: string;
  errors?: string[];
  stepData?: TestRunBeatDataSection[];
};

type TestRunScenarioInput = {
  label: string;
  triggerPayload?: Record<string, unknown>;
  context?: string;
};

type TestRunStep = {
  kind: string;
  capability?: string;
  toolId?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  code?: string;
  message?: string;
  decision?: Record<string, unknown>;
};

type TestRunOutput = {
  ok?: boolean;
  status?: string;
  preview?: string;
  error?: string;
  steps?: TestRunStep[];
};

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value != null && value !== ""),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeTriggerTestData(
  payload?: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!payload) return null;

  const nested = asRecord(payload.data);
  if (nested) {
    const ticket = compactRecord({
      from: nested.from ?? nested.sender ?? nested.email,
      subject: nested.subject,
      body: nested.body ?? nested.snippet ?? nested.message_text ?? nested.text,
      threadId: nested.thread_id ?? nested.threadId,
      messageId: nested.message_id ?? nested.messageId,
      labelId: nested.labelId ?? nested.label_id,
    });
    if (Object.keys(ticket).length > 0) return ticket;
  }

  const flat = compactRecord({
    from: payload.from ?? payload.sender ?? payload.email,
    subject: payload.subject,
    body: payload.body ?? payload.snippet ?? payload.message ?? payload.text,
    threadId: payload.thread_id ?? payload.threadId,
    messageId: payload.message_id ?? payload.messageId,
    labelId: payload.labelId ?? payload.label_id,
  });
  if (Object.keys(flat).length > 0) return flat;

  const meaningful = compactRecord(
    Object.fromEntries(
      Object.entries(payload).filter(([key]) => !["metadata", "context", "label"].includes(key)),
    ),
  );
  return Object.keys(meaningful).length > 0 ? meaningful : null;
}

function normalizeEmailDraft(source?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!source) return null;
  const draft = compactRecord({
    to: source.to ?? source.recipient ?? source.recipient_email,
    subject: source.subject,
    body: source.body ?? source.message ?? source.content ?? source.text,
    threadId: source.thread_id ?? source.threadId,
    inReplyTo: source.in_reply_to ?? source.inReplyTo,
  });
  return Object.keys(draft).length > 0 ? draft : null;
}

function normalizeTicketAnalysis(source?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!source) return null;
  const analysis = compactRecord({
    priority: source.priority ?? source.classification ?? source.urgency,
    category: source.category ?? source.topic,
    summary: source.summary ?? source.classification_summary,
    sentiment: source.sentiment,
    recommendedAction: source.recommended_action ?? source.recommendedAction,
  });
  return Object.keys(analysis).length > 0 ? analysis : null;
}

function normalizeDeliveryRecord(source?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!source) return null;
  const delivery = compactRecord({
    to: source.to ?? source.recipient,
    subject: source.subject,
    body: source.body ?? source.message ?? source.content,
    messageId: source.message_id ?? source.messageId ?? source.id,
    threadId: source.thread_id ?? source.threadId,
    status: source.status ?? (source.successful === true ? "sent" : undefined),
    simulated: source.simulated,
  });
  return Object.keys(delivery).length > 0 ? delivery : null;
}

function decisionArgs(step?: TestRunStep): Record<string, unknown> | null {
  const decision = asRecord(step?.decision);
  if (!decision) return null;
  const args = asRecord(decision.args);
  if (args && Object.keys(args).length > 0) return args;
  return compactRecord({
    ...(text(decision.toolId) ? { toolId: decision.toolId } : {}),
    ...(text(decision.kind) ? { action: decision.kind } : {}),
  });
}

function specialistIndexForToolStep(beats: StoryBeat[], toolStep?: TestRunStep): number {
  if (!toolStep) return -1;
  const byId = beats.findIndex((beat) => beat.specialistId === toolStep.toolId);
  if (byId >= 0) return byId;
  return beats.findIndex((beat) => beat.kind === "specialist");
}

function specialistRoleHint(
  specialist: AgentTeamSpecialist | undefined,
): "analysis" | "delivery" | "general" {
  const roles = new Set(specialist?.steps.map((step) => step.role));
  if (roles.has("destination")) return "delivery";
  if (roles.has("transform") || roles.has("source")) return "analysis";
  return "general";
}

function pushSection(
  sections: TestRunBeatDataSection[],
  title: string,
  data: unknown,
): void {
  if (data == null) return;
  if (typeof data === "object" && !Array.isArray(data) && Object.keys(data as object).length === 0) {
    return;
  }
  sections.push({ title, data });
}

function upstreamToolSteps(steps: TestRunStep[], beforeIndex: number): TestRunStep[] {
  const toolSteps = steps.filter((step) => step.kind === "tool");
  if (beforeIndex < 0) return toolSteps;
  return toolSteps.slice(0, beforeIndex);
}

export function buildBeatStepData<T extends StoryBeat>(
  beats: T[],
  input: {
    team?: PresentAgentTeamOutput | null;
    scenario?: TestRunScenarioInput;
    output?: TestRunOutput | null;
  },
): T[] {
  const steps = input.output?.steps ?? [];
  const planStep = steps.find((step) => step.kind === "plan");
  const toolSteps = steps.filter((step) => step.kind === "tool");
  const triggerData = normalizeTriggerTestData(input.scenario?.triggerPayload);
  const planArgs = decisionArgs(planStep);

  return beats.map((beat) => {
    const sections: TestRunBeatDataSection[] = [];

    if (beat.kind === "trigger") {
      if (triggerData) {
        pushSection(sections, "Incoming email", triggerData);
      } else if (input.scenario?.triggerPayload) {
        pushSection(sections, "Incoming event", input.scenario.triggerPayload);
      }
    }

    if (beat.kind === "specialist") {
      const specialist = input.team?.specialists.find((row) => row.id === beat.specialistId);
      const toolIndex = toolSteps.findIndex((_, stepIndex) => {
        const absoluteIndex = specialistIndexForToolStep(beats, toolSteps[stepIndex]);
        return beats[absoluteIndex]?.id === beat.id;
      });
      const toolStep = toolIndex >= 0 ? toolSteps[toolIndex] : undefined;
      const roleHint = specialistRoleHint(specialist);
      const priorTools = toolIndex > 0 ? toolSteps.slice(0, toolIndex) : upstreamToolSteps(steps, toolIndex);
      const priorResult = priorTools.at(-1)?.result;
      const priorArgs = priorTools.at(-1)?.args;

      const inputData = toolStep?.args
        ?? planArgs
        ?? (roleHint === "analysis" ? triggerData : null)
        ?? (roleHint === "delivery" ? normalizeEmailDraft(priorResult) ?? normalizeEmailDraft(priorArgs) : null);

      if (inputData) {
        pushSection(
          sections,
          roleHint === "delivery" ? "Reply draft" : "Ticket received",
          inputData,
        );
      }

      if (toolStep?.result) {
        if (roleHint === "analysis") {
          pushSection(
            sections,
            "Classification & draft",
            normalizeTicketAnalysis(toolStep.result)
              ?? normalizeEmailDraft(toolStep.result)
              ?? toolStep.result,
          );
        } else if (roleHint === "delivery") {
          pushSection(
            sections,
            "Send result",
            normalizeDeliveryRecord(toolStep.result) ?? toolStep.result,
          );
        } else {
          pushSection(sections, "Output", toolStep.result);
        }
      } else if (toolStep?.args && roleHint === "analysis") {
        pushSection(
          sections,
          "Prepared draft",
          normalizeEmailDraft(toolStep.args) ?? toolStep.args,
        );
      }
    }

    if (beat.kind === "approval") {
      const draftSource = toolSteps.at(-1)?.result ?? toolSteps.at(-1)?.args ?? planArgs;
      const draft = normalizeEmailDraft(asRecord(draftSource)) ?? draftSource;
      if (draft) {
        pushSection(sections, "Draft for review", draft);
      }
      if (beat.status === "completed") {
        pushSection(sections, "Approval decision", {
          approved: true,
          approvedBy: "you",
          mode: "test_run_auto",
        });
      }
    }

    if (beat.kind === "result") {
      const lastTool = toolSteps.at(-1);
      const delivery = normalizeDeliveryRecord(lastTool?.result)
        ?? normalizeDeliveryRecord(lastTool?.args)
        ?? normalizeEmailDraft(lastTool?.result);

      if (delivery) {
        pushSection(sections, "Delivered message", delivery);
      } else if (input.output?.preview?.trim()) {
        pushSection(sections, "Run outcome", { message: input.output.preview.trim() });
      }

      if (beat.errors?.length) {
        pushSection(sections, "Errors", beat.errors);
      }
    }

    return sections.length > 0 ? { ...beat, stepData: sections } : beat;
  });
}
