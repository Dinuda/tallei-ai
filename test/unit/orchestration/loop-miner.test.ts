import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import { pool } from "../../../src/infrastructure/db/index.js";
import { LoopMinerRepository } from "../../../src/infrastructure/repositories/loop-miner.repository.js";
import { DnaGeneratorUseCase } from "../../../src/orchestration/loop-miner/dna-generator.usecase.js";
import { EpisodeBuilderUseCase } from "../../../src/orchestration/loop-miner/episode-builder.usecase.js";
import { LoopDetectorUseCase } from "../../../src/orchestration/loop-miner/loop-detector.usecase.js";
import { LoopEvaluatorUseCase } from "../../../src/orchestration/loop-miner/loop-evaluator.usecase.js";
import { runLoopMinerForUser } from "../../../src/orchestration/loop-miner/loop-miner.js";
import type {
  CandidateLoop,
  EpisodeExtraction,
  EpisodeRecord,
  EpisodeTurnRecord,
  LoopEvaluation,
  LoopMinerRepository as LoopMinerRepositoryContract,
  LoopMinerSummary,
  MinerEvent,
  WorkflowDNA,
} from "../../../src/orchestration/loop-miner/types.js";
import {
  chunkEventsByTimeGap,
  compactMinerEvent,
  estimateTokens,
  normalizeEpisodeExtraction,
  normalizeCandidateLoop,
  normalizeLoopEvaluation,
  normalizeWorkflowDna,
  packByEstimatedPromptBudget,
  prefilterEpisodesByOutputType,
} from "../../../src/orchestration/loop-miner/utils.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../../src/providers/ai/types.js";

const auth: AuthContext = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  authMode: "internal",
  plan: "pro",
};

function event(id: string, createdAt: string, contentSummary = "Draft weekly changelog from GitHub commits"): MinerEvent {
  return {
    id,
    sourceEventType: "ai_activity_event",
    createdAt,
    platform: "chatgpt",
    contentSummary,
    role: "user",
    metadata: {},
  };
}

function episode(id: string, outputType: string): EpisodeRecord {
  return {
    id,
    intent: "Draft release notes from GitHub changes",
    sources: ["github"],
    outputType,
    toolNames: ["github"],
    steps: ["Review commits", "Draft changelog"],
    approved: true,
    eventIds: [`event-${id}`],
    sealedAt: "2026-05-01T09:00:00.000Z",
    turnCount: 1,
    turns: [{
      role: "user",
      contentSummary: "Draft weekly changelog from GitHub commits",
      sourceEventType: "ai_activity_event",
      sourceEventId: `event-${id}`,
      createdAt: "2026-05-01T09:00:00.000Z",
    }],
  };
}

test("loop miner cheap heuristics only split by time gap and repeated output type", () => {
  const events = [
    event("e1", "2026-05-01T09:00:00.000Z"),
    event("e2", "2026-05-01T12:59:00.000Z"),
    event("e3", "2026-05-01T17:01:00.000Z"),
  ];
  const chunks = chunkEventsByTimeGap(events, 4);
  assert.deepEqual(chunks.map((chunk) => chunk.map((item) => item.id)), [["e1", "e2"], ["e3"]]);

  const filtered = prefilterEpisodesByOutputType([
    episode("1", "changelog"),
    episode("2", "changelog"),
    episode("3", "spreadsheet"),
  ]);
  assert.deepEqual(filtered.map((item) => item.id), ["1", "2"]);
});

test("loop miner compacts long events and preserves allowlisted metadata only", () => {
  const longSummary = `${"a".repeat(1200)}\n${"b".repeat(1200)}`;
  const compacted = compactMinerEvent({
    ...event("e-compact", "2026-05-01T09:00:00.000Z", longSummary),
    metadata: {
      state: "done",
      iteration: 3,
      updatedAt: "2026-05-01T09:05:00.000Z",
      lastActor: "chatgpt",
      ignoredField: "should_not_pass",
    },
  }, { contentSummaryCharCap: 900 });
  assert.ok(compacted.contentSummary.length <= 900);
  assert.equal((compacted.metadata as Record<string, unknown>).state, "done");
  assert.equal((compacted.metadata as Record<string, unknown>).iteration, 3);
  assert.equal((compacted.metadata as Record<string, unknown>).ignoredField, undefined);
});

