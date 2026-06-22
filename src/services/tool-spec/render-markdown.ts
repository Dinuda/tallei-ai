import type { ToolContract, ToolSpecRegistry, ToolUseCase } from "./types.js";

export function renderToolSpecMarkdown(registry: ToolSpecRegistry, phase: "outcomes" | "tools"): string {
  if (phase === "outcomes") {
    return renderOutcomesPhase(registry);
  }
  return renderToolsPhase(registry);
}

function renderOutcomesPhase(registry: ToolSpecRegistry): string {
  const lines: string[] = [
    "=== AVAILABLE CAPABILITIES ===",
    "",
    "You can design loops using these capabilities. Do not reference specific tool names yet — that comes later when assigning tools to agents.",
    "",
  ];

  lines.push("## Internal Capabilities");
  lines.push("");
  for (const tool of registry.internalTools) {
    lines.push(`### ${tool.label}`);
    lines.push(tool.description);
    lines.push("");
    lines.push("**What it produces:** " + tool.outputDescription);
    lines.push("");
    if (tool.useCases.length > 0) {
      lines.push("**When to use:**");
      for (const uc of tool.useCases) {
        lines.push(`- ${uc}`);
      }
      lines.push("");
    }
    if (tool.contract) {
      lines.push(`**Skills:** ${tool.contract.skillTags.join(", ")}`);
      lines.push(`**Resources:** ${tool.contract.resources.join(", ")}`);
      lines.push(`**Effect:** ${tool.contract.effect}`);
      lines.push("");
    }
    if (tool.shortCircuits) {
      lines.push("**Important:** This tool short-circuits — raw output is returned directly without LLM synthesis. Agents using this tool must have goals about the raw output itself, not about synthesized content.");
      lines.push("");
    }
  }

  lines.push("## Connected App Capabilities");
  lines.push("");
  if (registry.composioToolkits.length === 0) {
    lines.push("No connected apps available. Loops can only use internal capabilities.");
    lines.push("");
  } else {
    for (const toolkit of registry.composioToolkits) {
      lines.push(`### ${toolkit.label}`);
      lines.push(toolkit.description);
      lines.push("");
      const contracts = (toolkit.actions ?? []).flatMap((action) => action.contract ? [action.contract] : []);
      const skills = [...new Set(contracts.flatMap((contract) => contract.skillTags))];
      const resources = [...new Set(contracts.flatMap((contract) => contract.resources))];
      if (skills.length > 0) lines.push(`**Skills:** ${skills.join(", ")}`);
      if (resources.length > 0) lines.push(`**Resources:** ${resources.join(", ")}`);
      if (skills.length > 0 || resources.length > 0) lines.push("");
      if (toolkit.limitations.length > 0) {
        lines.push("**Limitations:**");
        for (const lim of toolkit.limitations) {
          lines.push(`- ${lim}`);
        }
        lines.push("");
      }
    }
  }

  lines.push("## Common Patterns");
  lines.push("");
  for (const uc of registry.useCases.slice(0, 6)) {
    lines.push(`### ${uc.name}`);
    lines.push(uc.description);
    lines.push(`**Outcome:** ${uc.outcome}`);
    lines.push("");
  }

  return lines.join("\n");
}

function renderContract(lines: string[], contract: ToolContract): void {
  const suggestedGate = contract.approval.suggestedGate
    ? ` (${JSON.stringify(contract.approval.suggestedGate)})`
    : "";
  lines.push(`### \`${contract.toolRef}\` — ${contract.name}`);
  lines.push(contract.description);
  lines.push("");
  lines.push(`**Skills:** ${contract.skillTags.join(", ") || "none"}`);
  lines.push(`**Resources:** ${contract.resources.join(", ") || "none"}`);
  lines.push(`**Effect:** ${contract.effect}`);
  lines.push(`**Execution:** ${contract.executionMode}`);
  lines.push(`**Approval:** ${contract.approval.required ? `Required${suggestedGate}` : "Not required"}`);
  if (contract.renderRecommendations.length > 0) {
    lines.push(`**Render recommendations:** ${contract.renderRecommendations.map((rec) => `${rec.target} (${rec.strength})`).join(", ")}`);
  } else {
    lines.push("**Render recommendations:** none");
  }
  if (contract.planningHints && contract.planningHints.length > 0) {
    lines.push("**Planning hints:**");
    for (const hint of contract.planningHints) {
      lines.push(`- ${hint}`);
    }
  }
  lines.push("");
  lines.push("**Output Schema:**");
  lines.push("```json");
  lines.push(JSON.stringify(contract.outputSchema, null, 2));
  lines.push("```");
  lines.push("");
}

