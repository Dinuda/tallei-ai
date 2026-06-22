export const BUILDER_ISSUE_SUMMARY = "An issue occurred";

const USER_FACING_PATTERNS = [
  /temporary backend/i,
  /try again/i,
  /refresh the page/i,
  /ready to resend/i,
  /already saved in this builder session/i,
  /there was an issue while generating/i,
  /select at least one app/i,
  /did not finish/i,
  /backend infrastructure issue/i,
  /won't lose your progress/i,
];

const TECHNICAL_ISSUE_PATTERNS = [
  /violates foreign key constraint/i,
  /JSON parsing failed/i,
  /Invalid input for tool/i,
  /insert or update on table/i,
  /ERROR Invalid input/i,
  /SyntaxError:/i,
  /ZodError/i,
  /ECONNREFUSED/i,
  /loop_agent_avatars/i,
  /_fkey\b/i,
];

const LOGGED_MASKED_ISSUES = new Set<string>();
const MAX_LOGGED_MASKED_ISSUES = 200;

export type MaskBuilderIssueOptions = {
  context?: string;
  /** Defaults to true — set false in tests if needed. */
  log?: boolean;
};

export function isBuilderUserFacingIssueText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed === BUILDER_ISSUE_SUMMARY) return true;
  return USER_FACING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function looksLikeTechnicalIssueText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (TECHNICAL_ISSUE_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => TECHNICAL_ISSUE_PATTERNS.some((pattern) => pattern.test(line)));
}

/** Log masked builder errors once per context+message (browser devtools). */
export function logMaskedBuilderIssue(raw: string, context: string): void {
  const trimmed = raw.trim();
  if (!trimmed) return;

  const key = `${context}\0${trimmed}`;
  if (LOGGED_MASKED_ISSUES.has(key)) return;
  if (LOGGED_MASKED_ISSUES.size >= MAX_LOGGED_MASKED_ISSUES) {
    LOGGED_MASKED_ISSUES.clear();
  }
  LOGGED_MASKED_ISSUES.add(key);

  console.warn(`[loop-builder] ${context}:`, trimmed);
}

function resolveMaskOptions(options?: string | MaskBuilderIssueOptions): Required<MaskBuilderIssueOptions> {
  if (typeof options === "string") {
    return { context: options, log: true };
  }
  return {
    context: options?.context ?? "masked-issue",
    log: options?.log !== false,
  };
}

/** Remove leaked SQL / parse errors from assistant narration. */
export function stripTechnicalLinesFromText(
  text: string,
  options?: string | MaskBuilderIssueOptions,
): string {
  const { context, log } = resolveMaskOptions(
    typeof options === "string"
      ? { context: options }
      : { context: options?.context ?? "transcript-text", log: options?.log },
  );

  const removed: string[] = [];
  const kept = text
    .split(/\n+/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || !looksLikeTechnicalIssueText(trimmed)) return true;
      removed.push(trimmed);
      return false;
    })
    .join("\n")
    .trim();

  if (log) {
    for (const line of removed) {
      logMaskedBuilderIssue(line, context);
    }
  }

  if (!kept) return "";
  if (looksLikeTechnicalIssueText(kept)) {
    if (log) logMaskedBuilderIssue(kept, context);
    return "";
  }
  return kept;
}

/** Hide raw SQL, JSON parse, and other internal errors from the builder UI. */
export function maskBuilderIssueText(
  raw: string | null | undefined,
  options?: string | MaskBuilderIssueOptions,
): string {
  const { context, log } = resolveMaskOptions(options);
  const text = (raw ?? "").trim();
  if (!text) return BUILDER_ISSUE_SUMMARY;
  if (isBuilderUserFacingIssueText(text)) return text;
  if (log) logMaskedBuilderIssue(text, context);
  return BUILDER_ISSUE_SUMMARY;
}
