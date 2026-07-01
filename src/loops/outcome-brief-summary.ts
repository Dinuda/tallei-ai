import { z } from "zod";
import { generateText } from "ai";

import { getStreamingLanguageModel } from "../providers/ai/streaming/language-model.js";
import type { OutcomeBrief } from "./outcome-brief.js";
import type { LoopSpec } from "./spec.js";
import { extractJsonObject } from "./planning-agent.js";
import { approvalNeedsReviewForRole } from "./approval-policy.js";

export const outcomeBriefUserSummarySchema = z.object({
  whenItRuns: z.string().min(1),
  appsInvolved: z.array(z.string().min(1)),
  steps: z.array(z.string().min(1)).min(1),
  beforeSending: z.string().min(1),
  howYouKnowItWorked: z.string().min(1),
  whereResultsGo: z.string().min(1),
  safetyLimits: z.array(z.string().min(1)),
  assumptionsNote: z.string().optional(),
});

export type OutcomeBriefUserSummary = z.infer<typeof outcomeBriefUserSummarySchema>;

/** Blueprint-only fallback when the summarizer is unavailable — no slug lookup tables. */
export function fallbackOutcomeBriefUserSummary(
  spec: LoopSpec,
  brief: OutcomeBrief,
): OutcomeBriefUserSummary {
  const outcomes = spec.taskBlueprint?.outcomes ?? [];
  const triggerOutcome = outcomes.find((row) => row.role === "trigger");
  const steps = outcomes
    .filter((row) => row.role !== "trigger")
    .map((row) => row.description.trim())
    .filter(Boolean);

  const appsInvolved = brief.connectors
    .map((row) => row.description.trim())
    .filter(Boolean);

  const approvalAsk = spec.approval.mode === "ask";
  const reviewsDestination = approvalNeedsReviewForRole(spec.approval, "destination")
    || spec.approval.sensitiveCapabilities.length > 0;

  return {
    whenItRuns: triggerOutcome?.description.trim() || brief.outcome,
    appsInvolved: appsInvolved.length > 0 ? appsInvolved : [spec.intent.outcome],
    steps: steps.length > 0 ? steps : [brief.outcome],
    beforeSending: approvalAsk
      ? "You'll review and approve every step before it runs."
      : reviewsDestination
        ? "You'll review and approve before outbound or sensitive actions run."
        : "It runs automatically without an extra approval step.",
    howYouKnowItWorked: brief.successCriteria.length > 0
      ? brief.successCriteria.join("; ")
      : "It completes the steps above without errors.",
    whereResultsGo: spec.output.kind === "none" || !spec.output.target
      ? "Results stay in the apps you're already using (nothing saved separately)."
      : `Results are saved to ${spec.output.target}.`,
    safetyLimits: [
      `Stops after ${spec.guardrails.maxRunDurationMinutes} minutes if it gets stuck.`,
      `Retries each step up to ${spec.guardrails.maxRetriesPerStep} times if something fails.`,
    ],
    ...(brief.assumptions.length
      ? { assumptionsNote: brief.assumptions.join(" · ") }
      : {}),
  };
}

export async function summarizeOutcomeBriefForUser(input: {
  spec: LoopSpec;
  brief: OutcomeBrief;
  userId?: string;
}): Promise<OutcomeBriefUserSummary> {
  const fallback = fallbackOutcomeBriefUserSummary(input.spec, input.brief);

  try {
    const { text } = await generateText({
      model: getStreamingLanguageModel("planner", { userId: input.userId }),
      system: [
        "You write confirmation summaries for non-technical users (teachers, office staff, small business owners).",
        "Use plain English. No API slugs, no camelCase, no Composio/Gmail action names, no cron syntax unless unavoidable.",
        "Reply with a single JSON object only.",
      ].join(" "),
      prompt: [
        "Turn this automation plan into a friendly confirmation summary.",
        "",
        `Outcome: ${input.brief.outcome}`,
        `User goal: ${input.spec.intent.goal}`,
        `Technical plan (for your reference only — do not copy slugs into the summary):`,
        JSON.stringify(input.brief, null, 2),
        "",
        "Return JSON with exactly these keys:",
        JSON.stringify({
          whenItRuns: "one sentence — when does this start?",
          appsInvolved: ["short lines — which apps/services"],
          steps: ["numbered-style short lines — what happens in order"],
          beforeSending: "one sentence — approval before sends/sensitive actions",
          howYouKnowItWorked: "one sentence — success from the user's perspective",
          whereResultsGo: "one sentence — where outputs land",
          safetyLimits: ["short lines — time limits, retries"],
          assumptionsNote: "optional — plain language assumptions, or omit",
        }, null, 2),
      ].join("\n"),
    });

    return outcomeBriefUserSummarySchema.parse(
      JSON.parse(extractJsonObject(text)),
    );
  } catch (error) {
    console.warn("[loops/outcome-brief] user summary generation failed, using blueprint fallback:", error);
    return fallback;
  }
}
