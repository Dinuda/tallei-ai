import type { DynamicToolUIPart, ReasoningUIPart, UIMessage } from "ai";

import type { InteractivePromptOption } from "@/components/ai-elements/interactive-prompt-menu";
import type {
  PresentReplyOptionsInput,
  PresentReplyOptionsOutput,
} from "@/lib/conductor-prompt-suggestions";

export type BindingRow = { connector: string; capability: string; optional?: boolean; role?: string };

export type BlueprintOutcome = {
  id: string;
  role: string;
  description: string;
  selectedConnector?: string;
  status: string;
  candidates?: Array<{ connector: string; connected: boolean; rationale?: string }>;
};

export type TaskBlueprint = {
  summary?: string;
  outcomes?: BlueprintOutcome[];
};

export type AskQuestionInput = {
  questionId: string;
  question: string;
  options: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  allowMultiple?: boolean;
  allowOther?: boolean;
  step?: { index: number; total: number };
};

export type AskQuestionOutput = {
  questionId: string;
  answerText: string;
  selectedOptionIds: string[];
  selectedValues: string[];
  otherText?: string;
  skipped?: boolean;
};

export type PickConnectorAppInput = {
  question?: string;
};

export type PickConnectorAppToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: PickConnectorAppInput;
  output?: AskQuestionOutput;
};

export type ConnectorDiscoveryOutput = {
  askOptions?: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  defaultQuestion?: string;
  autoApplyConnector?: string;
};

export function uiMessagesEqual(a: UIMessage[], b: UIMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Content fingerprint — useChat may mutate the messages array in place without changing reference. */
export function getMessagesSyncKey(messages: UIMessage[]): string {
  return JSON.stringify(messages);
}

export function blueprintNeedsConnectorPick(spec: Record<string, unknown> | null): boolean {
  const blueprint = readTaskBlueprint(spec);
  if (!blueprint?.outcomes?.length) return true;
  return blueprint.outcomes.some(
    (outcome) =>
      outcome.role !== "transform"
      && outcome.status !== "chosen"
      && outcome.status !== "skipped"
      && !outcome.selectedConnector,
  );
}

export function resolveAutoConnectorPick(
  askOptions: InteractivePromptOption[],
  recommendedOptionIds: string[],
): string | null {
  const connected = askOptions.filter((option) => option.description === "Already connected");
  if (connected.length !== 1) return null;
  const pick = connected[0]!;
  const topId = recommendedOptionIds[0];
  if (topId && pick.id !== topId) return null;
  return pick.value;
}

export function resolveDiscoveryAutoConnector(discovery: ConnectorDiscoveryOutput | null): string | null {
  if (!discovery) return null;
  if (discovery.autoApplyConnector) return discovery.autoApplyConnector;
  if (!discovery.askOptions?.length) return null;
  return resolveAutoConnectorPick(
    discovery.askOptions,
    discovery.recommendedOptionIds ?? discovery.askOptions.slice(0, 5).map((option) => option.id),
  );
}

export type AutoConnectorPromptTarget = {
  toolCallId: string;
  toolName: "askQuestion" | "pickConnectorApp";
  autoConnector: string;
  connectorOptionId: string;
  connectorLabel: string;
};

export function findAutoConnectorPromptTarget(
  messages: UIMessage[],
  spec: Record<string, unknown> | null,
): AutoConnectorPromptTarget | null {
  if (!blueprintNeedsConnectorPick(spec)) return null;

  const discovery = findLatestConnectorDiscovery(messages);
  const autoConnector = resolveDiscoveryAutoConnector(discovery);
  if (!autoConnector || !discovery?.askOptions?.length) return null;

  const connectorOption = discovery.askOptions.find(
    (option) => option.value.toLowerCase() === autoConnector.toLowerCase(),
  );
  if (!connectorOption) return null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];

      if (isPickConnectorAppPart(part)) {
        const pickPart = part as PickConnectorAppToolPart;
        if (pickPart.state === "input-available" && pickPart.output == null) {
          return {
            toolCallId: pickPart.toolCallId,
            toolName: "pickConnectorApp",
            autoConnector,
            connectorOptionId: connectorOption.id,
            connectorLabel: connectorOption.label,
          };
        }
      }

      if (isAskQuestionPart(part)) {
        const askPart = part as AskQuestionToolPart;
        if (askPart.state === "input-available" && askPart.output == null) {
          const input = askPart.input;
          if (!input?.question || !input.options?.length) continue;
          if (isConnectorConfirmationQuestion(input)) {
            return {
              toolCallId: askPart.toolCallId,
              toolName: "askQuestion",
              autoConnector,
              connectorOptionId: connectorOption.id,
              connectorLabel: connectorOption.label,
            };
          }
        }
      }
    }
  }

  return null;
}

