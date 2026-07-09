export type PresentReplyOption = {
  id: string;
  label: string;
  message: string;
};

const DECLINE_OPTION_TOKENS = new Set([
  "hold",
  "change",
  "cancel",
  "not_yet",
  "not-yet",
  "notyet",
  "wait",
  "later",
  "no",
  "decline",
  "defer",
]);

const CONFIRM_OPTION_TOKENS = new Set([
  "yes",
  "activate",
  "confirm",
  "continue",
  "proceed",
  "go",
  "live",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function tokenMatchesAny(token: string, candidates: Set<string>): boolean {
  const normalized = normalizeToken(token);
  if (candidates.has(normalized)) return true;
  return [...candidates].some((candidate) =>
    normalized === candidate
    || normalized.includes(candidate)
    || candidate.includes(normalized));
}

function isDeclineToken(token: string): boolean {
  return tokenMatchesAny(token, DECLINE_OPTION_TOKENS);
}

function isConfirmToken(token: string): boolean {
  if (isDeclineToken(token)) return false;
  return tokenMatchesAny(token, CONFIRM_OPTION_TOKENS);
}

function parsePresentReplyOptions(input: unknown): PresentReplyOption[] {
  if (!isRecord(input) || !Array.isArray(input.options)) return [];
  return input.options.flatMap((option) => {
    if (!isRecord(option)) return [];
    const id = String(option.id ?? "").trim();
    const label = String(option.label ?? "").trim();
    const message = String(option.message ?? label).trim();
    if (!id || !label) return [];
    return [{ id, label, message }];
  });
}

function optionById(options: PresentReplyOption[], selectedOptionId: string): PresentReplyOption | null {
  const trimmed = selectedOptionId.trim();
  if (!trimmed) return null;
  return options.find((option) => option.id === trimmed) ?? null;
}

function messageImpliesActivation(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (/\b(hold|wait|later|not yet|cancel|change)\b/.test(normalized)) return false;
  return /\b(activate|go live|yes|confirm|proceed|continue)\b/.test(normalized);
}

/** Whether a presentReplyOptions reply counts as explicit activation approval. */
export function isActivationConfirmationReply(output: unknown, input?: unknown): boolean {
  if (!isRecord(output)) return false;

  const selectedValues = Array.isArray(output.selectedValues)
    ? output.selectedValues.map((value) => String(value))
    : [];
  if (selectedValues.some((value) => isConfirmToken(value))) return true;
  if (selectedValues.some((value) => isDeclineToken(value))) return false;

  const selectedOptionId = typeof output.selectedOptionId === "string"
    ? output.selectedOptionId.trim()
    : "";
  const message = typeof output.message === "string" ? output.message.trim() : "";
  const options = parsePresentReplyOptions(input);

  if (selectedOptionId) {
    if (isDeclineToken(selectedOptionId)) return false;
    if (isConfirmToken(selectedOptionId)) return true;
    const selected = optionById(options, selectedOptionId);
    if (selected) {
      if (isDeclineToken(selected.id) || isDeclineToken(selected.label) || isDeclineToken(selected.message)) {
        return false;
      }
      if (isConfirmToken(selected.id) || isConfirmToken(selected.label) || messageImpliesActivation(selected.message)) {
        return true;
      }
    }
  }

  if (messageImpliesActivation(message)) return true;

  return false;
}

/** Pick the best activation option from presentReplyOptions input for stall Continue routing. */
export function findActivationReplyOption(input: unknown): PresentReplyOption | null {
  const options = parsePresentReplyOptions(input);
  if (options.length === 0) return null;

  const preferred = options.find((option) =>
    isConfirmToken(option.id)
    || isConfirmToken(option.label)
    || messageImpliesActivation(option.message)
    || messageImpliesActivation(option.label));
  if (preferred && !isDeclineToken(preferred.id) && !isDeclineToken(preferred.label)) {
    return preferred;
  }

  const nonDecline = options.find((option) =>
    !isDeclineToken(option.id) && !isDeclineToken(option.label));
  return nonDecline ?? null;
}
