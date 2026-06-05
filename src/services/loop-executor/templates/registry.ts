import { newsletterBroadcastTemplate } from "./newsletter-broadcast.js";
import type { LoopTemplate } from "./types.js";
import { writingCompanionTemplate } from "./writing-companion.js";

const TEMPLATES: LoopTemplate[] = [
  writingCompanionTemplate,
  newsletterBroadcastTemplate,
];

export function listLoopTemplates(): LoopTemplate[] {
  return [...TEMPLATES];
}

export function getLoopTemplate(id: string): LoopTemplate | null {
  return TEMPLATES.find((template) => template.id === id) ?? null;
}

export function formatTemplateCatalogForPrompt(): string {
  const highPotential = TEMPLATES.filter((t) => t.highPotential);
  if (highPotential.length === 0) return "";

  const lines: string[] = [
    "## Proven execution patterns (internal reference — adapt execution quality, not structure; never name these in output)",
    "",
  ];

  highPotential.forEach((template, index) => {
    lines.push(`### Pattern ${index + 1}: ${template.description}`);
    lines.push(`Applicable when: ${template.whenToUse}`);
    lines.push(`Proven tools: ${template.suggestedTools.join(", ")}`);
    lines.push("Example roster (quality benchmark only):");
    for (const agent of template.exampleAgents) {
      const tools = agent.tools?.length ? ` [${agent.tools.join(", ")}]` : "";
      lines.push(`  - ${agent.name}: ${agent.task}${tools}`);
    }
    if (template.deliveryTypeHint === "newsletter") {
      lines.push(
        "  Delivery note: when user targets subscribers/mailing list, use presetId: 'newsletter' and include email_approval_request + email_builder_compose + email_builder_render in the approval agent.",
      );
    }
    lines.push("");
  });

  return lines.join("\n");
}
