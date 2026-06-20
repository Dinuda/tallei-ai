import type { RunContext } from "./build-run-context.js";
import type { RunnableSpec } from "./spec-run-types.js";
import {
  selectedArtifactContract,
  selectedExternalDataToolkits,
  selectedGroundingSources,
} from "../loop-engine/build-contract.js";

export function buildSpecRunSystemPrompt(spec: RunnableSpec, runContext?: RunContext): string {
  const contract = spec.buildContract ?? spec.noSlopSpec.buildContract ?? spec.noSlopSpec.specJson.buildContract;
  const grounding = contract ? selectedGroundingSources(contract) : [];
  const externalToolkits = contract ? selectedExternalDataToolkits(contract) : [];
  const artifacts = spec.artifacts ?? (contract ? selectedArtifactContract(contract) : null);

  const agentLines = spec.noSlopSpec.specJson.agents.map((agent, index) => [
    `### ${index + 1}. ${agent.name}`,
    `Goal: ${agent.goal}`,
    ...(agent.tools.length > 0 ? [`Tools: ${agent.tools.join(", ")}`] : []),
    ...agent.guardrails.map((g) => `- Guardrail: ${g}`),
    ...agent.doneWhen.map((d) => `- Done when: ${d}`),
    ...agent.failureModes.map((f) => `- Failure mode: ${f}`),
  ].join("\n")).join("\n\n");

  const runtimePolicyLines: string[] = [];
  if (runContext) {
    runtimePolicyLines.push(
      "## Runtime policies",
      `- Ticket content mode: ${runContext.policies.ticketContentMode}`,
      `- Customer details mode: ${runContext.policies.customerDetailsMode}`,
      `- Review policy: ${runContext.policies.reviewMode ?? "approve_each_action"}`,
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

  const reviewLines = runContext?.policies.reviewMode === "draft_only"
    ? [
      "## Approval policy",
      "Draft-only mode: create email drafts but do not send. Do not call send actions.",
      "",
    ]
    : runContext?.policies.reviewMode === "approve_batch"
      ? [
        "## Approval policy",
        "Batch approval: prepare all drafts before requesting send approval.",
        "",
      ]
      : [
        "## Approval policy",
        "Approve each external write individually before execution.",
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
    spec.noSlopSpec.specJson.purpose,
    "",
    "## Success criteria",
    ...spec.noSlopSpec.specJson.successCriteria.map((c) => `- ${c}`),
    "",
    "## Agents (execute in order)",
    agentLines,
    "",
    "## Delivery",
    `${spec.noSlopSpec.specJson.delivery.provider}: ${spec.noSlopSpec.specJson.delivery.description}`,
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
    `${spec.schedule.cron} (${spec.schedule.timezone})`,
  ].filter(Boolean).join("\n");
}
