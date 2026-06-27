const FILLER_PREFIX =
  /^(please\s+)?(i\s+(want\s+to|need\s+to|would\s+like\s+to)\s+)?((create|build|make)\s+(a\s+)?)?(loop\s+(that\s+|to\s+)?)?/i;

/** Derive a short loop title from the user's natural-language prompt. */
export function deriveLoopNameFromPrompt(prompt: string, maxLen = 60): string {
  const raw = prompt.trim().replace(/\s+/g, " ");
  if (!raw) return "New loop";

  const firstLine = raw.split(/\n/)[0]?.trim() ?? raw;
  const sentence = firstLine.split(/(?<=[.!?])\s+/)[0]?.trim() ?? firstLine;
  let name = sentence.replace(FILLER_PREFIX, "").trim();
  if (!name) name = firstLine;

  if (name.length > maxLen) {
    const truncated = name.slice(0, maxLen);
    const lastSpace = truncated.lastIndexOf(" ");
    name = (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated).trim();
  }

  name = name.replace(/[.!?,:;]+$/, "").trim();
  if (!name) return "New loop";
  return name.charAt(0).toUpperCase() + name.slice(1);
}