export function isConnectorConfirmationQuestion(input: AskQuestionInput): boolean {
  const question = input.question.toLowerCase();
  const labels = input.options.map((option) => option.label.toLowerCase());
  const yesNo =
    labels.includes("yes")
    && (labels.includes("not yet") || labels.includes("no"));
  const mentionsConnector =
    /which app|what app|handles your|already connected|for trigger|for send|receiving|saving draft/.test(question);
  return yesNo && mentionsConnector;
}

export type PendingInteractivePrompt = {
  toolCallId: string;
  toolName: "askQuestion" | "pickConnectorApp";
  input: AskQuestionInput;
};

export const DEFAULT_CONNECTOR_PICK_QUESTION =
  "Which app should power this loop? Triggers and actions are configured automatically after you pick.";

export type PendingPresentReplyOptions = {
  toolCallId: string;
  input: PresentReplyOptionsInput;
};

export type PresentReplyOptionsToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: PresentReplyOptionsInput;
  output?: PresentReplyOptionsOutput;
};

export type AskQuestionToolPart = {
  type: string;
  toolCallId: string;
  state: DynamicToolUIPart["state"];
  input?: AskQuestionInput;
  output?: AskQuestionOutput;
};

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export function readTaskBlueprint(spec: Record<string, unknown> | null): TaskBlueprint | null {
  const blueprint = spec?.taskBlueprint;
  if (!blueprint || typeof blueprint !== "object") return null;
  return blueprint as TaskBlueprint;
}

export function resolveToolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

export function isToolPart(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

export function isAskQuestionPart(part: { type: string; toolName?: string }): part is AskQuestionToolPart {
  return resolveToolPartName(part) === "askQuestion";
}

export function isPickConnectorAppPart(part: { type: string; toolName?: string }): part is PickConnectorAppToolPart {
  return resolveToolPartName(part) === "pickConnectorApp";
}

export function isPresentReplyOptionsPart(part: { type: string; toolName?: string }): part is PresentReplyOptionsToolPart {
  return resolveToolPartName(part) === "presentReplyOptions";
}

export function findLatestConnectorDiscovery(messages: UIMessage[]): ConnectorDiscoveryOutput | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (!isToolPart(part.type)) continue;
      if (resolveToolPartName(part as { type: string; toolName?: string }) !== "discoverConnectorsForBlueprint") {
        continue;
      }
      const toolPart = part as DynamicToolUIPart & { output?: unknown };
      if (toolPart.state !== "output-available" || !toolPart.output) continue;
      const output = toolPart.output as ConnectorDiscoveryOutput;
      if (output.askOptions?.length) return output;
    }
  }
  return null;
}

function looksLikeRoleBasedConnectorOptions(options: InteractivePromptOption[]): boolean {
  if (options.some((option) => /-(trigger|source|destination|read|send)\b/i.test(option.label))) {
    return true;
  }
  const appNames = options.map((option) => {
    const split = option.label.split(" - ")[0]?.trim().toLowerCase();
    return split || option.value.toLowerCase();
  });
  return new Set(appNames).size < appNames.length;
}

