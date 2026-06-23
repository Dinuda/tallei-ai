import type { NoSlopSpec } from "../contracts/spec-contracts.js";
import {
  selectedExternalDataToolkits,
  selectedGroundingSources,
} from "../domain/build-contract.js";

function title(purpose: string): string {
  const normalized = purpose.trim().replace(/\s+/g, " ");
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized || "Loop spec";
}

export function renderSpecMarkdown(spec: NoSlopSpec): string {
  const lines = [
    `# ${title(spec.purpose)}`,
    "",
    "## Purpose",
    spec.purpose,
    "",
    "## Agents",
  ];

  for (const agent of spec.agents) {
    lines.push("", `### ${agent.name}`, `- Goal: ${agent.goal}`);
    if (agent.tools.length > 0) lines.push(`- Tools: ${agent.tools.join(", ")}`);
    for (const guardrail of agent.guardrails) lines.push(`- Guardrail: ${guardrail}`);
    for (const done of agent.doneWhen) lines.push(`- Done when: ${done}`);
  }

  lines.push("", "## Success Criteria");
  for (const criterion of spec.successCriteria) lines.push(`- ${criterion}`);

  lines.push("", "## Delivery");
  if (spec.delivery.provider === "none") {
    lines.push("Dashboard only.");
  } else {
    lines.push(`${spec.delivery.provider}: ${spec.delivery.description}`);
  }

  if (spec.buildContract) {
    const grounding = selectedGroundingSources(spec.buildContract);
    const external = selectedExternalDataToolkits(spec.buildContract);
    if (grounding.length > 0 || external.length > 0) {
      lines.push("", "## Grounding");
      for (const source of grounding) lines.push(`- ${source.type}`);
      for (const toolkit of external) lines.push(`- composio.${toolkit}.search`);
    }
  }

  return lines.join("\n");
}
