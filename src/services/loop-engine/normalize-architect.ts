import {
  loopArchitectOutputSchema,
  type LoopArchitectAgent,
  type LoopArchitectOutput,
  type NoSlopSpecSnapshot,
} from "./contracts.js";
import {
  hasMeaningfulOverlap,
  isArchitectStandaloneReviewAgent,
  writesEmailLikeCopy,
} from "./critic-helpers.js";

function isWebSearchToolRef(toolRef: string): boolean {
  return toolRef === "internal.web_search" || /^composio\.[a-z0-9_-]+\.search$/i.test(toolRef);
}

function findPrimaryWriterIndex(agents: LoopArchitectAgent[]): number {
  let bestIndex = -1;
  let bestScore = -1;
  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index]!;
    if (agent.tool !== "internal.llm_only") continue;
    let score = 0;
    if (writesEmailLikeCopy(agent)) score += 10;
    if (agent.artifactRole === "draft_body") score += 5;
    if (/\b(writer|draft|newsletter|synthesis|digest)\b/i.test(`${agent.id} ${agent.name}`)) score += 3;
    if (agent.renderTarget === "canvas.email") score += 2;
    if (isArchitectStandaloneReviewAgent(agent)) score -= 20;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  if (bestIndex >= 0) return bestIndex;
  return agents.findIndex((agent) => agent.tool === "internal.llm_only");
}

function fixEmailWriterAgent(agent: LoopArchitectAgent): LoopArchitectAgent {
  if (agent.tool !== "internal.llm_only" || !writesEmailLikeCopy(agent)) return agent;
  const question = agent.gate?.type === "draft_review" && agent.gate.question.trim()
    ? agent.gate.question
    : "Review this draft in the canvas. Save & approve to continue, or revise to improve it.";
  return {
    ...agent,
    artifactRole: agent.artifactRole === "delivery" ? agent.artifactRole : "draft_body",
    renderTarget: "canvas.email",
    gate: { type: "draft_review", question },
  };
}

function fixResearchAgent(agent: LoopArchitectAgent): LoopArchitectAgent {
  if (!isWebSearchToolRef(agent.tool)) return agent;
  if (agent.gate?.type === "source_confirmation") return agent;
  return {
    ...agent,
    gate: {
      type: "source_confirmation",
      question: agent.gate?.question?.trim()
        || "Select which sources to include. Add custom URLs if needed.",
    },
  };
}

function injectMissingSpecCoverage(design: LoopArchitectOutput, spec?: NoSlopSpecSnapshot): LoopArchitectOutput {
  if (!spec) return design;

  const phrases = [
    ...spec.specJson.guardrails,
    ...spec.specJson.successCriteria,
    ...spec.specJson.agents.flatMap((agent) => [...agent.guardrails, ...agent.doneWhen]),
  ];

  let strategyText = design.strategyText;
  const writerIndex = findPrimaryWriterIndex(design.agents);
  const agents = design.agents.map((agent) => ({ ...agent, doneCriteria: [...agent.doneCriteria] }));

  for (const phrase of phrases) {
    const trimmed = phrase.trim();
    if (!trimmed) continue;
    const covered = hasMeaningfulOverlap(
      [design.title, design.summary, strategyText, ...agents.map((agent) => [
        agent.name,
        agent.goal,
        agent.task,
        ...agent.doneCriteria,
        agent.gate?.question ?? "",
      ].join("\n"))].join("\n"),
      trimmed,
    );
    if (covered) continue;
    strategyText = `${strategyText}\n${trimmed}`;
    if (writerIndex >= 0 && agents[writerIndex] && !agents[writerIndex]!.doneCriteria.includes(trimmed)) {
      agents[writerIndex]!.doneCriteria.push(trimmed);
    }
  }

  return loopArchitectOutputSchema.parse({
    ...design,
    strategyText,
    agents,
  });
}

/** Deterministically repair common architect anti-patterns before the critic runs. */
export function normalizeArchitectOutput(
  design: LoopArchitectOutput,
  noSlopSpec?: NoSlopSpecSnapshot,
): LoopArchitectOutput {
  const removable = design.agents.filter((agent) => isArchitectStandaloneReviewAgent(agent));
  let agents = design.agents
    .filter((agent) => !isArchitectStandaloneReviewAgent(agent))
    .map((agent) => fixResearchAgent(fixEmailWriterAgent(agent)));

  const emailWriters = agents.filter((agent) => agent.tool === "internal.llm_only" && writesEmailLikeCopy(agent));
  if (emailWriters.length > 1) {
    agents = agents.filter((agent) => !(/\bdelivery preparation\b/i.test(agent.name)));
  }

  if (agents.length < 2 && removable.length > 0) {
    agents = design.agents.map((agent) => fixResearchAgent(fixEmailWriterAgent(agent)));
  }

  const normalized = loopArchitectOutputSchema.parse({
    ...design,
    agents,
    rationale: [
      ...design.rationale,
      ...(removable.length > 0
        ? [`Removed standalone review agents: ${removable.map((agent) => agent.name).join(", ")}. Human draft_review on the writer replaces them.`]
        : []),
    ],
  });

  return injectMissingSpecCoverage(normalized, noSlopSpec);
}