test("loop miner token budget packer splits oversized sequences into micro-batches", () => {
  const items = Array.from({ length: 9 }, (_, index) => ({
    id: `i-${index + 1}`,
    payload: "x".repeat(800),
  }));
  const packed = packByEstimatedPromptBudget(items, {
    maxTokens: 600,
    baseTokens: 200,
    estimateItemTokens: (item) => estimateTokens(JSON.stringify(item)),
  });
  assert.ok(packed.batches.length > 1);
  for (const batch of packed.batches) {
    const approxTokens = 200 + batch.reduce((sum, item) => sum + estimateTokens(JSON.stringify(item)), 0);
    assert.ok(approxTokens <= packed.maxEstimatedTokensPerBatch);
  }
});

test("loop miner normalizers validate ids, clamp confidence, and force approval for external mutation", () => {
  const extraction = normalizeEpisodeExtraction({
    title: "Company newsletter",
    summary: "User created a weekly product newsletter.",
    intent: { label: "create_newsletter", goal: "Create a company/product update", confidence: 0.92 },
    sources: [{ type: "memory", name: "Tallei company memory", importance: 0.8 }],
    output: { type: "newsletter", description: "Newsletter draft" },
    toolNames: ["memory"],
    steps: ["Gather company context", "Draft concise newsletter"],
    styleHints: ["short", "founder-like"],
    userBehavior: { accepted: true, edited: true, regenerated: false, ignored: false, approvalSignal: "approved" },
    automationSignals: { repeatable: true, likelyCadence: "weekly", businessValue: 0.8, automationReadiness: 0.7 },
    confidence: 0.9,
    eventIds: ["event-1"],
  }, new Set(["event-1"]));
  assert.ok(extraction);
  assert.equal(extraction.intent, "Create a company/product update");
  assert.equal(extraction.intentDetails?.label, "create_newsletter");
  assert.equal(extraction.outputType, "newsletter");
  assert.deepEqual(extraction.sources, ["Tallei company memory"]);
  assert.equal(extraction.approved, true);
  assert.equal(extraction.automationSignals?.repeatable, true);

  const memoryLike = normalizeEpisodeExtraction({
    intent: "User prefers no emoji",
    outputType: "preference record",
    eventIds: ["event-1"],
  }, new Set(["event-1"]));
  assert.equal(memoryLike, null);

  const candidate = normalizeCandidateLoop({
    loopName: "Weekly changelog",
    episodeIds: ["ep-1", "ep-2", "unknown"],
    sharedIntent: "Draft release notes",
    sharedSources: ["github"],
    sharedOutputType: "changelog",
    reasoning: "same task",
  }, new Set(["ep-1", "ep-2"]));
  assert.ok(candidate);
  assert.deepEqual(candidate.episodeIds, ["ep-1", "ep-2"]);

  const evaluation = normalizeLoopEvaluation({
    loopName: "Weekly changelog",
    episodeIds: ["ep-1", "ep-2"],
    confidence: 2,
    verdict: "automate",
    estimatedValue: "high",
    automationReadiness: "full",
  }, candidate);
  assert.equal(evaluation.confidence, 1);
  assert.equal(evaluation.verdict, "automate");

  const dna = normalizeWorkflowDna({
    name: "Weekly changelog",
    trigger: { type: "schedule", cadence: "0 9 * * 1" },
    outputType: "email update",
    stepPattern: ["send the changelog to the team"],
    approvalBehavior: "auto",
  }, {
    loop: candidate,
    evaluation,
    episodes: [episode("ep-1", "changelog"), episode("ep-2", "changelog")],
  });
  assert.equal(dna.approvalBehavior, "require_explicit_approval");
});

test("repository listRecentEvents uses AI activity and collab tasks as episode evidence while ignoring standalone memories", async () => {
  const originalQuery = pool.query.bind(pool);
  const repository = new LoopMinerRepository();
  const queries: string[] = [];
  try {
    (pool as unknown as { query: typeof pool.query }).query = (async (sql: string) => {
      queries.push(sql);
      assert.ok(!sql.includes("FROM memory_records"), "standalone memory records must not be episode events");
      if (sql.includes("FROM collab_tasks")) {
        return {
          rows: [{
            id: "22222222-2222-4222-8222-222222222222",
            title: "Week 6 slides",
            brief: "Create classroom slides for AI course",
            state: "paused",
            last_actor: "chatgpt",
            iteration: 7,
            context: { artifacts: { prd_summary: "Final classroom-ready slides" }, documents: { documents: [{ title: "Week 5 PDF" }] } },
            transcript: [],
            created_at: "2026-05-02T09:00:00.000Z",
            updated_at: "2026-05-02T10:00:00.000Z",
          }],
          rowCount: 1,
        } as unknown;
      }
      return {
        rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          source: "chatgpt",
          activity_type: "chat",
          content_text: "Create this week's company newsletter from Tallei product notes.",
          metadata_json: { role: "user" },
          created_at: "2026-05-01T09:00:00.000Z",
        }],
        rowCount: 1,
      } as unknown;
    }) as typeof pool.query;

    const events = await repository.listRecentEvents(auth, 30);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.sourceEventType, "ai_activity_event");
    assert.equal(events[0]?.contentSummary, "Create this week's company newsletter from Tallei product notes.");
    assert.equal(events[1]?.sourceEventType, "collab_task");
    assert.match(events[1]?.contentSummary ?? "", /Week 6 slides/);
    assert.equal(queries.length, 2);
  } finally {
    (pool as unknown as { query: typeof pool.query }).query = originalQuery;
  }
});

