import { loopContactRowSchema, type LoopContactRow } from "./types.js";

const MAX_CONTACT_ROWS = 5_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function rowFromCells(cells: string[], emailIndex: number, nameIndex: number): LoopContactRow | null {
  const email = cells[emailIndex]?.trim().toLowerCase() ?? "";
  if (!email || !EMAIL_PATTERN.test(email)) return null;
  const name = nameIndex >= 0 ? cells[nameIndex]?.trim() : "";
  const parsed = loopContactRowSchema.safeParse({ email, ...(name ? { name } : {}) });
  return parsed.success ? parsed.data : null;
}

export function parseContactListCsv(text: string): LoopContactRow[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Contact list is empty.");

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("Contact list is empty.");

  const firstCells = parseCsvLine(lines[0]);
  const headers = firstCells.map(normalizeHeader);
  const emailIndex = headers.findIndex((header) => header === "email" || header === "email_address");
  const nameIndex = headers.findIndex((header) => header === "name" || header === "full_name");

  const contacts: LoopContactRow[] = [];
  const seen = new Set<string>();
  const dataLines = emailIndex >= 0 ? lines.slice(1) : lines;

  for (const line of dataLines) {
    const cells = parseCsvLine(line);
    if (cells.every((cell) => !cell.trim())) continue;

    let row: LoopContactRow | null = null;
    if (emailIndex >= 0) {
      row = rowFromCells(cells, emailIndex, nameIndex);
    } else if (cells.length === 1) {
      row = rowFromCells([cells[0]], 0, -1);
    } else {
      row = rowFromCells(cells, 0, cells.length > 1 ? 1 : -1);
    }
    if (!row || seen.has(row.email.toLowerCase())) continue;
    seen.add(row.email.toLowerCase());
    contacts.push(row);
    if (contacts.length > MAX_CONTACT_ROWS) {
      throw new Error(`Contact list exceeds the maximum of ${MAX_CONTACT_ROWS} rows.`);
    }
  }

  if (contacts.length === 0) {
    throw new Error("No valid email addresses found. CSV must include an email column or one email per line.");
  }
  return contacts;
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

export function contactsToCsv(contacts: LoopContactRow[]): string {
  const lines = ["email,name"];
  for (const contact of contacts) {
    lines.push(`${escapeCsvCell(contact.email)},${escapeCsvCell(contact.name ?? "")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseContactListText(text: string): LoopContactRow[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("Contact list is empty.");
  if (lines.some((line) => line.includes(","))) return parseContactListCsv(text);
  return parseContactListCsv(lines.join("\n"));
}
