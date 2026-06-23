import { getToolName, isToolUIPart, type UIMessage } from "ai";

import { maskBuilderIssueText } from "./builder-issue-text";

export type BuilderCommandSnapshot = {
  id?: string;
  toolName?: string;
  status?: string;
  error?: string;
  result?: Record<string, unknown>;
  events?: Array<{
    stage?: string;
    message?: string;
    status?: string;
    details?: Record<string, unknown>;
  }>;
};

export type BuilderRecoveryState =
  | { kind: "idle" }
  | { kind: "running"; message: string; commandId?: string }
  | { kind: "interrupted"; message: string }
  | { kind: "failed"; message: string; commandId?: string; toolName?: string };

type BuildContractSnapshot = {
  requirements?: Array<{ required?: boolean; status?: string }>;
};

function readMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

export function latestUserPromptText(messages: UIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = readMessageText(message);
    if (text) return text;
  }
  return "";
}

export function isBuildContractFullyResolved(contract: BuildContractSnapshot | null | undefined): boolean {
  const requirements = contract?.requirements ?? [];
  if (requirements.length === 0) return false;
  return requirements.every((entry) => entry.required !== true || entry.status === "resolved");
}

function isInfrastructureTimeout(error: string | undefined): boolean {
  if (!error) return false;
  return /timed out|timeout|504|502|backend loop builder|failed to reach backend/i.test(error);
}

export function builderCommandFailureMessage(input: {
  command?: BuilderCommandSnapshot | null;
  sessionError?: string | null;
  buildContract?: BuildContractSnapshot | null;
}): string {
  const rawError = input.command?.error ?? input.sessionError ?? "The last builder step did not finish.";
  const toolName = input.command?.toolName;
  const progressSaved = isBuildContractFullyResolved(input.buildContract);

  if (toolName === "saveLoop" && isInfrastructureTimeout(rawError)) {
    if (progressSaved) {
      return "Saving your loop is taking longer than usual due to a temporary backend issue on our side — nothing is wrong with your configuration. All of your setup choices are already saved in this builder session. Try again in a few minutes, refresh the page to reload this session, or return to it later from your loops list.";
    }
    return "Saving your loop timed out due to a temporary backend issue on our side. Your builder session is still saved — try again in a few minutes or refresh the page.";
  }

  return maskBuilderIssueText(rawError, "recovery-message");
}

const BACKEND_COMMAND_TOOLS = new Set([
  "getAvailableTools",
  "resolveBuildRequirement",
  "saveLoop",
  "runBuilderTest",
  "runVerification",
  "confirmActivation",
]);

const INPUT_GATE_TOOLS = new Set([
  "appSelection",
  "artifactSetup",
  "connectorSetup",
  "interactivePrompt",
  "knowledgeBaseSetup",
  "requirementSetup",
  "scheduleSetup",
  "outputReviewGatesSetup",
]);

function latestCommandForTool(
  commands: BuilderCommandSnapshot[],
  toolName: string,
): BuilderCommandSnapshot | null {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    if (command?.toolName === toolName) return command;
  }
  return null;
}

export function hydrateBuilderMessagesFromCommands(
  messages: UIMessage[],
  commands: BuilderCommandSnapshot[],
): UIMessage[] {
  let messagesChanged = false;

  const nextMessages = messages.map((message) => {
    if (message.role !== "assistant") return message;

    let partsChanged = false;
    const nextParts = message.parts.map((part) => {
      if (!isToolUIPart(part)) return part;
      const toolName = getToolName(part);
      if (!BACKEND_COMMAND_TOOLS.has(toolName)) return part;
      if (part.state === "output-available" || part.state === "output-error") return part;

      const command = latestCommandForTool(commands, toolName);
      if (!command) return part;

      if (command.status === "completed") {
        partsChanged = true;
        return {
          ...part,
          state: "output-available",
          output: command.result ?? part.output,
        } as unknown as typeof part;
      }
      if (command.status === "failed" || command.status === "rejected") {
        partsChanged = true;
        return {
          ...part,
          state: "output-error",
          errorText: maskBuilderIssueText(
            command.error ?? "This step did not finish.",
            `command:${toolName}`,
          ),
        } as unknown as typeof part;
      }
      return part;
    });

    if (!partsChanged) return message;
    messagesChanged = true;
    return { ...message, parts: nextParts };
  });

  return messagesChanged ? nextMessages : messages;
}

function lastMessage(messages: UIMessage[]): UIMessage | undefined {
  return messages.at(-1);
}

function hasIncompleteAssistantToolCalls(message: UIMessage): boolean {
  return message.parts.some((part) => {
    if (!isToolUIPart(part)) return false;
    if (part.state === "input-streaming") return true;
    if (part.state !== "input-available") return false;

    const toolName = getToolName(part);
    if (INPUT_GATE_TOOLS.has(toolName)) return false;
    return BACKEND_COMMAND_TOOLS.has(toolName);
  });
}

function latestSettledBuilderCommand(commands: BuilderCommandSnapshot[]): BuilderCommandSnapshot | null {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    if (!command?.status) continue;
    if (command.status === "completed" || command.status === "failed" || command.status === "rejected") {
      return command;
    }
  }
  return null;
}