class InMemoryLoopMinerRepository implements LoopMinerRepositoryContract {
  events: MinerEvent[];
  episodes = new Map<string, EpisodeRecord>();
  suggestionsCreated = 0;
  completedSummary: LoopMinerSummary | null = null;

  constructor(events: MinerEvent[]) {
    this.events = events;
  }

  async hasRunningDailyRun(): Promise<boolean> {
    return false;
  }

  async hasCompletedDailyRunToday(): Promise<boolean> {
    return false;
  }

  async createRun(): Promise<string> {
    return "run-1";
  }

  async completeRun(input: { summary: LoopMinerSummary }): Promise<void> {
    this.completedSummary = input.summary;
  }

  async listRecentEvents(): Promise<MinerEvent[]> {
    return this.events;
  }

  async createEpisode(input: {
    extraction: EpisodeExtraction;
    turns: EpisodeTurnRecord[];
  }): Promise<EpisodeRecord> {
    const id = `episode-${this.episodes.size + 1}`;
    const record: EpisodeRecord = {
      id,
      ...input.extraction,
      sealedAt: input.turns.map((turn) => turn.createdAt).sort().at(-1) ?? "2026-05-01T00:00:00.000Z",
      turnCount: input.turns.length,
      turns: input.turns,
    };
    this.episodes.set(id, record);
    return record;
  }

  async listEpisodeContext(_auth: AuthContext, episodeIds: string[]): Promise<EpisodeRecord[]> {
    return episodeIds.map((id) => this.episodes.get(id)).filter((item): item is EpisodeRecord => Boolean(item));
  }

  async createWorkflowSuggestion(input: {
    evaluation: LoopEvaluation;
    dna: WorkflowDNA;
    suggestedPrompt: string;
    fingerprint: string;
  }) {
    this.suggestionsCreated += 1;
    return {
      id: `suggestion-${this.suggestionsCreated}`,
      title: input.dna.name,
      reason: input.evaluation.reasoning,
      suggestedPrompt: input.suggestedPrompt,
      status: "pending" as const,
      confidence: input.evaluation.confidence,
      fingerprint: input.fingerprint,
      triggerCount: input.evaluation.episodeIds.length,
      createdAt: "2026-05-20T00:00:00.000Z",
    };
  }
}

