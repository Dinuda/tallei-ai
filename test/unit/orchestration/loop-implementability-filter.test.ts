import assert from "node:assert/strict";
import test from "node:test";

import { LoopImplementabilityFilterUseCase } from "../../../src/orchestration/loop-miner/implementability-filter.usecase.js";
import type { CandidateLoop, EpisodeRecord, LoopEvaluation } from "../../../src/orchestration/loop-miner/types.js";

function episode(id: string, input: {
  intent: string;
  outputType: string;
  sources?: string[];
  steps?: string[];
  toolNames?: string[];
}): EpisodeRecord {
  return {
    id,
    intent: input.intent,
    sources: input.sources ?? [],
    outputType: input.outputType,
    toolNames: input.toolNames ?? [],
    steps: input.steps ?? [],
    approved: true,
    eventIds: [`event-${id}`],
    sealedAt: "2026-05-20T00:00:00.000Z",
    turnCount: 1,
    turns: [{
      role: "user",
      contentSummary: input.intent,
      sourceEventType: "ai_activity_event",
      sourceEventId: `event-${id}`,
      createdAt: "2026-05-20T00:00:00.000Z",
    }],
  };
}

function evaluation(input: Partial<LoopEvaluation>): LoopEvaluation {
  return {
    loopName: input.loopName ?? "Loop",
    episodeIds: input.episodeIds ?? ["episode-1", "episode-2"],
    confidence: input.confidence ?? 0.9,
    verdict: input.verdict ?? "automate",
    reasoning: input.reasoning ?? "Repeated loop",
    estimatedCadence: input.estimatedCadence ?? "weekly",
    estimatedValue: input.estimatedValue ?? "high",
    automationReadiness: input.automationReadiness ?? "full",
    risks: input.risks ?? [],
  };
}

function candidateLoop(input: Partial<CandidateLoop>): CandidateLoop {
  return {
    loopName: input.loopName ?? "Loop",
    episodeIds: input.episodeIds ?? ["episode-1", "episode-2"],
    sharedIntent: input.sharedIntent ?? "Default intent",
    sharedSources: input.sharedSources ?? ["memory"],
    sharedOutputType: input.sharedOutputType ?? "summary",
    reasoning: input.reasoning ?? "reasoning",
  };
}

test("implementability filter allows newsletter flow when WhatsApp delivery is enabled", () => {
  const useCase = new LoopImplementabilityFilterUseCase();
  const result = useCase.execute({
    activeCapabilities: ["notification:whatsapp"],
    qualifiedLoops: [{
      candidateLoop: candidateLoop({
        loopName: "Newsletter broadcast",
        sharedIntent: "Create and send weekly newsletter",
        sharedOutputType: "newsletter",
      }),
      evaluation: evaluation({
        loopName: "Newsletter broadcast",
        reasoning: "Create and send the weekly newsletter update.",
      }),
      episodes: [
        episode("episode-1", { intent: "Draft weekly newsletter", outputType: "newsletter", steps: ["Draft", "Send"] }),
        episode("episode-2", { intent: "Send weekly newsletter", outputType: "newsletter", steps: ["Send to audience"] }),
      ],
    }],
  });

  assert.equal(result.implementable.length, 1);
  assert.equal(result.blocked.length, 0);
  assert.equal(result.implementable[0]?.implementability.status, "implementable");
});

test("implementability filter blocks GitHub loop when connector is unavailable", () => {
  const useCase = new LoopImplementabilityFilterUseCase();
  const result = useCase.execute({
    activeCapabilities: [],
    qualifiedLoops: [{
      candidateLoop: candidateLoop({
        loopName: "Release changelog",
        sharedIntent: "Read GitHub commits and draft changelog",
        sharedSources: ["github"],
        sharedOutputType: "changelog",
      }),
      evaluation: evaluation({
        loopName: "Release changelog",
        reasoning: "Gather commit history from GitHub and produce weekly release notes.",
      }),
      episodes: [
        episode("episode-1", { intent: "Read GitHub commits", outputType: "changelog", sources: ["github"], toolNames: ["github"] }),
        episode("episode-2", { intent: "Draft changelog from repository delta", outputType: "changelog", sources: ["github"], toolNames: ["github"] }),
      ],
    }],
  });

  assert.equal(result.implementable.length, 0);
  assert.equal(result.blocked.length, 1);
  assert.deepEqual(result.blocked[0]?.implementability.missingCapabilities, ["github"]);
});

test("implementability filter blocks high human continuity loops even with integrations", () => {
  const useCase = new LoopImplementabilityFilterUseCase();
  const result = useCase.execute({
    activeCapabilities: ["github", "notification:whatsapp", "resend"],
    qualifiedLoops: [{
      candidateLoop: candidateLoop({
        loopName: "Stakeholder strategy call prep",
        sharedIntent: "Prepare context before stakeholder interviews",
        sharedOutputType: "brief",
      }),
      evaluation: evaluation({
        loopName: "Stakeholder strategy call prep",
        automationReadiness: "manual",
        reasoning: "Requires offline coordination and heavy human judgment.",
        risks: ["Requires stakeholder interviews before every output"],
      }),
      episodes: [
        episode("episode-1", { intent: "Prepare interview notes", outputType: "brief" }),
        episode("episode-2", { intent: "Prepare interview notes", outputType: "brief" }),
      ],
    }],
  });

  assert.equal(result.implementable.length, 0);
  assert.equal(result.blocked.length, 1);
  assert.ok(result.blocked[0]?.implementability.blockers.includes("automation_readiness_manual"));
});
