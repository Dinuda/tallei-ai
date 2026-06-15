import type { RunnableSpec } from "./spec-run-types.js";
import {
  selectedArtifactContract,
  selectedExternalDataToolkits,
  selectedGroundingSources,
} from "../loop-engine/build-contract.js";

export function buildSpecRunSystemPrompt(spec: RunnableSpec): string {
  const contract = spec.buildContract ?? spec.noSlopSpec.buildContract ?? spec.noSlopSpec.specJson.buildContract;
  const grounding = contract ? selectedGroundingSources(contract) : [];
  const externalToolkits = contract ? selectedExternalDataToolkits(contract) : [];
  const artifacts = spec.artifacts ?? (contract ? selectedArtifactContract(contract) : null);

  const agentLines = spec.noSlopSpec.specJson.agents.map((agent, index) => [
    `### ${index + 1}. ${agent.name}`,
    `Goal: ${agent.goal}`,
    ...agent.guardrails.map((g) => `- Guardrail: ${g}`),
    ...agent.doneWhen.map((d) => `- Done when: ${d}`),
    ...agent.failureModes.map((f) => `- Failure mode: ${f}`),
  ].join("\n")).join("\n\n");

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
    "## Grounding policy",
    grounding.length > 0
      ? `Use these sources: ${grounding.map((s) => s.type === "knowledge_base" || s.type === "google_doc" ? `${s.type}:${s.id}` : s.type).join(", ")}`
      : "Use Tallei memory and workspace memory (includes prior loop runs) when relevant.",
    externalToolkits.length > 0 ? `Optional connected app search: ${externalToolkits.join(", ")}` : "",
    "",
    ...(artifacts && artifacts.templates.length > 0 ? [
      "## Reply templates",
      "Use these approved templates when drafting customer-facing email replies. Match tone and structure; personalize details from grounded context.",
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
