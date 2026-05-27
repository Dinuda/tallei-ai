import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { LoopToolKey } from "./types.js";

export interface LoopToolInput {
  goal: string;
  agentName: string;
  agentTask: string;
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

type LoopToolHandler = (input: LoopToolInput) => Promise<LoopToolResult>;

function commentsAsContext(comments: LoopToolInput["priorComments"]): string {
  if (comments.length === 0) return "No prior comments yet.";
  return comments
    .map((comment) => `[${comment.author}] ${comment.body}`)
    .join("\n\n")
    .slice(-12_000);
}

function firstCommentByAuthor(input: LoopToolInput, authorPattern: RegExp): string {
  return input.priorComments.find((comment) => authorPattern.test(comment.author))?.body ?? "";
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
    maxTokens: input.maxTokens ?? 1200,
  });
  const text = response.text.trim();
  if (!text) throw new Error("Loop tool LLM returned an empty response");
  return text;
}

const TOOL_REGISTRY: Record<LoopToolKey, LoopToolHandler> = {
  async research_topic(input) {
    const ceoStrategy = firstCommentByAuthor(input, /^ceo$/i);
    const text = await completeText({
      system: "You are a research specialist for a recurring content loop. Be specific, concise, and separate known facts from useful angles. Do not invent sources or claim live browsing.",
      user: [
        `Goal: ${input.goal}`,
        "",
        `CEO strategy:\n${ceoStrategy || "No CEO strategy comment was found."}`,
        "",
        `Your task:\n${input.agentTask}`,
        "",
        "Produce a research brief the next agent can safely use.",
      ].join("\n"),
    });
    return {
      text,
      data: {
        model: aiProviderRegistry.chatModelName(),
        contextCommentCount: input.priorComments.length,
      },
    };
  },

  async write_draft(input) {
    const context = commentsAsContext(input.priorComments);
    const text = await completeText({
      system: "You are a careful creative writer for a recurring content loop. Use the prior comments as source context, preserve uncertainty, and write a polished draft without making external commitments.",
      user: [
        `Goal: ${input.goal}`,
        "",
        `Your task:\n${input.agentTask}`,
        "",
        `Prior comments:\n${context}`,
        "",
        "Write the requested draft. Include a short notes section if any claims need verification.",
      ].join("\n"),
      maxTokens: 1800,
    });
    return {
      text,
      data: {
        model: aiProviderRegistry.chatModelName(),
        format: "newsletter_draft",
        contextCommentCount: input.priorComments.length,
      },
    };
  },

  async prepare_publication_plan(input) {
    const context = commentsAsContext(input.priorComments);
    const text = await completeText({
      system: "You are a publicist preparing an approval-only publication plan. Do not publish, send, schedule, or imply that an external action has happened.",
      user: [
        `Goal: ${input.goal}`,
        "",
        `Your task:\n${input.agentTask}`,
        "",
        `Prior comments:\n${context}`,
        "",
        "Prepare a concise publication plan for human approval. Include channel, audience, checklist, and the exact draft content or summary to approve.",
      ].join("\n"),
      maxTokens: 1600,
    });
    const payload = {
      goal: input.goal,
      approvalText: text,
      contextCommentCount: input.priorComments.length,
    };
    return {
      text,
      data: {
        model: aiProviderRegistry.chatModelName(),
        draftStatus: "pending_approval",
        action: "prepare_publication_plan",
      },
      draft: {
        kind: "publication_plan",
        summary: `Approve publication plan for ${input.goal}`,
        payload,
      },
    };
  },
};

export async function runLoopTool(toolKey: LoopToolKey, input: LoopToolInput): Promise<LoopToolResult> {
  return TOOL_REGISTRY[toolKey](input);
}
