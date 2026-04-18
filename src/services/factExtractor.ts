import { llm, llmModel } from "./llmClient.js";

export interface ExtractedFact {
  text: string;
  subject: string;
  temporal_context: string | null;
  supersedes_pattern: string | null;
}

const SYSTEM_PROMPT = `You are a memory extraction system. Extract atomic facts from the conversation.

Rules:
- ONLY ADD new facts. Never replace or overwrite — temporal history must be preserved.
- Embed temporal context directly into the fact when relevant (e.g. "moved to San Francisco from New York" not "lives in San Francisco").
- Extract facts from BOTH user and assistant turns — agent-generated observations are valuable.
- Each fact must be a single, self-contained statement a person could act on later.
- If a fact likely supersedes a common stored pattern (e.g. new location, new job), set supersedes_pattern to a keyword or phrase that identifies the old fact.
- Omit pleasantries, filler, repeated info, and opinions without factual content.
- Maximum 10 facts per extraction.
- Return JSON only: {"facts":[{"text":"...","subject":"...","temporal_context":null,"supersedes_pattern":null}]}.`;

export async function extractFacts(content: string): Promise<ExtractedFact[]> {
  try {
    const response = await llm.chat.completions.create({
      model: llmModel,
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Extract facts from this conversation:\n\n${content.slice(0, 4000)}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { facts: ExtractedFact[] };
    return Array.isArray(parsed.facts) ? parsed.facts : [];
  } catch {
    return [];
  }
}
