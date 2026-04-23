export const FACT_EXTRACTOR_PROMPT_TEMPLATE = `Extract up to 10 atomic facts, lessons, and failures from this conversation.

For each item return a JSON object with:
- text: the fact/lesson/failure in one self-contained sentence
- subject: the primary entity or topic (e.g. "API rate limit", "deploy pipeline", "user")
- temporal_context: null or a time expression (e.g. "2024-Q3", "last month")
- supersedes_pattern: null or a short description of what older belief this replaces
- memory_type: one of "fact" | "lesson" | "failure"

Use memory_type = "lesson" for durable best-practices, rules of thumb, or accumulated guidance
derived from experience. Examples: "never batch more than 50 records — the API times out",
"always run migrations on a separate connection before deploying".

Use memory_type = "failure" for specific incidents, outages, regressions, or errors that
actually happened. Examples: "deploy broke due to encoding mismatch on 2024-11-01",
"API timed out because batch size exceeded 50 records in production".

Use memory_type = "fact" for all other atomic facts, preferences, or profile information.

Return only a JSON array. No prose, no markdown fences.`;
