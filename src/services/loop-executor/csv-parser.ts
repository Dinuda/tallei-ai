/**
 * csv-parser.ts — Generic CSV parsing for contact lists and structured input.
 */

export function parseContactListCsv(csv: string) {
  const lines = csv.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const splitRow = (line: string) => {
    if (line.includes(",") && !line.includes("\t")) {
      return line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
    }
    if (line.includes("\t")) return line.split("\t").map((cell) => cell.trim());
    if (line.includes(";")) return line.split(";").map((cell) => cell.trim());
    return [line.trim()];
  };
  const header = splitRow(lines[0]).map((cell) => cell.toLowerCase());
  const emailIdx = header.findIndex((cell) => cell === "email" || cell === "email_address");
  const nameIdx = header.findIndex((cell) => cell === "name" || cell === "full_name");
  const dataLines = emailIdx >= 0 ? lines.slice(1) : lines;
  const effectiveEmailIdx = emailIdx >= 0 ? emailIdx : 0;
  const contacts: Array<{ email: string; name?: string }> = [];
  const seen = new Set<string>();
  for (const line of dataLines) {
    const cells = splitRow(line);
    const email = cells[effectiveEmailIdx]?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    const name = nameIdx >= 0 ? cells[nameIdx]?.trim() : undefined;
    contacts.push({ email, ...(name ? { name } : {}) });
  }
  if (contacts.length === 0) {
    throw new Error("Recipient list must include at least one valid email address");
  }
  return contacts.slice(0, 5000);
}
