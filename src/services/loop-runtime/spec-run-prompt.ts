import type { RunContext } from "./build-run-context.js";
import type { SpecRunDefinition } from "./spec-run-types.js";
import {
  selectedArtifactContract,
  selectedExternalDataToolkits,
  selectedGroundingSources,
} from "../loop-engine/build-contract.js";
import { resolveBuildContract } from "./definition-hydration.js";

export function buildSpecRunSystemPrompt(definition: SpecRunDefinition, runContext?: RunContext): string {
  const contract = resolveBuildContract(definition);
  const grounding = contract ? selectedGroundingSources(contract) : [];
  const externalToolkits = contract ? selectedExternalDataToolkits(contract) : [];
  const artifacts = contract ? selectedArtifactContract(contract) : null;

  const agentLines = (definition.agentGraph?.children ?? []).map((agent, index) => [
    `### ${index + 1}. ${agent.name}`,
    `Goal: ${agent.goal ?? agent.task}`,
    ...(agent.tools.length > 0 ? [`Tools: ${agent.tools.map((tool) => tool.ref).join(", ")}`] : []),
    ...(agent.guardrails ?? []).map((g) => `- Guardrail: ${g}`),
    ...(agent.doneCriteria ?? []).map((d) => `- Done when: ${d}`),
    ...(agent.failureModes ?? []).map((f) => `- Failure mode: ${f}`),
  ].join("\n")).join("\n\n");

  const runtimePolicyLines: string[] = [];
  if (runContext) {
    runtimePolicyLines.push(
      "## Runtime policies",
      `- Ticket content mode: ${runContext.policies.ticketContentMode}`,
      `- Customer details mode: ${runContext.policies.customerDetailsMode}`,
      "- Mutating connector actions require a canonical approval gate before execution.",
    );
    if (runContext.trigger.source === "event" && runContext.hasTriggerPayload) {
      runtimePolicyLines.push(
        `- Trigger: ${runContext.trigger.slug ?? runContext.trigger.label ?? "event"} — ticket data is in the user message; do NOT search memory to discover the ticket.`,
        "- Use searchMemory only for prior customer history, FAQs, or workspace context (search by sender email when available).",
      );
    } else if (runContext.trigger.source === "event") {
      runtimePolicyLines.push("- Event trigger fired but no ticket payload was loaded — use connector read tools or report the configured failure mode.");
    }
    runtimePolicyLines.push("");
  }

  const reviewLines = [
    "## Gate policy",
    "Use top-level `input` gates for missing operator data and top-level `approval` gates for artifact review or connector-action approval.",
    "Every mutating external write must be approved before execution.",
    "",
  ];

  return [
    "You are Tallei's loop runner. Execute the approved behavioral spec for this workflow run.",
    "Work through the agents in order. Use tools to gather grounded context before producing deliverables.",
    "Never invent facts, IDs, metrics, or credentials. Ground claims in tool outputs.",
    "Before any external write (email send, CRM update, etc.), the tool requires explicit user approval — present the draft clearly.",
    "When all agents are complete and delivery is done (or not applicable), call finalizeRun with a concise summary.",
    "",
    "## Purpose",
    definition.goal,
    "",
    "## Success criteria",
    ...(definition.agentGraph?.children ?? []).flatMap((agent) => agent.doneCriteria ?? []).map((c) => `- ${c}`),
    "",
    "## Agents (execute in order)",
    agentLines,
    "",
    "## Delivery",
    definition.delivery?.provider
      ? `${definition.delivery.provider}`
      : definition.deliveryType && definition.deliveryType !== "none"
        ? definition.deliveryType
        : "Dashboard only",
    "",
    ...runtimePolicyLines,
    ...reviewLines,
    "## Grounding policy",
    grounding.length > 0
      ? `Use these sources: ${grounding.map((s) => s.type === "knowledge_base" || s.type === "google_doc" ? `${s.type}:${s.id}` : s.type).join(", ")}`
      : "Use Tallei memory and workspace memory (includes prior loop runs) when relevant.",
    externalToolkits.length > 0 ? `Optional connected app search: ${externalToolkits.join(", ")}` : "",
    "",
    ...(artifacts && artifacts.templates.length > 0 ? [
      "## Reply templates",
      "Use these approved templates when drafting customer-facing email replies. Match tone and structure; personalize details from grounded context.",
      "Replace {{ticket_subject}} and {{customer_name}} with values from the ticket context.",
      ...artifacts.templates.flatMap((template) => [
        `### ${template.name}`,
        `Subject: ${template.subject}`,
        template.text?.trim()
          ? `Body:\n${template.text.trim().slice(0, 1200)}`
          : `Body (HTML summary): ${template.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600)}`,
      ]),
      "",
    ] : artifacts?.structure ? [
      "## Approved output structure",
      artifacts.structure,
      "",
    ] : []),
    "## Schedule context",
    `${definition.schedule.cron} (${definition.schedule.timezone})`,
  ].filter(Boolean).join("\n");
}
