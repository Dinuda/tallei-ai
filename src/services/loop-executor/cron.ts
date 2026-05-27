const CRON_PARTS = 5;

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

export function validateFiveFieldCron(expression: string): string {
  const normalized = expression.trim().replace(/\s+/g, " ");
  const fields = normalized.split(" ");
  if (fields.length !== CRON_PARTS) {
    throw new Error("Schedule must be a standard 5-field cron expression");
  }

  parseField(fields[0], 0, 59);
  parseField(fields[1], 0, 23);
  parseField(fields[2], 1, 31);
  parseField(fields[3], 1, 12);
  parseField(fields[4], 0, 7, { normalizeSevenToZero: true });
  return normalized;
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
