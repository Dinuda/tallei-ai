import type { LoopArchitectOutput } from "./contracts.js";

export function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !["agent", "loop", "with", "from", "that", "this", "when", "then"].includes(word));
}

export function hasMeaningfulOverlap(haystack: string, needle: string): boolean {
  const normalized = haystack.toLowerCase();
  const tokens = words(needle);
  if (tokens.length === 0) return true;
  const requiredMatches = tokens.length >= 5 ? 2 : 1;
  let matches = 0;
  for (const token of tokens) {
    if (normalized.includes(token)) matches += 1;
    if (matches >= requiredMatches) return true;
  }
  return false;
}

export function isRecipientListAgent(agent: { gate?: { type?: string } }): boolean {
  return agent.gate?.type === "recipient_upload";
}

export function writesEmailLikeCopy(agent: {
  name: string;
  goal: string;
  task: string;
  outputContract: { description: string };
  gate?: { type?: string };
}): boolean {
  if (isRecipientListAgent(agent)) return false;
  return /\b(email|newsletter|broadcast|digest)\b/i.test(
    `${agent.name} ${agent.goal} ${agent.task} ${agent.outputContract.description}`,
  );
}

export function isArchitectStandaloneReviewAgent(agent: {
  id: string;
  name: string;
  goal: string;
  task: string;
  tool: string;
  renderTarget?: string;
  outputContract: { description: string };
}): boolean {
  if (agent.tool !== "internal.llm_only" || agent.renderTarget) return false;

  const nameId = `${agent.id} ${agent.name}`.toLowerCase();
  if (/\b(editorial|approval|qa)\b/.test(nameId) && /\b(review|qa|approval)\b/.test(nameId)) return true;
  if (/\b(review|qa|approval)\s+agent\b/.test(nameId)) return true;

  if (writesEmailLikeCopy(agent)) return false;

  const combined = `${agent.goal} ${agent.task}`.toLowerCase();
  return /\b(review|approve|qa)\b/.test(combined)
    && /\b(upstream|prior agent|writer output|synthesis output|without writ|editorial pass)\b/.test(combined);
}

export function designText(design: LoopArchitectOutput): string {
  return [
    design.title,
    design.summary,
    design.strategyText,
    ...design.inputsRequired,
    ...design.agents.flatMap((agent) => [
      agent.name,
      agent.goal,
      agent.task,
      agent.inputContract.description,
      agent.outputContract.description,
      JSON.stringify(agent.inputContract.schema),
      JSON.stringify(agent.outputContract.schema),
      ...(agent.doneCriteria ?? []),
      agent.gate?.question ?? "",
    ]),
  ].join("\n");
}