function renderToolsPhase(registry: ToolSpecRegistry): string {
  const lines: string[] = [
    "=== TOOL REFERENCE ===",
    "",
    "When assigning tools to agents, use these exact tool refs. Each agent must have exactly ONE tool.",
    "",
  ];

  lines.push("## Internal Tools");
  lines.push("");
  for (const tool of registry.internalTools) {
    if (tool.contract) renderContract(lines, tool.contract);
    else {
      lines.push(`### \`${tool.ref}\` — ${tool.label}`);
      lines.push(tool.description);
      lines.push("");
    }
    if (tool.limitations.length > 0) {
      lines.push("**Limitations:**");
      for (const lim of tool.limitations) {
        lines.push(`- ${lim}`);
      }
      lines.push("");
    }
  }

  lines.push("## Connected App Tools");
  lines.push("");
  if (registry.composioToolkits.length === 0) {
    lines.push("No connected apps. Only internal tools are available.");
    lines.push("");
  } else {
    for (const toolkit of registry.composioToolkits) {
      lines.push(`### ${toolkit.label} (\`${toolkit.ref}\`)`);
      lines.push(toolkit.description);
      lines.push("");

      if (toolkit.contract) {
        renderContract(lines, toolkit.contract);
      }

      if (toolkit.actions && toolkit.actions.length > 0) {
        for (const action of toolkit.actions.slice(0, 12)) {
          if (action.contract) renderContract(lines, action.contract);
        }
        if (toolkit.actions.length > 12) {
          lines.push(`Additional actions omitted from prompt: ${toolkit.actions.length - 12}`);
          lines.push("");
        }
      }

      if (toolkit.limitations.length > 0) {
        lines.push("**Limitations:**");
        for (const lim of toolkit.limitations) {
          lines.push(`- ${lim}`);
        }
        lines.push("");
      }
    }
  }

  lines.push("## Canvas Render Targets (not tools)");
  lines.push("");
  lines.push("Tools may recommend render targets, but the architect chooses the actual renderTarget from the workflow output and review needs. Render targets are never tool refs:");
  lines.push("- `canvas.email` — editable email workspace.");
  lines.push("- `canvas.preview` — read-only rendered email preview.");
  lines.push("");
  lines.push("**Canonical gates:**");
  lines.push("- `input` — request operator data using nested `input.surface`, such as `input.text`, `input.file`, or `input.contacts_csv`.");
  lines.push("- `approval` — request operator approval using nested `approval.surface` for canvas/action review, such as `review.email`, `review.preview`, or `confirm.send`.");
  lines.push("- Connector action approvals use `approval.actionRef` plus payload metadata for the exact mutating action.");
  lines.push("");

  lines.push("## Tool Assignment Rules");
  lines.push("");
  lines.push("1. Every agent must have exactly ONE tool ref");
  lines.push("2. Assign only exact tool refs listed in this reference; discovered actions are materialized into workflow policy");
  lines.push("3. Internal tools: `internal.llm_only`, `internal.memory_search`, `internal.web_search`");
  lines.push("4. Connected app search: `composio.<toolkit>.search` (read-only, short-circuits)");
  lines.push("5. Choose tools by matching required skills, resources, effects, schemas, approval, and render recommendations");
  lines.push("6. Short-circuit tools return raw output — agent goals must be about the raw output, not synthesized content");
  lines.push("7. Render recommendations are advisory. Use no renderTarget when the output is structured data, raw results, or a non-visual handoff");
  lines.push("8. External side-effect tools require the approval gate declared by their contract");
  lines.push("");

  return lines.join("\n");
}

export function renderUseCasesMarkdown(useCases: ToolUseCase[]): string {
  const lines: string[] = ["=== TOOL USE CASE PATTERNS ===", ""];
  for (const uc of useCases) {
    lines.push(`### ${uc.name} (${uc.category})`);
    lines.push(uc.description);
    lines.push(`**Required tools:** ${uc.requiredTools.join(", ")}`);
    lines.push(`**Outcome:** ${uc.outcome}`);
    lines.push("");
  }
  return lines.join("\n");
}
