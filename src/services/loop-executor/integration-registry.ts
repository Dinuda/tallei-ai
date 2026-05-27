import type { AuthContext } from "../../domain/auth/index.js";
import { recallMemories } from "../memory.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";
import {
  actionableToolRefs,
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  buildDraftFromToolResults,
  getLoopTool,
  hasOnlyLlmTools,
} from "./tool-catalog.js";
import type { LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";

export interface LoopAgentInput {
  auth: AuthContext;
  goal: string;
  agent: LoopRunAgent;
  assignedTools: LoopToolAssignment[];
  draftPolicy: LoopDefinition["draftPolicy"];
  priorComments: Array<{ author: string; body: string; taskId: string | null; createdAt: string }>;
}

export interface LoopToolResult {
  text: string;
  data: Record<string, unknown>;
  draft?: {
    kind: string;
    summary: string;
    payload: Record<string, unknown>;
  };
}

async function completeText(input: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const response = await aiProviderRegistry.chat({
    model: aiProviderRegistry.chatModelName(),
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    temperature: 0.3,
    maxTokens: input.maxTokens ?? 1600,
  });
  const text = response.text.trim();
  if (!text) throw new Error("Loop agent LLM returned an empty response");
  return text;
}

async function runAssignedTools(input: LoopAgentInput): Promise<{
  sections: string[];
  draft?: LoopToolResult["draft"];
  toolsUsed: string[];
}> {
  const sections: string[] = [];
  const toolsUsed: string[] = [];
  let draft: LoopToolResult["draft"];

  for (const assignment of input.assignedTools) {
    const entry = getLoopTool(assignment.ref);
    if (!entry?.isActionable || entry.ref === "internal.llm_only") continue;

    if (entry.ref === "internal.memory_search") {
      const query = input.agent.task.slice(0, 500);
      const result = await recallMemories(query, input.auth, 5);
      toolsUsed.push(entry.ref);
      sections.push([
        "Memory search results:",
        ...result.memories.map((memory) => `- ${memory.text}`),
      ].join("\n"));
      continue;
    }

    if (entry.provider === "composio" && entry.requiresApproval) {
      const prepared = await completeText({
        system: `You prepare ${entry.label} content for human approval. Do not claim the external action happened.`,
        user: [
          `Goal: ${input.goal}`,
          `Task: ${input.agent.task}`,
          "Return JSON only with keys: subject, body, recipient_email (optional).",
        ].join("\n"),
        maxTokens: 1200,
      });
      let payload: Record<string, unknown> = { raw: prepared };
      try {
        payload = JSON.parse(prepared) as Record<string, unknown>;
      } catch {
        payload = { body: prepared };
      }
      toolsUsed.push(entry.ref);
      draft = buildDraftFromToolResults({
        goal: input.goal,
        toolRef: entry.ref,
        toolResult: payload,
      });
      sections.push(`Prepared ${entry.label} payload for approval:\n${JSON.stringify(payload, null, 2)}`);
    }
  }

  return { sections, draft, toolsUsed };
}

export async function runLoopAgent(input: LoopAgentInput): Promise<LoopToolResult> {
  const bindCtx = {
    auth: input.auth,
    goal: input.goal,
    agentName: input.agent.name,
    agentTask: input.agent.task,
    priorComments: input.priorComments.map((comment) => ({
      author: comment.author,
      body: comment.body,
    })),
    draftPolicy: input.draftPolicy,
  };

  const system = buildAgentSystemPrompt(bindCtx);
  let user = buildAgentUserPrompt(bindCtx);
  let draft: LoopToolResult["draft"];
  let toolsUsed: string[] = [];

  if (!hasOnlyLlmTools(input.assignedTools)) {
    const toolRun = await runAssignedTools(input);
    toolsUsed = toolRun.toolsUsed;
    draft = toolRun.draft;
    if (toolRun.sections.length > 0) {
      user = [user, "", ...toolRun.sections].join("\n");
    }
  }

  const text = await completeText({ system, user, maxTokens: 1800 });
  return {
    text,
    data: {
      model: aiProviderRegistry.chatModelName(),
      mode: hasOnlyLlmTools(input.assignedTools) ? "llm_only" : "tool_assisted",
      toolRefs: input.assignedTools.map((tool) => tool.ref),
      actionableToolRefs: actionableToolRefs(input.assignedTools),
      toolsUsed,
      contextCommentCount: input.priorComments.length,
    },
    draft,
  };
}
