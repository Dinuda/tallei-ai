import { llm as openai, llmModel } from "./llmClient.js";

export interface ConversationSummary {
  title: string;
  keyPoints: string[];
  decisions: string[];
  summary: string;
}

const SYSTEM_PROMPT = `You are a memory distiller. Given a conversation or session content, extract the essential information.
Rules:
- Max 5 key points
- Max 3 decisions (only include if actual decisions were made, otherwise empty array)
- Title should be descriptive but concise
- Summary should capture the essence of the conversation
- Do NOT include personal data like emails or passwords`;

export async function summarizeConversation(
  content: string
): Promise<ConversationSummary> {
  const response = await openai.chat.completions.create({
    model: llmModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Summarize this conversation:\n\n${content}` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "conversation_summary",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            keyPoints: { type: "array", items: { type: "string" } },
            decisions: { type: "array", items: { type: "string" } },
            summary: { type: "string" }
          },
          required: ["title", "keyPoints", "decisions", "summary"],
          additionalProperties: false
        },
        strict: true
      }
    }
  });

  const text = response.choices[0].message.content || "";

  try {
    const parsed = JSON.parse(text) as ConversationSummary;
    return parsed;
  } catch {
    return {
      title: "Untitled Session",
      keyPoints: [text.slice(0, 200)],
      decisions: [],
      summary: text.slice(0, 500),
    };
  }
}

