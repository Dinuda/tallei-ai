import type { LoopToolKey } from "./types.js";

export interface LoopToolInput {
  goal: string;
  agentName: string;
  agentTask: string;
  priorOutputs: Array<{ agentId: string; agentName: string; output: unknown }>;
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

const TOOL_REGISTRY: Record<LoopToolKey, LoopToolHandler> = {
  async research_topic(input) {
    return {
      text: [
        `Research brief for: ${input.goal}`,
        "",
        `Task: ${input.agentTask}`,
        "",
        "Findings:",
        "- Identify the target reader and the product promise before writing.",
        "- Gather recent product context, customer questions, release notes, and competitive references.",
        "- Separate facts from angles so the writer can draft without inventing claims.",
      ].join("\n"),
      data: {
        sources: ["product context", "customer questions", "release notes", "competitive references"],
        freshness: "internal_v1_placeholder",
      },
    };
  },

  async write_draft(input) {
    const research = input.priorOutputs.map((item) => item.output).slice(-1)[0];
    return {
      text: [
        `Draft for: ${input.goal}`,
        "",
        "Subject: This week's product story",
        "",
        "Hi there,",
        "",
        "This week, the story is about turning the product's strongest proof points into a clear, useful update. The draft should open with the user's problem, explain what changed, and close with one concrete next step.",
        "",
        "Working notes:",
        typeof research === "string" ? research : JSON.stringify(research).slice(0, 900),
      ].join("\n"),
      data: {
        format: "newsletter_draft",
        usedPriorOutputCount: input.priorOutputs.length,
      },
    };
  },

  async prepare_publication_plan(input) {
    const draft = input.priorOutputs.map((item) => item.output).slice(-1)[0];
    const payload = {
      goal: input.goal,
      draft,
      checklist: [
        "Confirm claims and links.",
        "Review tone and audience fit.",
        "Choose channel and send time.",
        "Approve before publishing or sending.",
      ],
    };
    return {
      text: [
        `Publication draft prepared for: ${input.goal}`,
        "",
        "Status: pending approval",
        "",
        "The publicist prepared a publication plan only. No external channel was contacted.",
      ].join("\n"),
      data: {
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
