import type { ToolSpec, ToolSpecRegistry, ToolUseCase } from "./types.js";

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
      if (toolkit.useCases.length > 0) {
        lines.push("**What you can do:**");
        for (const uc of toolkit.useCases) {
          lines.push(`- ${uc}`);
        }
        lines.push("");
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
    lines.push(`### \`${tool.ref}\` — ${tool.label}`);
    lines.push(tool.description);
    lines.push("");
    lines.push(`**Risk:** ${tool.risk}`);
    lines.push(`**Short-circuits:** ${tool.shortCircuits ? "Yes (raw output, no LLM synthesis)" : "No (output passes through LLM)"}`);
    lines.push(`**Output:** ${tool.outputDescription}`);
    lines.push("");
    lines.push("**Output Schema:**");
    lines.push("```json");
    lines.push(JSON.stringify(tool.outputSchema, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("**Handoff Format:** " + tool.handoffFormat);
    lines.push("");
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

      if (toolkit.actions && toolkit.actions.length > 0) {
        const readActions = toolkit.actions.filter((a) => a.risk === "read");
        const writeActions = toolkit.actions.filter((a) => a.risk === "write");
        const sendActions = toolkit.actions.filter((a) => a.risk === "send");
        const destructiveActions = toolkit.actions.filter((a) => a.risk === "destructive");

        if (readActions.length > 0) {
          lines.push("**Search/Read tools:**");
          lines.push(`- \`composio.${toolkit.toolkit}.search\` — Search ${toolkit.label} (read-only, short-circuits)`);
          lines.push("");
        }

        if (writeActions.length > 0) {
          lines.push("**Write tools (require pre-send approval):**");
          for (const action of writeActions.slice(0, 8)) {
            lines.push(`- \`composio.${toolkit.toolkit}.action.${action.slug}\` — ${action.name} (${action.risk})`);
          }
          if (writeActions.length > 8) {
            lines.push(`- ... and ${writeActions.length - 8} more write actions`);
          }
          lines.push("");
        }

        if (sendActions.length > 0) {
          lines.push("**Send tools (require pre-send approval):**");
          for (const action of sendActions.slice(0, 8)) {
            lines.push(`- \`composio.${toolkit.toolkit}.action.${action.slug}\` — ${action.name} (${action.risk})`);
          }
          if (sendActions.length > 8) {
            lines.push(`- ... and ${sendActions.length - 8} more send actions`);
          }
          lines.push("");
        }

        if (destructiveActions.length > 0) {
          lines.push("**Destructive tools (require pre-send approval, irreversible):**");
          for (const action of destructiveActions.slice(0, 5)) {
            lines.push(`- \`composio.${toolkit.toolkit}.action.${action.slug}\` — ${action.name} (${action.risk})`);
          }
          if (destructiveActions.length > 5) {
            lines.push(`- ... and ${destructiveActions.length - 5} more destructive actions`);
          }
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
  lines.push("Email and newsletter drafts are rendered in the dashboard canvas — assign these on the agent, never as a tool ref:");
  lines.push("- `canvas.email` — editable draft workspace. Pair with `artifactRole: draft_body` and `gate.type: draft_review`.");
  lines.push("- `canvas.preview` — read-only rendered email after approval. Pair with `artifactRole: final_preview`.");
  lines.push("");
  lines.push("**Approval types for canvas agents:**");
  lines.push("- `draft_review` — operator reviews the draft in canvas; can approve or edit to improve");
  lines.push("- `pre_send` — operator confirms final version before connector delivery");
  lines.push("- `missing_input` — operator pastes required text content (NOT for subscriber lists or delivery config)");
  lines.push("");

  lines.push("## Tool Assignment Rules");
  lines.push("");
  lines.push("1. Every agent must have exactly ONE tool ref");
  lines.push("2. Only assign tools listed in the approved no-slop spec's connectorPolicy");
  lines.push("3. Internal tools: `internal.llm_only`, `internal.memory_search`, `internal.web_search`");
  lines.push("4. Connected app search: `composio.<toolkit>.search` (read-only, short-circuits)");
  lines.push("5. Connected app actions: `composio.<toolkit>.action.<slug>` (require pre-send approval for write/send/destructive)");
  lines.push("6. Short-circuit tools (web_search, memory_search, composio.*.search) return raw output — agent goals must be about the raw output, not synthesized content");
  lines.push("7. For email/newsletter delivery, use a send-capable action from the approved connectorPolicy");
  lines.push("8. Draft email/newsletter content with internal.llm_only + renderTarget canvas.email; never use connector draft actions for content creation");
  lines.push("9. Delivery config (subscriber list, audience, recipients) belongs in connectorPolicy.recipientSource, not inputsRequired");
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
