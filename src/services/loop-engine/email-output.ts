const BOILERPLATE_LINE_PATTERNS = [
  /^(?:here(?:'|')s|here is) a ready-to-send\b/i,
  /\bready-to-send internal sync email draft\b/i,
  /\bdraft you can use\b/i,
  /\bi(?:'|')ve kept placeholders\b/i,
  /\bplaceholders? for recipients and sender name\b/i,
  /\bdrop in your (?:gmail list|name|signature|recipient list)\b/i,
  /\bapproved and ready to send\b/i,
  /\bfinal preview\b.*\bready to send\b/i,
  /^html-friendly version\b/i,
  /^sending plan and required confirmations\b/i,
  /^recipients:\s*/i,
  /^permissions:\s*/i,
  /^confirm send:\s*/i,
  /\beither a csv file\b/i,
  /\bor an audience[_ ]id\b/i,
  /\bconfigured audience[_ ]id\b/i,
  /\brecipient rows\b/i,
  /\bif you want,? i can\b/i,
  /\bi(?:'|')ll use the uploaded contacts csv\b/i,
  /\bi(?:'|')ll verify you(?:'|')re authorized\b/i,
  /\bi(?:'|')ll run format checks\b/i,
  /\bconfirm\.send\b/i,
];

const PLACEHOLDER_TOKEN_PATTERNS = [
  /\[(?:paste|tbd|todo|fill|insert)[^\]]*\]/ig,
  /\[(?:your|sender|recipient|name|email|signature|contact|audience|list)[^\]]*\]/ig,
  /\{\{[^}]+\}\}/g,
  /<<[^>]+>>/g,
];

function normalizeComparableText(value: string): string {
  return value.replace(/’/g, "'").trim().replace(/\s+/g, " ").toLowerCase();
}

function stripMarkdownBulletPrefix(line: string): string {
  return line.replace(/^\s*[•*-]\s*/, "");
}

function isBoilerplateLine(line: string): boolean {
  const normalized = normalizeComparableText(stripMarkdownBulletPrefix(line));
  if (!normalized) return false;
  return BOILERPLATE_LINE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isRawHtmlLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;
  return /^<!--/.test(normalized)
    || /<\/?[a-z][\w:-]*(?:\s[^>]*)?>/i.test(normalized);
}

function stripPlaceholderTokens(line: string): string {
  let next = line;
  for (const pattern of PLACEHOLDER_TOKEN_PATTERNS) {
    next = next.replace(pattern, "");
  }
  return next
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])([A-Za-z0-9])/g, "$1 $2")
    .trim();
}

export function unwrapEmailMarkdownEnvelope(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return value;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["text", "markdown", "body", "content"]) {
      const candidate = parsed[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  } catch {
    return value;
  }
  return value;
}

export function sanitizeEmailMarkdown(markdown: string): string {
  const normalized = unwrapEmailMarkdownEnvelope(markdown).replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const paragraphs = normalized.split(/\n{2,}/);
  const kept: string[] = [];

  for (const paragraph of paragraphs) {
    const lines = paragraph.split("\n");
    if (lines.some((line) => isBoilerplateLine(line) || isRawHtmlLine(line))) continue;

    const cleanedLines = lines
      .map((line) => stripPlaceholderTokens(line))
      .filter((line) => line.length > 0);

    if (cleanedLines.length === 0) continue;

    const cleanedParagraph = cleanedLines.join("\n").trim();
    if (!cleanedParagraph || isBoilerplateLine(cleanedParagraph) || isRawHtmlLine(cleanedParagraph)) continue;
    kept.push(cleanedParagraph);
  }

  return kept.join("\n\n").trim();
}

export function sanitizeEmailText(text: string): string {
  const cleaned = stripPlaceholderTokens(text.trim());
  return isBoilerplateLine(cleaned) ? "" : cleaned;
}

export function containsEmailBoilerplate(text: string): boolean {
  const normalized = normalizeComparableText(text);
  if (!normalized) return false;
  const sanitized = normalizeComparableText(sanitizeEmailMarkdown(text));
  return sanitized !== normalized;
}
