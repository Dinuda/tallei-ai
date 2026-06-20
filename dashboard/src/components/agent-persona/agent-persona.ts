export type AgentPersonaUi = {
  displayName: string;
  roleKey: string;
  roleLabel: string;
  avatarSeed: string;
  avatarUrl?: string;
};

export function dicebearDylanUrl(seed: string): string {
  return `https://api.dicebear.com/10.x/dylan/svg?seed=${encodeURIComponent(seed)}`;
}

export function roleBadgeClass(roleKey: string): string {
  const map: Record<string, string> = {
    researcher: "bg-[#eff6ff] text-[#1d4ed8] border-[#bfdbfe]",
    analyst: "bg-[#f5f3ff] text-[#6d28d9] border-[#ddd6fe]",
    classifier: "bg-[#fff7ed] text-[#c2410c] border-[#fed7aa]",
    marketer: "bg-[#fdf2f8] text-[#be185d] border-[#fbcfe8]",
    writer: "bg-[#ecfdf5] text-[#047857] border-[#a7f3d0]",
    engineer: "bg-[#f0f9ff] text-[#0369a1] border-[#bae6fd]",
    reviewer: "bg-[#fffbeb] text-[#b45309] border-[#fde68a]",
    publisher: "bg-[#f0fdf4] text-[#15803d] border-[#bbf7d0]",
    coordinator: "bg-[#faf5ff] text-[#7e22ce] border-[#e9d5ff]",
    generalist: "bg-[#f3f4f6] text-[#374151] border-[#d1d5db]",
  };
  return map[roleKey] ?? map.generalist;
}

export function agentStatusLine(
  displayName: string,
  phase: "working" | "finished" | "queued" | "failed",
  task?: string,
): string {
  const firstName = displayName.split(/\s+/)[0] ?? displayName;
  if (phase === "working") return task ? `${firstName} is working on ${task}` : `${firstName} is working`;
  if (phase === "finished") return `${firstName} finished`;
  if (phase === "failed") return `${firstName} hit a blocker`;
  return `${firstName} is queued`;
}

export function toolRefToLabel(toolRef: string): string {
  if (toolRef === "internal.memory_search") return "Searching memory";
  if (toolRef === "internal.web_search") return "Searching the web";
  if (toolRef === "internal.llm_only") return "Reasoning";
  const segment = toolRef.split(".").pop() ?? toolRef;
  return segment.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function toolRefsToLabels(toolRefs: string[]): string[] {
  return [...new Set(toolRefs.map(toolRefToLabel))];
}