export function buildConnectorPickInput(
  discovery: ConnectorDiscoveryOutput,
  questionOverride?: string,
): AskQuestionInput {
  const askOptions = discovery.askOptions ?? [];
  return {
    questionId: "connector-app",
    question: questionOverride?.trim() || discovery.defaultQuestion || DEFAULT_CONNECTOR_PICK_QUESTION,
    options: askOptions,
    recommendedOptionIds: discovery.recommendedOptionIds ?? askOptions.slice(0, 5).map((option) => option.id),
    allowMultiple: false,
    allowOther: true,
  };
}

export function findPendingInteractivePrompt(
  messages: UIMessage[],
  spec: Record<string, unknown> | null = null,
): PendingInteractivePrompt | null {
  if (!blueprintNeedsConnectorPick(spec)) return null;

  const discovery = findLatestConnectorDiscovery(messages);
  const autoConnector = resolveDiscoveryAutoConnector(discovery);

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];

      if (isPickConnectorAppPart(part)) {
        const pickPart = part as PickConnectorAppToolPart;
        if (pickPart.state === "input-available" && pickPart.output == null) {
          if (!discovery?.askOptions?.length) return null;
          if (autoConnector) return null;
          return {
            toolCallId: pickPart.toolCallId,
            toolName: "pickConnectorApp",
            input: buildConnectorPickInput(discovery, pickPart.input?.question),
          };
        }
      }

      if (isAskQuestionPart(part)) {
        const askPart = part as AskQuestionToolPart;
        if (askPart.state === "input-available" && askPart.output == null) {
          const input = askPart.input;
          if (!input?.question || !input.options?.length) continue;

          if (autoConnector && isConnectorConfirmationQuestion(input)) {
            return null;
          }

          if (discovery?.askOptions?.length && isConnectorConfirmationQuestion(input)) {
            return {
              toolCallId: askPart.toolCallId,
              toolName: "askQuestion",
              input: buildConnectorPickInput(discovery, input.question),
            };
          }

          if (discovery?.askOptions?.length && looksLikeRoleBasedConnectorOptions(input.options)) {
            return {
              toolCallId: askPart.toolCallId,
              toolName: "askQuestion",
              input: buildConnectorPickInput(discovery, input.question),
            };
          }

          return { toolCallId: askPart.toolCallId, toolName: "askQuestion", input };
        }
      }
    }
  }
  return null;
}

export function shouldShowThinkingIndicator(
  messages: UIMessage[],
  chatStatus: ChatStatus,
  hasPendingQuestion: boolean,
  forceThinking = false,
): boolean {
  if (forceThinking) return true;
  if (hasPendingQuestion) return false;
  if (chatStatus !== "streaming" && chatStatus !== "submitted") return false;

  const last = messages.at(-1);
  if (!last || last.role === "user") return true;

  const parts = last.parts ?? [];
  const hasStreamingReasoning = parts.some(
    (part) => part.type === "reasoning" && (part as ReasoningUIPart).state === "streaming",
  );
  if (hasStreamingReasoning) return false;

  const hasInProgressTool = parts.some((part) => {
    if (!isToolPart(part.type) || isAskQuestionPart(part)) return false;
    const state = (part as DynamicToolUIPart).state;
    return state !== "output-available" && state !== "output-error";
  });
  if (hasInProgressTool) return false;

  const hasVisibleText = parts.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  );
  if (hasVisibleText && chatStatus === "streaming") {
    const lastPart = parts.at(-1);
    if (lastPart && isToolPart(lastPart.type) && (lastPart as DynamicToolUIPart).state === "output-available") {
      return true;
    }
    return false;
  }

  return true;
}

export function makeUserMessage(text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
  };
}

export function outcomeRoleLabel(role: string): string {
  switch (role) {
    case "source": return "Source";
    case "destination": return "Destination";
    case "trigger": return "Trigger";
    case "transform": return "Transform";
    default: return role;
  }
}

export function promptVariantForQuestion(questionId: string): "connector" | "violet" | "amber" | "neutral" {
  if (questionId === "connector-app") return "connector";
  if (questionId === "knowledge-sources") return "violet";
  if (questionId === "review-gates") return "amber";
  return "neutral";
}
