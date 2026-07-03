import type { UIMessage } from "ai";

export type ConductorPromptSuggestion = {
  id: string;
  label: string;
  message: string;
};

export type PresentReplyOptionsInput = {
  options: ConductorPromptSuggestion[];
};

export type PresentReplyOptionsOutput = {
  selectedOptionId: string;
  message: string;
};

type DeriveSuggestionsInput = {
  messages: UIMessage[];
  missingSlots: string[];
  status: string;
  hasPendingQuestion: boolean;
  hasPendingReplyOptions: boolean;
  chatBusy: boolean;
  explicitOptions?: ConductorPromptSuggestion[];
};

function resolveToolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

function isToolPart(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool";
}

function getLastAssistantText(messages: UIMessage[]): string {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return "";
  return (last.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function scanToolPipeline(messages: UIMessage[]): {
  compileOk: boolean;
  testOk: boolean;
  activateOk: boolean;
} {
  let compileOk = false;
  let testOk = false;
  let activateOk = false;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (!isToolPart(part.type)) continue;
      const toolPart = part as { state?: string; output?: unknown };
      if (toolPart.state !== "output-available") continue;
      const name = resolveToolPartName(part as { type: string; toolName?: string });
      const output = toolPart.output as { ok?: boolean } | undefined;
      if (name === "compileLoop" && output?.ok) compileOk = true;
      if (name === "testRunLoop" && output?.ok) testOk = true;
      if (name === "activateLoop" && output?.ok) activateOk = true;
    }
  }

  return { compileOk, testOk, activateOk };
}

function compileAndTestSuggestions(): ConductorPromptSuggestion[] {
  return [
    {
      id: "yes-compile-test",
      label: "Yes, compile and test",
      message: "Yes, compile the loop and run a simulated test.",
    },
    {
      id: "changes-first",
      label: "Make changes first",
      message: "Not yet — I want to make some changes first.",
    },
    {
      id: "explain-setup",
      label: "Explain the setup",
      message: "Walk me through what you configured before we compile.",
    },
  ];
}

function activateSuggestions(): ConductorPromptSuggestion[] {
  return [
    {
      id: "yes-activate",
      label: "Yes, activate it",
      message: "Yes, activate the loop.",
    },
    {
      id: "another-test",
      label: "Run another test",
      message: "Run another simulated test first.",
    },
    {
      id: "hold-activate",
      label: "Not yet",
      message: "Not yet — I want to review before activating.",
    },
  ];
}

function genericYesNoSuggestions(): ConductorPromptSuggestion[] {
  return [
    { id: "yes", label: "Yes", message: "Yes" },
    { id: "not-yet", label: "Not yet", message: "Not yet" },
    {
      id: "tell-me-more",
      label: "Tell me more",
      message: "Can you explain more before I decide?",
    },
  ];
}

export function findPendingPresentReplyOptions(
  messages: UIMessage[],
): { toolCallId: string; input: PresentReplyOptionsInput } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const parts = message.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (!isToolPart(part.type)) continue;
      if (resolveToolPartName(part as { type: string; toolName?: string }) !== "presentReplyOptions") {
        continue;
      }
      const toolPart = part as {
        toolCallId: string;
        state?: string;
        input?: PresentReplyOptionsInput;
        output?: unknown;
      };
      const resumable =
        toolPart.output == null
        && (toolPart.state === "input-available" || toolPart.state === "input-streaming")
        && (toolPart.input?.options?.length ?? 0) >= 2;
      if (resumable && toolPart.input) {
        return { toolCallId: toolPart.toolCallId, input: toolPart.input };
      }
    }
  }
  return null;
}

export function deriveConductorPromptSuggestionsQuestion(messages: UIMessage[]): string {
  const text = getLastAssistantText(messages);
  if (!text) return "How would you like to proceed?";

  const questionMatch = text.match(/[^.!?\n]*\?/);
  if (questionMatch) {
    return questionMatch[0].trim();
  }

  if (text.length <= 120) return text;

  const firstLine = text.split("\n")[0]?.trim();
  if (firstLine && firstLine.length <= 200) return firstLine;

  return "How would you like to proceed?";
}

export function deriveConductorPromptSuggestions(input: DeriveSuggestionsInput): ConductorPromptSuggestion[] {
  if (input.hasPendingQuestion || input.chatBusy) return [];

  if (input.explicitOptions?.length) {
    return input.explicitOptions;
  }

  const last = input.messages.at(-1);
  if (!last || last.role !== "assistant") return [];

  const text = getLastAssistantText(input.messages);
  const lower = text.toLowerCase();
  const ready = input.missingSlots.length === 0;
  const { compileOk, testOk, activateOk } = scanToolPipeline(input.messages);
  const asksUser = /\?/.test(text)
    && /\bwould you\b|\bdo you want\b|\bshould i\b|\bready to\b|\blike me to\b|\bshall i\b/.test(lower);

  if (
    ready
    && !compileOk
    && (
      /compile.*(test|simulat)|(test|simulat).*compile|run a (simulated )?test/.test(lower)
      || (asksUser && /compile|test|go live/.test(lower))
    )
  ) {
    return compileAndTestSuggestions();
  }

  if (
    testOk
    && input.status !== "active"
    && !activateOk
    && (asksUser || /activate|go live/.test(lower))
  ) {
    return activateSuggestions();
  }

  if (compileOk && !testOk && (asksUser || /test|simulat|try it/.test(lower))) {
    return [
      { id: "run-test", label: "Run the test", message: "Yes, run the simulated test." },
      { id: "review-first", label: "Review the spec first", message: "Let me review the spec before testing." },
    ];
  }

  if (ready && !compileOk && /ready to compile|configuration is complete|all set|bindings:/i.test(text)) {
    return [
      {
        id: "compile-test",
        label: "Compile and test",
        message: "Compile the loop and run a simulated test.",
      },
      {
        id: "explain-first",
        label: "Explain first",
        message: "Explain what you configured before we compile.",
      },
    ];
  }

  if (asksUser) {
    if (/which app|what app|handles your|already connected|gmail|outlook|connector/.test(lower)) {
      return [];
    }
    if (ready && !compileOk && /compile|test/.test(lower)) {
      return compileAndTestSuggestions();
    }
    return genericYesNoSuggestions();
  }

  return [];
}
