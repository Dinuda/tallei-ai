export const MEMORY_TYPES = ["preference", "fact", "event", "decision", "note", "lesson", "failure", "checkpoint", "collab"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_TYPE_SET: ReadonlySet<string> = new Set<string>(MEMORY_TYPES);

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && MEMORY_TYPE_SET.has(value);
}

export function normalizeMemoryType(value: unknown, fallback: MemoryType = "fact"): MemoryType {
  return isMemoryType(value) ? value : fallback;
}
