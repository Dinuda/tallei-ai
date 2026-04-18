import { llm, llmModel } from "./llmClient.js";

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

const SUMMARY_INPUT_CHAR_LIMIT = 4_000;
const SUMMARY_TIMEOUT_MS = 8_000;
const SUMMARY_MAX_TOKENS = 400;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function summarizeConversation(
  content: string
): Promise<ConversationSummary> {
  const boundedContent = content.slice(0, SUMMARY_INPUT_CHAR_LIMIT);
  const response = await withTimeout(
    llm.chat.completions.create({
      model: llmModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Summarize this conversation:\n\n${boundedContent}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: SUMMARY_MAX_TOKENS,
    }),
    SUMMARY_TIMEOUT_MS,
    "summarizeConversation"
  );

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
