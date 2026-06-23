import type { AgentPersonaRoleKey } from "../../contracts/spec-contracts.js";

export type AgentRoleDefinition = {
  roleKey: AgentPersonaRoleKey;
  roleLabel: string;
  skillSummary: string;
  keywords: string[];
};

export const AGENT_ROLE_CATALOG: AgentRoleDefinition[] = [
  { roleKey: "researcher", roleLabel: "Researcher", skillSummary: "Gather and synthesize information", keywords: ["research", "search", "recall", "monitor", "discover", "investigate"] },
  { roleKey: "analyst", roleLabel: "Analyst", skillSummary: "Analyze patterns and data", keywords: ["analyz", "metric", "trend", "report", "insight", "data"] },
  { roleKey: "classifier", roleLabel: "Classifier", skillSummary: "Categorize and route items", keywords: ["classif", "triage", "sort", "label", "categor", "route"] },
  { roleKey: "marketer", roleLabel: "Marketer", skillSummary: "Craft audience-facing messaging", keywords: ["market", "campaign", "audience", "promote", "brand", "outreach"] },
  { roleKey: "writer", roleLabel: "Writer", skillSummary: "Draft and refine content", keywords: ["write", "draft", "compose", "content", "copy", "author"] },
  { roleKey: "engineer", roleLabel: "Engineer", skillSummary: "Build and implement solutions", keywords: ["engineer", "implement", "code", "build", "develop", "technical"] },
  { roleKey: "reviewer", roleLabel: "Reviewer", skillSummary: "Validate quality and compliance", keywords: ["review", "validat", "check", "verify", "audit", "quality"] },
  { roleKey: "publisher", roleLabel: "Publisher", skillSummary: "Deliver and publish outputs", keywords: ["publish", "send", "post", "deliver", "distribute", "dispatch"] },
  { roleKey: "coordinator", roleLabel: "Coordinator", skillSummary: "Orchestrate handoffs", keywords: ["coordinate", "plan", "schedule", "orchestrat", "handoff", "manage"] },
  { roleKey: "generalist", roleLabel: "Specialist", skillSummary: "Execute assigned outcome", keywords: [] },
];

export const AGENT_DISPLAY_NAME_POOL = [
  "Maya",
  "Jordan",
  "Alex",
  "Sofia",
  "Riley",
  "Casey",
  "Quinn",
  "Jamie",
  "Taylor",
  "Drew",
  "Morgan",
  "Avery",
  "Cameron",
  "Reese",
  "Skyler",
  "Harper",
  "Elliot",
  "Rowan",
  "Sage",
  "Blake",
  "Finley",
  "Emery",
  "Kai",
  "Noor",
  "Remy",
  "Jules",
  "Arden",
  "River",
  "Lane",
  "Vera",
];

const TOOL_REF_ACTION_LABELS: Record<string, string> = {
  "internal.memory_search": "Searching memory",
  "internal.web_search": "Searching the web",
  "internal.llm_only": "Reasoning",
};

export function dicebearDylanUrl(seed: string): string {
  return `https://api.dicebear.com/10.x/dylan/svg?seed=${encodeURIComponent(seed)}`;
}

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function displayNameFromSeed(seed: string): string {
  const index = hashSeed(seed) % AGENT_DISPLAY_NAME_POOL.length;
  return AGENT_DISPLAY_NAME_POOL[index] ?? "Alex";
}

export function pickUniqueDisplayName(seed: string, index: number, used: Set<string>): string {
  const primary = displayNameFromSeed(seed);
  let start = AGENT_DISPLAY_NAME_POOL.indexOf(primary);
  if (start < 0) start = 0;
  for (let offset = 0; offset < AGENT_DISPLAY_NAME_POOL.length; offset += 1) {
    const candidate = AGENT_DISPLAY_NAME_POOL[(start + offset + index) % AGENT_DISPLAY_NAME_POOL.length]!;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = `Agent ${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

export function slugifyAgentId(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || `agent_${index + 1}`;
}

export function resolveAgentRole(name: string, goal: string): AgentRoleDefinition {
  const source = `${name} ${goal}`.toLowerCase();
  let best: AgentRoleDefinition = AGENT_ROLE_CATALOG.find((r) => r.roleKey === "generalist")!;
  let bestScore = 0;

  for (const role of AGENT_ROLE_CATALOG) {
    if (role.roleKey === "generalist") continue;
    let score = 0;
    for (const keyword of role.keywords) {
      if (source.includes(keyword)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = role;
    }
  }

  return best;
}

export function roleBadgeClass(roleKey: AgentPersonaRoleKey): string {
  const map: Record<AgentPersonaRoleKey, string> = {
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

export function inferActionLabelsFromToolRefs(toolRefs: string[]): string[] {
  const labels = new Set<string>();
  for (const ref of toolRefs) {
    if (TOOL_REF_ACTION_LABELS[ref]) {
      labels.add(TOOL_REF_ACTION_LABELS[ref]!);
      continue;
    }
    const lower = ref.toLowerCase();
    if (lower.includes("search") || lower.includes("read")) labels.add("Reading connected apps");
    else if (lower.includes("send") || lower.includes("post") || lower.includes("publish")) labels.add("Preparing delivery");
    else if (lower.includes("draft") || lower.includes("write") || lower.includes("email")) labels.add("Drafting content");
    else if (lower.includes("memory")) labels.add("Searching memory");
    else if (lower.includes("web")) labels.add("Searching the web");
  }
  if (labels.size === 0) labels.add("Reasoning");
  return [...labels];
}

export function agentStatusLine(displayName: string, phase: "working" | "finished" | "queued" | "failed", task?: string): string {
  const firstName = displayName.split(/\s+/)[0] ?? displayName;
  if (phase === "working") return task ? `${firstName} is working on ${task}` : `${firstName} is working`;
  if (phase === "finished") return `${firstName} finished`;
  if (phase === "failed") return `${firstName} hit a blocker`;
  return `${firstName} is queued`;
}