export function detectBuilderRecoveryState(input: {
  messages: UIMessage[];
  commands: BuilderCommandSnapshot[];
  chatStatus: string;
  sessionPhase?: string | null;
  sessionError?: string | null;
  buildContract?: BuildContractSnapshot | null;
}): BuilderRecoveryState {
  const runningCommand = [...input.commands].reverse().find((command) =>
    command.status === "running" || command.status === "pending");
  if (runningCommand) {
    return {
      kind: "running",
      message: "The builder is still working on your loop. Refresh the page to see the latest saved progress.",
      commandId: runningCommand.id,
    };
  }

  const latestSettledCommand = latestSettledBuilderCommand(input.commands);
  const failedCommand = latestSettledCommand && (
    latestSettledCommand.status === "failed" || latestSettledCommand.status === "rejected"
  ) ? latestSettledCommand : null;
  if (failedCommand || (input.sessionPhase === "failed" && !latestSettledCommand)) {
    return {
      kind: "failed",
      message: builderCommandFailureMessage({
        command: failedCommand,
        sessionError: input.sessionError,
        buildContract: input.buildContract,
      }),
      commandId: failedCommand?.id,
      toolName: failedCommand?.toolName,
    };
  }

  if (input.chatStatus === "streaming" || input.chatStatus === "submitted") {
    return { kind: "idle" };
  }

  const tail = lastMessage(input.messages);
  if (!tail) return { kind: "idle" };
  if (tail.role === "user") {
    return {
      kind: "interrupted",
      message: "There was an issue while generating the response. Your message is ready to resend below.",
    };
  }
  if (tail.role === "assistant" && hasIncompleteAssistantToolCalls(tail)) {
    return {
      kind: "interrupted",
      message: "There was an issue while generating the response. Your message is ready to resend below.",
    };
  }

  return { kind: "idle" };
}

export function findRunningBuilderCommand(
  commands: BuilderCommandSnapshot[],
): BuilderCommandSnapshot | null {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    if (command?.status === "running" || command?.status === "pending") return command;
  }
  return null;
}

export function builderRunningCommandLabel(command: BuilderCommandSnapshot | null): string {
  const latestEventMessage = command?.events?.at(-1)?.message?.trim();
  if (latestEventMessage) return latestEventMessage;

  switch (command?.toolName) {
    case "saveLoop":
      return "Designing specialist agents for your loop…";
    case "runBuilderTest":
      return "Running builder test...";
    case "getAvailableTools":
      return "Discovering available tools…";
    case "resolveBuildRequirement":
      return "Applying your selection…";
    case "runVerification":
      return "Running verification checks…";
    case "confirmActivation":
      return "Activating your loop…";
    default:
      return "Working on your loop…";
  }
}

const KEEPALIVE_PAYLOAD_LIMIT_BYTES = 60_000;

function slimArtifactTemplateRecord(template: unknown): unknown {
  if (!template || typeof template !== "object") return template;
  const { html: _html, text: _text, editorContent: _editorContent, ...rest } = template as Record<string, unknown>;
  return rest;
}

function slimArtifactSetupOutput(output: Record<string, unknown>): Record<string, unknown> {
  const templates = Array.isArray(output.templates)
    ? output.templates.map(slimArtifactTemplateRecord)
    : output.templates;
  let value = output.value;
  let artifactPersisted = output.artifactPersisted === true;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const valueRecord = value as Record<string, unknown>;
    if (typeof valueRecord.template === "string") {
      artifactPersisted = true;
      value = { mode: valueRecord.mode ?? "supplied_template" };
    }
  }
  return {
    ...output,
    templates,
    value,
    ...(artifactPersisted ? { artifactPersisted: true } : {}),
  };
}

/** Strip rendered email HTML from persisted chat snapshots — artifacts are stored separately. */
export function trimBuilderMessagesForPersistence(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (!isToolUIPart(part) || getToolName(part) !== "artifactSetup") return part;
      if (part.state !== "output-available" || !part.output || typeof part.output !== "object") return part;
      return {
        ...part,
        output: slimArtifactSetupOutput(part.output as Record<string, unknown>),
      };
    }),
  }));
}

export async function persistBuilderMessages(
  sessionId: string,
  messages: UIMessage[],
  options?: { keepalive?: boolean },
): Promise<void> {
  const trimmed = trimBuilderMessagesForPersistence(messages);
  const body = JSON.stringify({ messages: trimmed });

  if (options?.keepalive && body.length > KEEPALIVE_PAYLOAD_LIMIT_BYTES) {
    // Browser keepalive fetch requests reject large bodies; skip rather than throw.
    return;
  }

  try {
    const response = await fetch(`/api/conductor/sessions/${sessionId}/messages`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: options?.keepalive === true,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof payload.error === "string" ? payload.error : "Could not save builder progress");
    }
  } catch (error) {
    if (options?.keepalive) return;
    throw error;
  }
}

export async function retryBuilderCommand(sessionId: string, commandId?: string): Promise<{ jobId: string }> {
  const response = await fetch(`/api/conductor/sessions/${sessionId}/retry-command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(commandId ? { commandId } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Could not retry the builder step");
  }
  return { jobId: String(payload.jobId ?? payload.id ?? "") };
}
