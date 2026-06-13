const CRON_PARTS = 5;
const DEFAULT_DESIGN_CRON = "0 9 * * 1";

const DOW_NAME_TO_CRON: Record<string, string> = {
  sun: "0",
  sunday: "0",
  mon: "1",
  monday: "1",
  tue: "2",
  tues: "2",
  tuesday: "2",
  wed: "3",
  weds: "3",
  wednesday: "3",
  thu: "4",
  thur: "4",
  thurs: "4",
  thursday: "4",
  fri: "5",
  friday: "5",
  sat: "6",
  saturday: "6",
};

function normalizeDowToken(token: string): string {
  const key = token.trim().toLowerCase();
  return DOW_NAME_TO_CRON[key] ?? token;
}

function normalizeDowField(raw: string): string {
  return raw.split(",").map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return trimmed;
    const [rangePart, stepPart] = trimmed.split("/");
    const step = stepPart ? `/${stepPart}` : "";
    if (rangePart === "*") return `${rangePart}${step}`;
    if (rangePart.includes("-")) {
      const [start, end] = rangePart.split("-");
      return `${normalizeDowToken(start)}-${normalizeDowToken(end)}${step}`;
    }
    return `${normalizeDowToken(rangePart)}${step}`;
  }).join(",");
}

function normalizeCronFields(fields: string[]): string[] {
  if (fields.length !== CRON_PARTS) return fields;
  return [
    ...fields.slice(0, 4),
    normalizeDowField(fields[4]),
  ];
}

function parseField(raw: string, min: number, max: number, options?: { normalizeSevenToZero?: boolean }): Set<number> {
  const values = new Set<number>();
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Cron field cannot be empty");

  for (const part of parts) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${part}`);

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = Number.parseInt(rawStart, 10);
      end = Number.parseInt(rawEnd, 10);
    } else {
      start = Number.parseInt(rangePart, 10);
      end = start;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid cron field: ${part}`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(options?.normalizeSevenToZero && value === 7 ? 0 : value);
    }
  }

  return values;
}

/**
 * Coerce LLM/designer cron output into a valid 5-field expression.
 * Falls back to Monday 09:00 UTC when the value cannot be parsed.
 */
export function normalizeDesignCron(expression: string, sourceText = ""): string {
  let raw = expression.trim().replace(/\s+/g, " ");
  if (!raw) return DEFAULT_DESIGN_CRON;

  if (raw.startsWith("@")) {
    const preset = raw.toLowerCase();
    if (preset === "@daily") raw = "0 9 * * *";
    else if (preset === "@weekly") raw = "0 9 * * 1";
    else if (preset === "@monthly") raw = "0 9 1 * *";
    else if (preset === "@hourly") raw = "0 * * * *";
  }

  let fields = raw.split(" ").filter(Boolean);
  if (fields.length === 6) {
    fields = fields.slice(1);
  }

  if (fields.length === 5) {
    fields = normalizeCronFields(fields);
    raw = fields.join(" ");
  }

  try {
    return validateFiveFieldCron(raw);
  } catch {
    const hint = `${expression} ${sourceText}`.toLowerCase();
    if (/\bmonthly\b/.test(hint)) return validateFiveFieldCron("0 9 1 * *");
    if (/\bfriday\b/.test(hint)) return validateFiveFieldCron("0 9 * * 5");
    if (/\bdaily\b/.test(hint)) return validateFiveFieldCron("0 9 * * *");
    if (/\bweekly\b/.test(hint)) return validateFiveFieldCron("0 9 * * 1");
    return DEFAULT_DESIGN_CRON;
  }
}

export function validateFiveFieldCron(expression: string): string {
  const normalized = expression.trim().replace(/\s+/g, " ");
  let fields = normalized.split(" ");
  if (fields.length !== CRON_PARTS) {
    throw new Error("Schedule must be a standard 5-field cron expression");
  }
  fields = normalizeCronFields(fields);
  const cron = fields.join(" ");

  parseField(fields[0], 0, 59);
  parseField(fields[1], 0, 23);
  parseField(fields[2], 1, 31);
  parseField(fields[3], 1, 12);
  parseField(fields[4], 0, 7, { normalizeSevenToZero: true });
  return cron;
}

function fieldIsWildcard(raw: string): boolean {
  return raw === "*" || raw.startsWith("*/");
}

function matchesCron(date: Date, expression: string): boolean {
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = validateFiveFieldCron(expression).split(" ");
  const minute = parseField(minuteRaw, 0, 59);
  const hour = parseField(hourRaw, 0, 23);
  const dayOfMonth = parseField(domRaw, 1, 31);
  const month = parseField(monthRaw, 1, 12);
  const dayOfWeek = parseField(dowRaw, 0, 7, { normalizeSevenToZero: true });

  if (!minute.has(date.getUTCMinutes())) return false;
  if (!hour.has(date.getUTCHours())) return false;
  if (!month.has(date.getUTCMonth() + 1)) return false;

  const domMatches = dayOfMonth.has(date.getUTCDate());
  const dowMatches = dayOfWeek.has(date.getUTCDay());
  const domWildcard = fieldIsWildcard(domRaw);
  const dowWildcard = fieldIsWildcard(dowRaw);

  if (!domWildcard && !dowWildcard) return domMatches || dowMatches;
  if (!domWildcard) return domMatches;
  if (!dowWildcard) return dowMatches;
  return true;
}

export function nextCronRunAt(expression: string, from = new Date()): Date {
  const normalized = validateFiveFieldCron(expression);
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const maxMinutes = 366 * 24 * 60 * 5;
  for (let i = 0; i < maxMinutes; i += 1) {
    if (matchesCron(cursor, normalized)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  throw new Error("Could not find next cron run within five years");
}
