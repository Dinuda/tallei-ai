export const BUILDER_ISSUE_SUMMARY = "Something went wrong while updating your loop. Try again or adjust your request.";

const TECHNICAL_PATTERNS = [
  /violates foreign key constraint/i,
  /JSON parsing failed/i,
  /Invalid input for tool/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /insert or update on table/i,
];

export function isBuilderUserFacingIssueText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !TECHNICAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function maskBuilderIssueText(
  text: string,
  options?: { log?: boolean; context?: string } | string,
): string {
  const opts = typeof options === "string" ? { context: options } : options;
  if (isBuilderUserFacingIssueText(text)) return text;
  if (opts?.log !== false) {
    logMaskedBuilderIssue(text, opts?.context ?? "builder");
  }
  return BUILDER_ISSUE_SUMMARY;
}

export function stripTechnicalLinesFromText(
  text: string,
  options?: { log?: boolean; context?: string },
): string {
  const lines = text.split("\n").filter((line) => isBuilderUserFacingIssueText(line));
  const joined = lines.join("\n").trim();
  if (!joined && text.trim()) {
    if (options?.log !== false) {
      logMaskedBuilderIssue(text, options?.context ?? "builder");
    }
    return "";
  }
  return joined;
}

const loggedIssues = new Set<string>();

export function logMaskedBuilderIssue(message: string, context: string): void {
  const key = `${context}:${message}`;
  if (loggedIssues.has(key)) return;
  loggedIssues.add(key);
  console.warn(`[builder-issue] ${context}:`, message);
}
