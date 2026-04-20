import { aiProviderRegistry } from "../../providers/ai/index.js";
import type { MemoryType } from "../memory/memory-types.js";

export interface ConversationSummary {
  title: string;
  keyPoints: string[];
  decisions: string[];
  summary: string;
  memory_type?: MemoryType;
  category?: string | null;
  is_pinned_suggested?: boolean;
  preference_key?: string | null;
}

const SYSTEM_PROMPT = `You are a memory distiller. Given a conversation or session content, extract the essential information.
Rules:
- Max 5 key points
- Max 3 decisions (only include if actual decisions were made, otherwise empty array)
- Title should be descriptive but concise
- Summary should capture the essence of the conversation
- Do NOT include secrets like passwords or tokens
- Also classify the memory with:
  - memory_type: one of preference|fact|event|decision|note
  - category: short lowercase category label, or null
  - is_pinned_suggested: true when this should stay permanently visible in recalls
  - preference_key: optional stable key for preference conflicts (e.g. favorite_color, identity_name)`;

const SUMMARY_INPUT_CHAR_LIMIT = 4_000;
const SUMMARY_MAX_TOKENS = 400;

export async function summarizeConversation(
  content: string
): Promise<ConversationSummary> {
  const boundedContent = content.slice(0, SUMMARY_INPUT_CHAR_LIMIT);
  const response = await aiProviderRegistry.chat({
    model: aiProviderRegistry.chatModelName(),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Summarize this conversation:\n\n${boundedContent}` },
    ],
    responseFormat: "json_object",
    maxTokens: SUMMARY_MAX_TOKENS,
  });

  const text = response.text || "";

  try {
    const parsed = JSON.parse(text) as Partial<ConversationSummary>;
    return {
      title: typeof parsed.title === "string" && parsed.title.trim().length > 0
        ? parsed.title.trim()
        : "Untitled Session",
      keyPoints: Array.isArray(parsed.keyPoints)
        ? parsed.keyPoints.filter((value): value is string => typeof value === "string").slice(0, 5)
        : [],
      decisions: Array.isArray(parsed.decisions)
        ? parsed.decisions.filter((value): value is string => typeof value === "string").slice(0, 3)
        : [],
      summary: typeof parsed.summary === "string" && parsed.summary.trim().length > 0
        ? parsed.summary.trim()
        : text.slice(0, 500),
      memory_type: parsed.memory_type,
      category: typeof parsed.category === "string" ? parsed.category : null,
      is_pinned_suggested: Boolean(parsed.is_pinned_suggested),
      preference_key: typeof parsed.preference_key === "string" ? parsed.preference_key : null,
    };
  } catch {
    return {
      title: "Untitled Session",
      keyPoints: [text.slice(0, 200)],
      decisions: [],
      summary: text.slice(0, 500),
    };
  }
}
