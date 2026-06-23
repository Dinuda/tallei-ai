/** Repair common LLM JSON mistakes before tool input validation. */

export function tryParseJsonWithClosingBraces(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  for (let extraBraces = 0; extraBraces <= 6; extraBraces += 1) {
    try {
      return JSON.parse(`${trimmed}${"}".repeat(extraBraces)}`);
    } catch {
      // try with more closing braces
    }
  }
  return null;
}

/** `," body":` inside a broken string → `","body":` */
export function repairPrematureStringTermination(text: string): string {
  return text.replace(/,"\s+([A-Za-z_][A-Za-z0-9_]*)\s*":/g, '","$1":');
}

/** `," body":` → `,"body":` */
export function repairUnquotedJsonKeys(text: string): string {
  return text.replace(/,\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g, ',"$1":');
}

/** `"value" "nextKey":` → `"value","nextKey":` */
export function repairMissingCommasBeforeQuotedKeys(text: string): string {
  return text.replace(/"\s+(?="[A-Za-z_])/g, '",');
}

function uniqueCandidates(text: string): string[] {
  const trimmed = text.trim();
  const repaired = [
    trimmed,
    repairPrematureStringTermination(trimmed),
    repairUnquotedJsonKeys(trimmed),
    repairMissingCommasBeforeQuotedKeys(trimmed),
    repairUnquotedJsonKeys(repairPrematureStringTermination(trimmed)),
    repairUnquotedJsonKeys(repairMissingCommasBeforeQuotedKeys(trimmed)),
    repairPrematureStringTermination(repairUnquotedJsonKeys(trimmed)),
  ];
  return [...new Set(repaired)];
}

export function tryParseToolInputJson(text: string): unknown | null {
  for (const candidate of uniqueCandidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
    const closed = tryParseJsonWithClosingBraces(candidate);
    if (closed !== null) return closed;
  }
  return null;
}

export function repairToolInputJsonString(text: string): string | null {
  const parsed = tryParseToolInputJson(text);
  if (parsed === null) return null;
  return JSON.stringify(parsed);
}