test("runLoopMinerForUser builds episodes, detects loop, evaluates, generates DNA, and creates suggestion", async () => {
  const repository = new InMemoryLoopMinerRepository([
    event("e1", "2026-04-27T09:00:00.000Z"),
    event("e2", "2026-05-04T09:00:00.000Z"),
    event("e3", "2026-05-11T09:00:00.000Z"),
    event("e4", "2026-05-18T09:00:00.000Z"),
  ]);
  const responses = [
    { episodes: [{ intent: "Draft weekly changelog", sources: ["github"], outputType: "changelog", toolNames: ["github"], steps: ["Review commits", "Draft notes"], approved: true, eventIds: ["e1"] }] },
    { episodes: [{ intent: "Draft weekly changelog", sources: ["github"], outputType: "changelog", toolNames: ["github"], steps: ["Review commits", "Draft notes"], approved: true, eventIds: ["e2"] }] },
    { episodes: [{ intent: "Draft weekly changelog", sources: ["github"], outputType: "changelog", toolNames: ["github"], steps: ["Review commits", "Draft notes"], approved: true, eventIds: ["e3"] }] },
    { episodes: [{ intent: "Draft weekly changelog", sources: ["github"], outputType: "changelog", toolNames: ["github"], steps: ["Review commits", "Draft notes"], approved: true, eventIds: ["e4"] }] },
    { loops: [{ loopName: "Weekly changelog", episodeIds: ["episode-1", "episode-2", "episode-3", "episode-4"], sharedIntent: "Draft changelog from GitHub", sharedSources: ["github"], sharedOutputType: "changelog", reasoning: "same weekly output" }] },
    { loopName: "Weekly changelog", episodeIds: ["episode-1", "episode-2", "episode-3", "episode-4"], confidence: 0.91, verdict: "automate", reasoning: "high value repeated workflow", estimatedCadence: "weekly", estimatedValue: "high", automationReadiness: "full", risks: ["needs review before sending"] },
    { name: "Weekly changelog", trigger: { type: "schedule", cadence: "0 9 * * 1" }, sources: ["github"], outputType: "changelog", stepPattern: ["Collect GitHub commits", "Draft release notes"], style: "concise", approvalBehavior: "auto", reasoning: "weekly cadence" },
  ];
  const chat = async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
    const next = responses.shift();
    assert.ok(next, "unexpected LLM call");
    return {
      text: JSON.stringify(next),
      model: request.model ?? "gpt-4.1-nano",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  };

  const result = await runLoopMinerForUser(auth, { runReason: "daily_intelligence" }, {
    repository,
    episodeBuilder: new EpisodeBuilderUseCase(repository, chat),
    loopDetector: new LoopDetectorUseCase(chat),
    loopEvaluator: new LoopEvaluatorUseCase(chat),
    dnaGenerator: new DnaGeneratorUseCase(chat),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.summary.episodesBuilt, 4);
  assert.equal(result.summary.loopsDetected, 1);
  assert.equal(result.summary.loopsQualified, 1);
  assert.equal(result.summary.suggestionsCreated, 1);
  assert.equal(result.suggestions[0]?.title, "Weekly changelog");
  assert.equal(repository.completedSummary?.usage.calls, 7);
  assert.ok((result.summary.usage.models["gpt-4.1-nano"] ?? 0) > 0);
  assert.ok((result.summary.phaseUsage?.episodeBuilder?.tokensPerOutputEpisode ?? 0) > 0);
  assert.equal(responses.length, 0);
});

test("runLoopMinerForUser completes with warnings when an episode-builder chunk times out", async () => {
  const repository = new InMemoryLoopMinerRepository([
    event("e1", "2026-05-04T09:00:00.000Z"),
    event("e2", "2026-05-11T09:00:00.000Z"),
  ]);
  let callCount = 0;
  const chat = async (_request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
    callCount += 1;
    if (callCount === 2) {
      const error = new Error("Operation timed out after 15000ms");
      error.name = "TimeoutError";
      throw error;
    }
    return {
      text: JSON.stringify({
        episodes: [{
          intent: "Draft weekly changelog",
          sources: ["github"],
          outputType: "changelog",
          toolNames: ["github"],
          steps: ["Review commits", "Draft notes"],
          approved: true,
          eventIds: ["e1"],
        }],
      }),
      model: "gpt-4o-mini",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  };

  const result = await runLoopMinerForUser(auth, { runReason: "manual" }, {
    repository,
    episodeBuilder: new EpisodeBuilderUseCase(repository, chat),
    loopDetector: new LoopDetectorUseCase(chat),
    loopEvaluator: new LoopEvaluatorUseCase(chat),
    dnaGenerator: new DnaGeneratorUseCase(chat),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.summary.episodesBuilt, 1);
  assert.equal(result.summary.loopsDetected, 0);
  assert.equal(result.summary.warnings?.length, 1);
  assert.match(result.summary.warnings?.[0] ?? "", /TimeoutError/);
  assert.equal(callCount, 2);
});

test("loop evaluator parses batched array output and tolerates malformed rows", async () => {
  const loopA: CandidateLoop = {
    loopName: "Weekly changelog",
    episodeIds: ["episode-1", "episode-2"],
    sharedIntent: "Draft changelog",
    sharedSources: ["github"],
    sharedOutputType: "changelog",
    reasoning: "same workflow",
  };
  const episodes = [episode("1", "changelog"), episode("2", "changelog")];
  const useCase = new LoopEvaluatorUseCase(async () => ({
    text: JSON.stringify({
      evaluations: [
        {
          loopName: "Weekly changelog",
          episodeIds: ["episode-1", "episode-2"],
          confidence: 0.82,
          verdict: "automate",
          reasoning: "repeats weekly",
          estimatedCadence: "weekly",
          estimatedValue: "high",
          automationReadiness: "full",
          risks: [],
        },
        {
          confidence: 0.2,
          verdict: "discard",
        },
      ],
    }),
    model: "gpt-4.1-nano",
    finishReason: "stop",
    usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
  }));
  const result = await useCase.execute({
    candidateLoops: [loopA],
    episodesByLoop: new Map([[["episode-1", "episode-2"].join("|"), episodes]]),
  });
  assert.equal(result.evaluations.length, 1);
  assert.equal(result.evaluations[0]?.verdict, "automate");
});

test("dna generator parses batched workflow array output", async () => {
  const loopA: CandidateLoop = {
    loopName: "Weekly changelog",
    episodeIds: ["episode-1", "episode-2"],
    sharedIntent: "Draft changelog",
    sharedSources: ["github"],
    sharedOutputType: "changelog",
    reasoning: "same workflow",
  };
  const evaluation: LoopEvaluation = {
    loopName: "Weekly changelog",
    episodeIds: ["episode-1", "episode-2"],
    confidence: 0.9,
    verdict: "automate",
    reasoning: "high confidence",
    estimatedCadence: "weekly",
    estimatedValue: "high",
    automationReadiness: "full",
    risks: [],
  };
  const useCase = new DnaGeneratorUseCase(async () => ({
    text: JSON.stringify({
      workflows: [
        {
          name: "Weekly changelog",
          trigger: { type: "schedule", cadence: "0 9 * * 1" },
          sources: ["github"],
          outputType: "changelog",
          stepPattern: ["Collect commits", "Draft notes"],
          style: "concise",
          approvalBehavior: "auto",
          reasoning: "weekly pattern",
          episodeIds: ["episode-1", "episode-2"],
        },
        {},
      ],
    }),
    model: "gpt-4.1-nano",
    finishReason: "stop",
    usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
  }));
  const result = await useCase.execute({
    qualifiedLoops: [{ candidateLoop: loopA, evaluation, episodes: [episode("1", "changelog"), episode("2", "changelog")] }],
  });
  assert.ok(result.dna.length >= 1);
  assert.equal(result.dna[0]?.workflowDna.name, "Weekly changelog");
});

test("repository createWorkflowSuggestion skips existing pending duplicate and inserts loop miner metadata", async () => {
  const originalQuery = pool.query.bind(pool);
  const repository = new LoopMinerRepository();
  const candidateLoop: CandidateLoop = {
    loopName: "Weekly changelog",
    episodeIds: ["episode-1", "episode-2"],
    sharedIntent: "Draft changelog",
    sharedSources: ["github"],
    sharedOutputType: "changelog",
    reasoning: "same task",
  };
  const evaluation: LoopEvaluation = {
    loopName: "Weekly changelog",
    episodeIds: ["episode-1", "episode-2"],
    confidence: 0.9,
    verdict: "automate",
    reasoning: "valuable",
    estimatedCadence: "weekly",
    estimatedValue: "high",
    automationReadiness: "full",
    risks: [],
  };
  const dna: WorkflowDNA = {
    name: "Weekly changelog",
    trigger: { type: "schedule", cadence: "0 9 * * 1" },
    sources: ["github"],
    outputType: "changelog",
    stepPattern: ["Collect commits", "Draft notes"],
    style: "concise",
    approvalBehavior: "require_explicit_approval",
    reasoning: "weekly",
  };

  try {
    (pool as unknown as { query: typeof pool.query }).query = (async (sql: string) => {
      if (sql.includes("status = 'pending'")) return { rows: [{ id: "existing" }], rowCount: 1 } as unknown;
      return { rows: [], rowCount: 0 } as unknown;
    }) as typeof pool.query;
    const duplicate = await repository.createWorkflowSuggestion({
      auth,
      runId: "run-1",
      candidateLoop,
      evaluation,
      dna,
      suggestedPrompt: "Automate changelog",
      fingerprint: "loop-miner-duplicate",
    });
    assert.equal(duplicate, null);

    let insertedMetadata: unknown = null;
    (pool as unknown as { query: typeof pool.query }).query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id")) return { rows: [], rowCount: 0 } as unknown;
      if (sql.includes("INSERT INTO workflow_suggestions")) {
        insertedMetadata = JSON.parse(String(params?.[9] ?? "{}"));
        return { rows: [], rowCount: 1 } as unknown;
      }
      return { rows: [], rowCount: 0 } as unknown;
    }) as typeof pool.query;
    const inserted = await repository.createWorkflowSuggestion({
      auth,
      runId: "run-1",
      candidateLoop,
      evaluation,
      dna,
      suggestedPrompt: "Automate changelog",
      fingerprint: "loop-miner-new",
    });
    assert.equal(inserted?.title, "Weekly changelog");
    assert.deepEqual((insertedMetadata as { episodeIds?: string[] }).episodeIds, ["episode-1", "episode-2"]);
  } finally {
    (pool as unknown as { query: typeof pool.query }).query = originalQuery;
  }
});
