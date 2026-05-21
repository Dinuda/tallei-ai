import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";

import type { AuthContext } from "../../../src/domain/auth/index.js";
import { pool } from "../../../src/infrastructure/db/index.js";
import { encryptMemoryContent } from "../../../src/infrastructure/crypto/memory-crypto.js";
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
  LoopMinerMemoryDecision,
  LoopMinerRepository as LoopMinerRepositoryContract,
  LoopMinerSuggestion,
  LoopMinerSummary,
  MinerEvent,
  WorkflowDNA,
} from "../../../src/orchestration/loop-miner/types.js";
import {
  chunkEventsByTimeGap,
  compactMinerEvent,
  consolidateWorkspaceGroupedHits,
  deriveCanonicalLoopFacet,
  deriveWorkspaceTracePayload,
  episodeEmbeddingText,
  evaluateProjectProgression,
  estimateTokens,
  explicitWorkflowMemoryExtraction,
  LOOP_EPISODE_EXTRACTION_VERSION,
  normalizeEpisodeExtraction,
  normalizeCandidateLoop,
  normalizeLoopEvaluation,
  normalizeWorkflowDna,
  packByEstimatedPromptBudget,
  prefilterEpisodesByOutputType,
  sourceFingerprintFromEvent,
} from "../../../src/orchestration/loop-miner/utils.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../../../src/providers/ai/types.js";

const auth: AuthContext = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  authMode: "internal",
  plan: "pro",
};

after(() => {
  const rawPool = pool as unknown as {
    end: () => Promise<void>;
    _clients?: Array<{ end?: () => void }>;
    _idle?: Array<{ client?: { end?: () => void } }>;
  };
  for (const client of rawPool._clients ?? []) client.end?.();
  for (const idle of rawPool._idle ?? []) idle.client?.end?.();
  void rawPool.end().catch(() => {});
});

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

function memoryEvent(id: string, createdAt: string, contentSummary = "Memory\nType: fact\nDraft weekly changelog from GitHub commits"): MinerEvent {
  return {
    id,
    sourceEventType: "memory_record",
    createdAt,
    platform: "chatgpt",
    contentSummary,
    role: "user",
    metadata: { sourceImport: true, minerImportance: 0.8 },
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

function evidenceFingerprintForTest(events: MinerEvent[]): string {
  const fingerprints = events
    .filter((item) => item.sourceEventType === "memory_record")
    .map((item) => sourceFingerprintFromEvent(item, LOOP_EPISODE_EXTRACTION_VERSION))
    .sort();
  return createHash("sha256").update(JSON.stringify({
    extractionVersion: LOOP_EPISODE_EXTRACTION_VERSION,
    fingerprints,
  })).digest("hex");
}

function completedIncrementalSummary(evidenceFingerprint: string): LoopMinerSummary {
  return {
    episodesBuilt: 0,
    loopsDetected: 0,
    loopsQualified: 0,
    suggestionsCreated: 0,
    durationMs: 0,
    aiCalls: 0,
    usage: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedPromptTokens: 0,
      estimatedCompletionTokens: 0,
      estimatedTotalTokens: 0,
      estimatedCostUsd: 0,
      models: {},
    },
    incremental: {
      mode: "full",
      evidenceFingerprint,
      extractionVersion: LOOP_EPISODE_EXTRACTION_VERSION,
      totalEvidenceEvents: 0,
      newEvidenceEvents: 0,
      reusedEpisodes: 0,
      newEpisodes: 0,
      reusedSuggestions: 0,
      suggestionsUpdated: 0,
    },
    phaseUsage: {},
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

test("loop miner compacts collab task summaries by prioritizing high-signal lines", () => {
  const contentSummary = [
    "raw transcript paragraph ".repeat(80),
    "Title: Series A narrative deck",
    "Goal: Build investor-ready storyline",
    "Output: slides",
    "raw transcript paragraph ".repeat(80),
  ].join("\n");
  const compacted = compactMinerEvent({
    id: "collab-1",
    sourceEventType: "collab_task",
    createdAt: "2026-05-01T09:00:00.000Z",
    platform: "chatgpt",
    contentSummary,
    role: "user",
    metadata: {},
  }, { contentSummaryCharCap: 260 });
  assert.ok(compacted.contentSummary.length <= 260);
  assert.match(compacted.contentSummary, /Title: Series A narrative deck/);
  assert.match(compacted.contentSummary, /Output: slides/);
});

test("loop miner converts explicit recurring imported memories into workflow episodes", () => {
  const extraction = explicitWorkflowMemoryExtraction({
    id: "memory-1",
    sourceEventType: "memory_record",
    createdAt: "2026-05-17T10:30:00.000Z",
    platform: "chatgpt",
    role: "user",
    contentSummary: [
      "Imported ChatGPT memory",
      "Type: fact",
      "Source datetime: 2026-05-17T16:00:00+05:30",
      "Every Friday afternoon I review product analytics and write down three experiments for the next week.",
    ].join("\n"),
    metadata: {
      sourceImport: true,
      minerImportance: 0.72,
    },
  });
  assert.ok(extraction);
  assert.equal(extraction.outputType, "workflow_memory");
  assert.equal(extraction.automationSignals?.repeatable, true);
  assert.equal(extraction.automationSignals?.likelyCadence, "weekly");
  assert.deepEqual(extraction.eventIds, ["memory-1"]);
});

test("loop miner converts imported newsletter work memories into newsletter episodes", () => {
  const extraction = explicitWorkflowMemoryExtraction({
    id: "memory-newsletter-1",
    sourceEventType: "memory_record",
    createdAt: "2026-05-20T16:01:00.000Z",
    platform: "chatgpt",
    role: "user",
    contentSummary: [
      "Imported ChatGPT memory",
      "Type: fact",
      "My newsletter writing workflow involves using ChatGPT to brainstorm hooks, sharpen product philosophy, and turn technical architecture ideas into readable narratives.",
    ].join("\n"),
    metadata: {
      sourceImport: true,
      minerImportance: 0.72,
    },
  });
  assert.ok(extraction);
  assert.equal(extraction.outputType, "newsletter");
  assert.equal(extraction.automationSignals?.repeatable, true);
  assert.deepEqual(extraction.eventIds, ["memory-newsletter-1"]);
});

test("episode builder reuses LLM memory episode by source fingerprint", async () => {
  const existing: EpisodeRecord = {
    id: "episode-reused-1",
    title: "Weekly analytics routine",
    summary: "Reused",
    intent: "Every Friday review product analytics and write experiments",
    sources: ["Imported ChatGPT memory"],
    outputType: "workflow_memory",
    toolNames: ["chatgpt"],
    steps: ["Review analytics", "Write experiments"],
    approved: true,
    eventIds: ["memory-1"],
    sourceFingerprint: "fingerprint-1",
    extractionVersion: "loop_episode_extraction_v2",
    sealedAt: "2026-05-17T10:30:00.000Z",
    turnCount: 1,
    turns: [{
      role: "user",
      contentSummary: "Every Friday review product analytics and write experiments",
      sourceEventType: "memory_record",
      sourceEventId: "memory-1",
      createdAt: "2026-05-17T10:30:00.000Z",
    }],
  };

  let created = 0;
  const repository: Pick<LoopMinerRepositoryContract, "createEpisode" | "findReusableEpisodeBySourceFingerprint"> = {
    async findReusableEpisodeBySourceFingerprint() {
      return existing;
    },
    async createEpisode() {
      created += 1;
      return existing;
    },
  };

  const useCase = new EpisodeBuilderUseCase(repository, async () => ({
    text: JSON.stringify({
      episodes: [{
        intent: "Every Friday review product analytics and write experiments",
        sources: ["Imported ChatGPT memory"],
        outputType: "workflow_memory",
        toolNames: ["chatgpt"],
        steps: ["Review analytics", "Write experiments"],
        approved: true,
        eventIds: ["memory-1"],
      }],
    }),
    model: "gpt-4.1-nano",
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }));

  const result = await useCase.execute({
    auth,
    runId: "run-1",
    events: [{
      id: "memory-1",
      sourceEventType: "memory_record",
      createdAt: "2026-05-17T10:30:00.000Z",
      platform: "chatgpt",
      role: "user",
      contentSummary: [
        "Imported ChatGPT memory",
        "Type: fact",
        "Every Friday review product analytics and write experiments",
      ].join("\n"),
      metadata: { sourceImport: true },
    }],
  });

  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0]?.id, "episode-reused-1");
  assert.equal(created, 0);
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

test("loop miner normalizer preserves expanded collab output types", () => {
  const extraction = normalizeEpisodeExtraction({
    intent: "Build week 2 course deck",
    output: { type: "slides", description: "AI course lesson slides" },
    eventIds: ["event-1"],
  }, new Set(["event-1"]));
  assert.ok(extraction);
  assert.equal(extraction?.outputType, "slides");
  assert.equal(extraction?.output?.type, "slides");
});

test("loop canonicalization strips structural tokens and flags sequential project progression", () => {
  const week2: EpisodeRecord = {
    ...episode("w2", "slides"),
    title: "Week 2 slide pack",
    intent: "Create Week 2 slide pack for AI course module",
    steps: ["Draft lesson layout", "Refine slide copy"],
    turns: [{
      role: "user",
      contentSummary: "Create Week 2 slide pack for AI course module",
      sourceEventType: "collab_task",
      sourceEventId: "event-w2",
      createdAt: "2026-05-01T09:00:00.000Z",
    }],
  };
  const week3: EpisodeRecord = {
    ...episode("w3", "slides"),
    title: "Week 3 course material",
    intent: "Create Week 3 course material for AI course module",
    steps: ["Draft lesson layout", "Refine slide copy"],
    turns: [{
      role: "user",
      contentSummary: "Create Week 3 course material for AI course module",
      sourceEventType: "collab_task",
      sourceEventId: "event-w3",
      createdAt: "2026-05-08T09:00:00.000Z",
    }],
  };

  const facet2 = deriveCanonicalLoopFacet(week2);
  const facet3 = deriveCanonicalLoopFacet(week3);
  assert.ok(!/\bweek\s*2\b/.test(facet2.abstractedJtbd));
  assert.ok(!/\bweek\s*3\b/.test(facet3.abstractedJtbd));
  const progression = evaluateProjectProgression([week2, week3]);
  assert.equal(progression.isProjectProgression, true);
});

test("loop canonicalization maps different topics to one mechanism signature", () => {
  const episodeA: EpisodeRecord = {
    ...episode("m1", "document"),
    intent: "Turn vague orchestration input into clean copy-pastable workflow instructions",
    steps: ["Expand into structure", "Debloat copy", "Finalize deliverable"],
  };
  const episodeB: EpisodeRecord = {
    ...episode("m2", "document"),
    intent: "Turn rough MCP notes into clean copy-pastable operating instructions",
    steps: ["Expand into structure", "Debloat copy", "Finalize deliverable"],
  };
  const facetA = deriveCanonicalLoopFacet(episodeA);
  const facetB = deriveCanonicalLoopFacet(episodeB);
  assert.equal(facetA.mechanismSignature, facetB.mechanismSignature);
  assert.match(episodeEmbeddingText(episodeA), /mechanismSignature=/);
});

test("workspace trace payload derives canonical metadata and provenance", () => {
  const row: EpisodeRecord = {
    ...episode("trace-1", "spreadsheet"),
    title: "Quarterly spreadsheet audit run",
    intent: "Audit spreadsheet formulas and reconcile budget variance for finance ops",
    sources: ["Finance Ops Sheet"],
    toolNames: ["chatgpt"],
    sealedAt: "2026-05-21T08:30:00.000Z",
  };

  const payload = deriveWorkspaceTracePayload(row, [0.1, 0.2, 0.3]);
  assert.equal(payload.id, "trace-1");
  assert.equal(payload.metadata.subject_anchor, "Finance Ops Sheet");
  assert.equal(payload.metadata.operational_domain, "Calculations");
  assert.ok(payload.metadata.input_artifact_classes.includes("spreadsheet"));
  assert.ok(payload.metadata.output_artifact_classes.includes("spreadsheet"));
  assert.equal(payload.provenance.platform, "chatgpt");
  assert.equal(payload.provenance.written_at, "2026-05-21T08:30:00.000Z");
});

test("workspace grouped-hit consolidation merges >92% artifact-overlap groups and sorts runs chronologically", () => {
  const consolidated = consolidateWorkspaceGroupedHits([
    {
      subjectAnchor: "AI Makers Curriculum",
      runs: [{
        id: "point-2",
        episodeId: "episode-2",
        text: "Run 2",
        score: 0.82,
        metadata: {
          subject_anchor: "AI Makers Curriculum",
          operational_domain: "System_Design",
          input_artifact_classes: ["docx", "blueprint_notes"],
          output_artifact_classes: ["markdown"],
          category: "document",
        },
        provenance: {
          platform: "chatgpt",
          written_at: "2026-05-22T08:00:00.000Z",
        },
      }],
    },
    {
      subjectAnchor: "MCP Orchestration Notes",
      runs: [{
        id: "point-1",
        episodeId: "episode-1",
        text: "Run 1",
        score: 0.86,
        metadata: {
          subject_anchor: "MCP Orchestration Notes",
          operational_domain: "System_Design",
          input_artifact_classes: ["docx", "blueprint_notes"],
          output_artifact_classes: ["markdown"],
          category: "document",
        },
        provenance: {
          platform: "chatgpt",
          written_at: "2026-05-21T08:00:00.000Z",
        },
      }],
    },
  ]);

  assert.equal(consolidated.length, 1);
  assert.equal(consolidated[0]?.historicalRuns.length, 2);
  assert.equal(consolidated[0]?.historicalRuns[0]?.episodeId, "episode-1");
  assert.equal(consolidated[0]?.historicalRuns[1]?.episodeId, "episode-2");
});

test("repository listRecentEvents gives fresh imports higher memory evidence importance", async () => {
  const originalQuery = pool.query.bind(pool);
  const repository = new LoopMinerRepository();
  const queries: string[] = [];
  try {
    (pool as unknown as { query: typeof pool.query }).query = (async (sql: string) => {
      queries.push(sql);
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
      if (sql.includes("FROM memory_records")) {
        return {
          rows: [{
            id: "33333333-3333-4333-8333-333333333333",
            content_ciphertext: encryptMemoryContent("Every Monday I prepare the product metrics report."),
            platform: "chatgpt",
            memory_type: "fact",
            category: "workflow",
            is_pinned: false,
            importance: "0.5000",
            summary_json: {
              source_import: true,
              source_platform: "chatgpt",
              source_datetime: "2026-05-04",
              source_import_batch_id: "batch-1",
              import_detected_memory_type: "fact",
            },
            created_at: "2026-05-04T09:00:00.000Z",
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
    assert.equal(events.length, 3);
    assert.equal(events[0]?.sourceEventType, "ai_activity_event");
    assert.equal(events[0]?.contentSummary, "Create this week's company newsletter from Tallei product notes.");
    assert.equal(events[1]?.sourceEventType, "collab_task");
    assert.match(events[1]?.contentSummary ?? "", /Week 6 slides/);
    const memoryEvents = events.filter((event) => event.sourceEventType === "memory_record");
    assert.equal(memoryEvents.length, 1);
    assert.equal((memoryEvents[0]?.metadata as Record<string, unknown>).minerImportance, 0.72);
    assert.match(memoryEvents[0]?.contentSummary ?? "", /Imported ChatGPT memory/);
    assert.equal(queries.length, 3);
  } finally {
    (pool as unknown as { query: typeof pool.query }).query = originalQuery;
  }
});

test("repository listMemoryDecisionLog explains included and excluded memories", async () => {
  const originalQuery = pool.query.bind(pool);
  const repository = new LoopMinerRepository();
  try {
    (pool as unknown as { query: typeof pool.query }).query = (async (sql: string) => {
      assert.match(sql, /FROM memory_records/);
      return {
        rows: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            content_ciphertext: encryptMemoryContent("Every Monday I prepare the product metrics report."),
            platform: "chatgpt",
            memory_type: "fact",
            category: "workflow",
            is_pinned: false,
            importance: "0.5000",
            summary_json: {
              source_import: true,
              source_platform: "chatgpt",
              source_datetime: "2026-05-04",
              source_import_batch_id: "batch-1",
              source_import_mode: "paste",
              import_detected_memory_type: "fact",
            },
            created_at: "2026-05-04T09:00:00.000Z",
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            content_ciphertext: encryptMemoryContent("Remember to check demo feedback before launch planning."),
            platform: "chatgpt",
            memory_type: "note",
            category: "project",
            is_pinned: false,
            importance: "0.5000",
            summary_json: {},
            created_at: "2026-05-05T09:00:00.000Z",
          },
          {
            id: "55555555-5555-4555-8555-555555555555",
            content_ciphertext: encryptMemoryContent("Long-term note that is already bucketed."),
            platform: "chatgpt",
            memory_type: "note",
            category: "profile",
            is_pinned: false,
            importance: "0.5000",
            summary_json: { cleanup_bucket: "long_term" },
            created_at: "2026-05-06T09:00:00.000Z",
          },
        ],
        rowCount: 3,
      } as unknown;
    }) as typeof pool.query;

    const decisions = await repository.listMemoryDecisionLog(auth, 30);
    assert.equal(decisions.length, 3);
    assert.equal(decisions[0]?.status, "included");
    assert.equal(decisions[0]?.reason, "fresh_source_import_selected");
    assert.equal(decisions[0]?.sourceImportBatchId, "batch-1");
    assert.equal(decisions[0]?.sourceDateTime, "2026-05-04");
    assert.match(decisions[0]?.contentPreview ?? "", /product metrics report/);
    assert.equal(decisions[1]?.status, "excluded");
    assert.equal(decisions[1]?.reason, "unbucketed_memory_deprioritized");
    assert.equal(decisions[2]?.status, "excluded");
    assert.equal(decisions[2]?.reason, "bucketed_memory_deprioritized");
  } finally {
    (pool as unknown as { query: typeof pool.query }).query = originalQuery;
  }
});

class InMemoryLoopMinerRepository implements LoopMinerRepositoryContract {
  events: MinerEvent[];
  memoryDecisions: LoopMinerMemoryDecision[];
  episodes = new Map<string, EpisodeRecord>();
  reusableSuggestions: LoopMinerSuggestion[] = [];
  latestIncrementalState: { evidenceFingerprint: string; summary: LoopMinerSummary } | null = null;
  suggestionsCreated = 0;
  suggestionsUpdated = 0;
  completedSummary: LoopMinerSummary | null = null;

  constructor(events: MinerEvent[], memoryDecisions: LoopMinerMemoryDecision[] = []) {
    this.events = events;
    this.memoryDecisions = memoryDecisions;
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

  async listMemoryDecisionLog(): Promise<LoopMinerMemoryDecision[]> {
    return this.memoryDecisions;
  }

  async getLatestCompletedIncrementalState(): Promise<{ evidenceFingerprint: string; summary: LoopMinerSummary } | null> {
    return this.latestIncrementalState;
  }

  async findEpisodesBySourceFingerprints(input: {
    sourceFingerprints: string[];
    extractionVersion: string;
  }): Promise<Map<string, EpisodeRecord>> {
    const requested = new Set(input.sourceFingerprints);
    const result = new Map<string, EpisodeRecord>();
    for (const episode of this.episodes.values()) {
      if (!episode.sourceFingerprint || !requested.has(episode.sourceFingerprint)) continue;
      if (episode.extractionVersion !== input.extractionVersion) continue;
      result.set(episode.sourceFingerprint, episode);
    }
    return result;
  }

  async findEpisodesBySourceEventIds(input: {
    sourceEventIds: string[];
    sourceEventType?: string;
  }): Promise<Map<string, EpisodeRecord>> {
    const requested = new Set(input.sourceEventIds);
    const result = new Map<string, EpisodeRecord>();
    for (const episode of this.episodes.values()) {
      for (const turn of episode.turns) {
        if (!requested.has(turn.sourceEventId)) continue;
        if (input.sourceEventType && turn.sourceEventType !== input.sourceEventType) continue;
        if (!result.has(turn.sourceEventId)) result.set(turn.sourceEventId, episode);
      }
    }
    return result;
  }

  async listReusableLoopMinerSuggestions(): Promise<LoopMinerSuggestion[]> {
    return this.reusableSuggestions;
  }

  async createEpisode(input: {
    extraction: EpisodeExtraction;
    turns: EpisodeTurnRecord[];
    sourceFingerprint?: string;
    extractionVersion?: string;
  }): Promise<EpisodeRecord> {
    const id = `episode-${this.episodes.size + 1}`;
    const record: EpisodeRecord = {
      id,
      ...input.extraction,
      sourceFingerprint: input.sourceFingerprint,
      extractionVersion: input.extractionVersion,
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
    const suggestion = {
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
    this.reusableSuggestions.push(suggestion);
    return suggestion;
  }

  async createOrUpdateWorkflowSuggestion(input: {
    evaluation: LoopEvaluation;
    dna: WorkflowDNA;
    suggestedPrompt: string;
    fingerprint: string;
  }) {
    const existing = this.reusableSuggestions.find((suggestion) => suggestion.fingerprint === input.fingerprint);
    if (existing) {
      this.suggestionsUpdated += 1;
      const updated = {
        ...existing,
        reason: input.evaluation.reasoning,
        suggestedPrompt: input.suggestedPrompt,
        confidence: Math.max(existing.confidence, input.evaluation.confidence),
        triggerCount: Math.max(existing.triggerCount, input.evaluation.episodeIds.length),
      };
      this.reusableSuggestions = this.reusableSuggestions.map((suggestion) => suggestion.id === existing.id ? updated : suggestion);
      return { suggestion: updated, created: false, updated: true };
    }
    const suggestion = await this.createWorkflowSuggestion(input);
    return { suggestion, created: true, updated: false };
  }
}

test("runLoopMinerForUser skips heavy phases when loop evidence is unchanged", async () => {
  const events = [
    memoryEvent("e1", "2026-05-04T09:00:00.000Z"),
    memoryEvent("e2", "2026-05-11T09:00:00.000Z"),
    event("activity-new", "2026-05-18T09:00:00.000Z"),
  ];
  const evidenceFingerprint = evidenceFingerprintForTest(events.slice(0, 2));
  const repository = new InMemoryLoopMinerRepository(events);
  repository.latestIncrementalState = {
    evidenceFingerprint,
    summary: completedIncrementalSummary(evidenceFingerprint),
  };
  repository.reusableSuggestions = [{
    id: "suggestion-existing",
    title: "Weekly changelog",
    reason: "Already detected",
    suggestedPrompt: "Automate weekly changelog",
    status: "pending",
    confidence: 0.91,
    fingerprint: "loop-miner-existing",
    triggerCount: 4,
    createdAt: "2026-05-20T00:00:00.000Z",
  }];
  const chat = async (): Promise<ChatCompletionResponse> => {
    throw new Error("unexpected LLM call");
  };

  const result = await runLoopMinerForUser(auth, { runReason: "manual" }, {
    repository,
    episodeBuilder: new EpisodeBuilderUseCase(repository, chat),
    loopDetector: new LoopDetectorUseCase(chat),
    loopEvaluator: new LoopEvaluatorUseCase(chat),
    dnaGenerator: new DnaGeneratorUseCase(chat),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.summary.skipped, true);
  assert.equal(result.summary.skipReason, "no_new_loop_evidence");
  assert.equal(result.summary.aiCalls, 0);
  assert.equal(result.summary.incremental?.mode, "skipped_no_new_evidence");
  assert.equal(result.summary.incremental?.reusedSuggestions, 1);
  assert.equal(result.suggestions[0]?.id, "suggestion-existing");
  assert.equal(repository.episodes.size, 0);
});

test("runLoopMinerForUser only builds new evidence and evaluates loops containing it", async () => {
  const oldEvent = memoryEvent("e-old", "2026-05-04T09:00:00.000Z");
  const newEvent = memoryEvent("e-new", "2026-05-11T09:00:00.000Z");
  const unrelatedNewActivity = event("activity-new", "2026-05-18T09:00:00.000Z");
  const oldFingerprint = sourceFingerprintFromEvent(oldEvent, LOOP_EPISODE_EXTRACTION_VERSION);
  const previousFingerprint = evidenceFingerprintForTest([oldEvent]);
  const repository = new InMemoryLoopMinerRepository([oldEvent, newEvent, unrelatedNewActivity]);
  repository.latestIncrementalState = {
    evidenceFingerprint: previousFingerprint,
    summary: completedIncrementalSummary(previousFingerprint),
  };
  repository.episodes.set("episode-old", {
    ...episode("old", "changelog"),
    id: "episode-old",
    eventIds: [oldEvent.id],
    sourceFingerprint: oldFingerprint,
    extractionVersion: LOOP_EPISODE_EXTRACTION_VERSION,
    turns: [{
      role: oldEvent.role,
      contentSummary: oldEvent.contentSummary,
      sourceEventType: "memory_record",
      sourceEventId: oldEvent.id,
      createdAt: oldEvent.createdAt,
    }],
  });

  const responses = [
    { groups: [
      { episodeIds: ["episode-old", "episode-2"], loopName: "Weekly changelog", sharedIntent: "Draft changelog from GitHub", sharedSources: ["github"], sharedOutputType: "changelog", reasoning: "new evidence reinforces existing loop", status: "approved_loop", confidence: 0.9 },
      { episodeIds: ["episode-old", "episode-stale"], loopName: "Old only", sharedIntent: "Old work", sharedSources: ["github"], sharedOutputType: "changelog", reasoning: "should be invalid because stale id is unknown", status: "approved_loop", confidence: 0.9 },
    ] },
    { evaluations: [{ loopName: "Weekly changelog", episodeIds: ["episode-old", "episode-2"], confidence: 0.91, verdict: "automate", reasoning: "new evidence confirms recurrence", estimatedCadence: "weekly", estimatedValue: "high", automationReadiness: "full", risks: [] }] },
    { workflows: [{ name: "Weekly changelog", trigger: { type: "schedule", cadence: "weekly" }, sources: ["github"], outputType: "changelog", stepPattern: ["Collect commits", "Draft notes"], style: "concise", approvalBehavior: "auto", reasoning: "weekly cadence", episodeIds: ["episode-old", "episode-2"] }] },
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

  const result = await runLoopMinerForUser(auth, { runReason: "manual" }, {
    repository,
    episodeBuilder: new EpisodeBuilderUseCase(repository, chat),
    loopDetector: new LoopDetectorUseCase(chat),
    loopEvaluator: new LoopEvaluatorUseCase(chat),
    dnaGenerator: new DnaGeneratorUseCase(chat),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.summary.incremental?.mode, "incremental");
  assert.equal(result.summary.incremental?.newEvidenceEvents, 1);
  assert.equal(result.summary.incremental?.reusedEpisodes, 1);
  assert.equal(result.summary.incremental?.newEpisodes, 1);
  assert.equal(result.summary.episodesBuilt, 1);
  assert.equal(result.summary.phaseUsage?.episodeBuilder?.inputEvents, 1);
  assert.equal(result.summary.phaseUsage?.loopDetector?.inputEpisodes, 2);
  assert.equal(result.summary.loopsDetected, 1);
  assert.equal(result.summary.suggestionsCreated, 1);
  assert.equal(result.suggestions[0]?.title, "Weekly changelog");
  assert.equal(responses.length, 0);
});

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
    { groups: [{ episodeIds: ["episode-1", "episode-2", "episode-3", "episode-4"], loopName: "Weekly changelog", sharedIntent: "Draft changelog from GitHub", sharedSources: ["github"], sharedOutputType: "changelog", reasoning: "same repeated output", status: "approved_loop", confidence: 0.9 }] },
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
  assert.ok(Object.values(result.summary.usage.models).some((count) => count > 0));
  assert.ok((result.summary.phaseUsage?.episodeBuilder?.tokensPerOutputEpisode ?? 0) > 0);
  assert.equal(result.summary.patternTrace?.approvedGroups.length, 1);
  assert.equal(responses.length, 0);
});

test("runLoopMinerForUser falls back to included memory decisions when memory events are absent", async () => {
  const repository = new InMemoryLoopMinerRepository([], [
    {
      memoryId: "memory-newsletter-1",
      status: "included",
      reason: "fresh_source_import_selected",
      contentPreview: "My newsletter writing workflow involves using ChatGPT to brainstorm hooks, sharpen product philosophy, and turn technical architecture ideas into readable narratives.",
      createdAt: "2026-05-20T14:03:03.561Z",
      selectedAt: "2026-05-20T16:01:00.000Z",
      memoryType: "fact",
      detectedMemoryType: "fact",
      category: null,
      cleanupBucket: "long_term",
      isPinned: false,
      sourceImport: true,
      sourcePlatform: "chatgpt",
      sourceImportMode: "json_export",
      sourceImportBatchId: "batch-newsletter",
      sourceDateTime: "2026-05-20T21:31:00+05:30",
      minerImportance: 0.72,
      memoryImportance: 0.6,
    },
    {
      memoryId: "memory-newsletter-2",
      status: "included",
      reason: "fresh_source_import_selected",
      contentPreview: "My newsletter writing workflow uses ChatGPT to brainstorm hooks, sharpen product philosophy, and turn technical architecture ideas into readable narratives.",
      createdAt: "2026-05-20T14:03:03.557Z",
      selectedAt: "2026-05-19T15:18:00.000Z",
      memoryType: "fact",
      detectedMemoryType: "fact",
      category: null,
      cleanupBucket: "long_term",
      isPinned: false,
      sourceImport: true,
      sourcePlatform: "chatgpt",
      sourceImportMode: "json_export",
      sourceImportBatchId: "batch-newsletter",
      sourceDateTime: "2026-05-19T20:48:00+05:30",
      minerImportance: 0.72,
      memoryImportance: 0.6,
    },
  ]);
  const responses = [
    { groups: [{ episodeIds: ["episode-1", "episode-2"], loopName: "Newsletter writing pattern", sharedIntent: "Write Tallei newsletters with ChatGPT support", sharedSources: ["Imported ChatGPT memory"], sharedOutputType: "newsletter", reasoning: "shared newsletter artifact and AI-assisted writing workflow", status: "approved_loop", confidence: 0.84 }] },
    { evaluations: [{ loopName: "Newsletter writing pattern", episodeIds: ["episode-1", "episode-2"], confidence: 0.5, verdict: "discard", reasoning: "test stops before suggestion creation", estimatedCadence: "implicit", estimatedValue: "medium", automationReadiness: "partial", risks: [] }] },
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

  const result = await runLoopMinerForUser(auth, { runReason: "manual" }, {
    repository,
    episodeBuilder: new EpisodeBuilderUseCase(repository, chat),
    loopDetector: new LoopDetectorUseCase(chat),
    loopEvaluator: new LoopEvaluatorUseCase(chat),
    dnaGenerator: new DnaGeneratorUseCase(chat),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.summary.episodesBuilt, 2);
  assert.equal(result.summary.loopsDetected, 1);
  assert.equal(result.summary.loopsQualified, 0);
  assert.equal(result.summary.memorySelection?.included, 2);
  assert.equal(result.summary.patternTrace?.candidateGroups.length, 1);
  assert.equal(result.summary.patternTrace?.approvedGroups.length, 1);
  assert.equal(repository.completedSummary?.phaseUsage?.loopDetector?.inputEpisodes, 2);
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
    if (callCount === 2 || callCount === 3) {
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
  assert.ok((result.summary.warnings?.length ?? 0) >= 1);
  assert.ok((result.summary.warnings ?? []).some((warning) => /TimeoutError/.test(warning)));
  assert.equal(callCount, 3);
});

test("loop detector does not register a single explicit memory-derived workflow as a loop candidate", async () => {
  const memoryEpisode: EpisodeRecord = {
    id: "episode-memory-1",
    title: "Every Friday product analytics review",
    summary: "Imported memory describes a recurring analytics review.",
    intent: "Every Friday afternoon I review product analytics and write down three experiments for the next week.",
    sources: ["Imported ChatGPT memory"],
    outputType: "workflow_memory",
    toolNames: ["chatgpt"],
    steps: ["Review product analytics", "Write down three experiments"],
    approved: true,
    eventIds: ["memory-1"],
    sealedAt: "2026-05-17T10:30:00.000Z",
    turnCount: 1,
    automationSignals: {
      repeatable: true,
      likelyCadence: "weekly",
      businessValue: 0.72,
      automationReadiness: 0.72,
    },
    turns: [{
      role: "user",
      contentSummary: "Every Friday afternoon I review product analytics and write down three experiments for the next week.",
      sourceEventType: "memory_record",
      sourceEventId: "memory-1",
      createdAt: "2026-05-17T10:30:00.000Z",
    }],
  };
  const detector = new LoopDetectorUseCase(async () => {
    throw new Error("detector LLM should not be called for a single memory entry");
  });
  const result = await detector.execute([memoryEpisode]);
  assert.equal(result.loops.length, 0);
  assert.equal(result.patternTrace.candidateGroups.length, 0);
  assert.equal(result.aiCalls, 0);
});

test("loop detector groups multiple single memory entries when their workflows match", async () => {
  const makeRoutineMemoryEpisode = (id: string, intent: string, createdAt: string): EpisodeRecord => ({
    id,
    title: intent,
    summary: `Imported memory describes a recurring workflow or reusable work routine: ${intent}`,
    intent,
    sources: ["Imported ChatGPT memory"],
    outputType: "workflow_memory",
    toolNames: ["chatgpt"],
    steps: [intent],
    approved: true,
    eventIds: [`memory-${id}`],
    sealedAt: createdAt,
    turnCount: 1,
    automationSignals: {
      repeatable: true,
      likelyCadence: "weekly",
      businessValue: 0.72,
      automationReadiness: 0.72,
    },
    turns: [{
      role: "user",
      contentSummary: intent,
      sourceEventType: "memory_record",
      sourceEventId: `memory-${id}`,
      createdAt,
    }],
  });
  const detector = new LoopDetectorUseCase(async () => ({
    text: JSON.stringify({ groups: [{ episodeIds: ["episode-memory-1", "episode-memory-2"], loopName: "Product analytics review", sharedIntent: "Review product analytics and write experiments", sharedSources: ["Imported ChatGPT memory"], sharedOutputType: "workflow_memory", reasoning: "matching_memory_entries", status: "approved_loop", confidence: 0.9 }] }),
    model: "gpt-4.1-nano",
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));
  const result = await detector.execute([
    makeRoutineMemoryEpisode(
      "episode-memory-1",
      "Every Friday afternoon I review product analytics and write down three experiments for the next week.",
      "2026-05-03T10:30:00.000Z"
    ),
    makeRoutineMemoryEpisode(
      "episode-memory-2",
      "Each Friday I review product analytics and write down three experiments for the following week.",
      "2026-05-17T10:30:00.000Z"
    ),
  ]);
  assert.equal(result.loops.length, 1);
  assert.deepEqual(result.loops[0]?.episodeIds, ["episode-memory-1", "episode-memory-2"]);
  assert.match(result.patternTrace.candidateGroups[0]?.generationReason ?? "", /matching_memory_entries/);
});

test("loop detector groups repeated imported newsletter memories without explicit cadence", async () => {
  const makeNewsletterEpisode = (id: string, intent: string): EpisodeRecord => ({
    id,
    title: intent,
    summary: `Imported memory describes an AI-assisted work episode: ${intent}`,
    intent,
    sources: ["Imported ChatGPT memory"],
    outputType: "newsletter",
    toolNames: ["chatgpt"],
    steps: [intent],
    approved: true,
    eventIds: [`memory-${id}`],
    sealedAt: "2026-05-20T10:30:00.000Z",
    turnCount: 1,
    automationSignals: {
      repeatable: true,
      likelyCadence: "unknown",
      businessValue: 0.72,
      automationReadiness: 0.72,
    },
    turns: [{
      role: "user",
      contentSummary: intent,
      sourceEventType: "memory_record",
      sourceEventId: `memory-${id}`,
      createdAt: "2026-05-20T10:30:00.000Z",
    }],
  });
  const detector = new LoopDetectorUseCase(async () => ({
    text: JSON.stringify({ groups: [{ episodeIds: ["episode-newsletter-1", "episode-newsletter-2"], loopName: "Newsletter writing pattern", sharedIntent: "Write newsletter with ChatGPT", sharedSources: ["Imported ChatGPT memory"], sharedOutputType: "newsletter", reasoning: "matching_memory_entries", status: "approved_loop", confidence: 0.84 }] }),
    model: "gpt-4.1-nano",
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));
  const result = await detector.execute([
    makeNewsletterEpisode("episode-newsletter-1", "My newsletter writing workflow uses ChatGPT to brainstorm hooks, sharpen product philosophy, and turn technical architecture ideas into readable narratives."),
    makeNewsletterEpisode("episode-newsletter-2", "My newsletter writing workflow uses ChatGPT to brainstorm hooks, sharpen product philosophy, and turn technical architecture ideas into readable narratives."),
  ]);
  const newsletterLoop = result.loops.find((loop) => loop.loopName.toLowerCase().includes("newsletter"));
  assert.ok(newsletterLoop);
  assert.equal(newsletterLoop.episodeIds.length, 2);
  assert.equal(result.patternTrace.approvedGroups.length, 1);
  assert.match(result.patternTrace.candidateGroups[0]?.generationReason ?? "", /matching_memory_entries/);
});

test("loop detector rejects imported memory entries that only share artifact/source or wow-factor wording", async () => {
  const makeMemoryEpisode = (id: string, intent: string): EpisodeRecord => ({
    id,
    title: intent,
    summary: `Imported memory describes an AI-assisted work episode: ${intent}`,
    intent,
    sources: ["Imported ChatGPT memory"],
    outputType: "newsletter",
    toolNames: ["chatgpt"],
    steps: [intent],
    approved: true,
    eventIds: [`memory-${id}`],
    sealedAt: "2026-05-20T10:30:00.000Z",
    turnCount: 1,
    automationSignals: {
      repeatable: false,
      likelyCadence: "unknown",
      businessValue: 0.72,
      automationReadiness: 0.72,
    },
    turns: [{
      role: "user",
      contentSummary: intent,
      sourceEventType: "memory_record",
      sourceEventId: `memory-${id}`,
      createdAt: "2026-05-20T10:30:00.000Z",
    }],
  });
  const detector = new LoopDetectorUseCase(async () => {
    throw new Error("detector LLM should not be called for non-matching memory entries");
  });
  const result = await detector.execute([
    makeMemoryEpisode("episode-wow-1", "The product launch newsletter needs a wow factor in the opening story."),
    makeMemoryEpisode("episode-wow-2", "I used ChatGPT to rewrite a newsletter paragraph about pricing objections."),
  ]);
  assert.equal(result.loops.length, 0);
  assert.equal(result.patternTrace.candidateGroups.length, 0);
  assert.equal(result.aiCalls, 0);
});

test("loop detector rejects same-topic groups when judge identifies topical similarity", async () => {
  const makeCourseEpisode = (id: string, intent: string, steps: string[]): EpisodeRecord => ({
    id,
    title: intent,
    summary: intent,
    intent,
    sources: ["AI Makers course"],
    outputType: "slides",
    toolNames: ["chatgpt"],
    steps,
    approved: true,
    eventIds: [`event-${id}`],
    sealedAt: "2026-05-20T10:30:00.000Z",
    turnCount: 1,
    turns: [{
      role: "user",
      contentSummary: intent,
      sourceEventType: "collab_task",
      sourceEventId: `event-${id}`,
      createdAt: "2026-05-20T10:30:00.000Z",
    }],
  });
  const detector = new LoopDetectorUseCase(async () => ({
    text: JSON.stringify({ groups: [{ episodeIds: ["episode-course-1", "episode-course-2"], loopName: "AI course slide work", sharedIntent: "Create AI course materials", sharedSources: ["AI Makers course"], sharedOutputType: "slides", reasoning: "same course topic", status: "rejected_topical_similarity", confidence: 0.78 }] }),
    model: "gpt-4.1-nano",
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));
  const result = await detector.execute([
    makeCourseEpisode("episode-course-1", "Create Week 2 AI Makers slide content about context", ["Draft lesson story", "Create slide copy"]),
    makeCourseEpisode("episode-course-2", "Create Week 3 AI Makers slide content about context", ["Review prior deck", "Create activity slides"]),
  ]);
  assert.equal(result.loops.length, 0);
  assert.equal(result.patternTrace.candidateGroups.length, 1);
  assert.equal(result.patternTrace.rejectedGroups[0]?.status, "rejected_topical_similarity");
});

test("loop detector rejects sequential project progression even when LLM approves", async () => {
  const makeCourseEpisode = (id: string, intent: string): EpisodeRecord => ({
    id,
    title: intent,
    summary: intent,
    intent,
    sources: ["AI Makers course"],
    outputType: "slides",
    toolNames: ["chatgpt"],
    steps: ["Draft lesson layout", "Refine slide copy"],
    approved: true,
    eventIds: [`event-${id}`],
    sealedAt: "2026-05-20T10:30:00.000Z",
    turnCount: 1,
    turns: [{
      role: "user",
      contentSummary: intent,
      sourceEventType: "collab_task",
      sourceEventId: `event-${id}`,
      createdAt: "2026-05-20T10:30:00.000Z",
    }],
  });
  const detector = new LoopDetectorUseCase(async () => ({
    text: JSON.stringify({
      groups: [{
        episodeIds: ["course-2", "course-3"],
        loopName: "AI course slide work",
        sharedIntent: "Create AI course materials",
        sharedSources: ["AI Makers course"],
        sharedOutputType: "slides",
        reasoning: "llm approved",
        status: "approved_loop",
        confidence: 0.92,
      }],
    }),
    model: "gpt-4.1-nano",
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));

  const result = await detector.execute([
    makeCourseEpisode("course-2", "Create Week 2 slide pack for AI Makers"),
    makeCourseEpisode("course-3", "Create Week 3 course material for AI Makers"),
  ]);
  assert.equal(result.loops.length, 0);
  assert.equal(result.patternTrace.rejectedGroups[0]?.status, "rejected_topical_similarity");
});

test("loop detector upgrades exact mechanism matches to approved_loop with max confidence", async () => {
  const makeMechanismEpisode = (id: string, intent: string): EpisodeRecord => ({
    id,
    title: intent,
    summary: intent,
    intent,
    sources: ["chatgpt"],
    outputType: "document",
    toolNames: ["chatgpt"],
    steps: ["Expand into structure", "Debloat copy", "Finalize deliverable"],
    approved: true,
    eventIds: [`event-${id}`],
    sealedAt: "2026-05-20T10:30:00.000Z",
    turnCount: 1,
    turns: [{
      role: "user",
      contentSummary: intent,
      sourceEventType: "ai_activity_event",
      sourceEventId: `event-${id}`,
      createdAt: "2026-05-20T10:30:00.000Z",
    }],
  });
  const detector = new LoopDetectorUseCase(async () => ({
    text: JSON.stringify({
      groups: [{
        episodeIds: ["mech-1", "mech-2"],
        loopName: "Doc prep pattern",
        sharedIntent: "Operational writing",
        sharedSources: ["chatgpt"],
        sharedOutputType: "document",
        reasoning: "candidate monitor",
        status: "monitor_pattern",
        confidence: 0.65,
      }],
    }),
    model: "gpt-4.1-nano",
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));

  const result = await detector.execute([
    makeMechanismEpisode("mech-1", "Turn vague orchestration input into clean copy-pastable workflow instructions"),
    makeMechanismEpisode("mech-2", "Turn rough MCP notes into clean copy-pastable operating instructions"),
  ]);
  assert.equal(result.loops.length, 1);
  assert.equal(result.loops[0]?.patternConfidence, 1);
  assert.equal(result.patternTrace.approvedGroups.length, 1);
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
      if (sql.includes("FROM workflow_suggestions") && sql.includes("status IN ('pending', 'approved', 'dismissed')")) {
        return { rows: [{ id: "existing", status: "approved" }], rowCount: 1 } as unknown;
      }
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

test("repository getRunView returns pending loop suggestions and referenced episodes for skipped reruns", async () => {
  const originalQuery = pool.query.bind(pool);
  const repository = new LoopMinerRepository();
  const runId = "11111111-1111-4111-8111-111111111111";
  const episodeId = "22222222-2222-4222-8222-222222222222";
  const suggestionId = "33333333-3333-4333-8333-333333333333";

  try {
    (pool as unknown as { query: typeof pool.query }).query = (async (sql: string) => {
      if (sql.includes("FROM loop_miner_runs")) {
        return {
          rows: [{
            id: runId,
            status: "completed",
            summary_json: {
              skipped: true,
              skipReason: "no_new_loop_evidence",
              episodesBuilt: 0,
              loopsDetected: 0,
              loopsQualified: 0,
              suggestionsCreated: 0,
              durationMs: 1,
              aiCalls: 0,
              usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedPromptTokens: 0, estimatedCompletionTokens: 0, estimatedTotalTokens: 0, estimatedCostUsd: 0, models: {} },
            },
            error_json: {},
            created_at: "2026-05-21T10:00:00.000Z",
            completed_at: "2026-05-21T10:00:01.000Z",
          }],
          rowCount: 1,
        } as unknown;
      }
      if (sql.includes("FROM episodes") && sql.includes("miner_run_id")) {
        return { rows: [], rowCount: 0 } as unknown;
      }
      if (sql.includes("FROM workflow_suggestions")) {
        return {
          rows: [{
            id: suggestionId,
            title: "Weekly changelog",
            reason: "Existing loop should remain visible",
            suggested_prompt: "Automate weekly changelog",
            confidence: 0.91,
            fingerprint: "loop-miner-existing",
            trigger_count: 2,
            created_at: "2026-05-20T00:00:00.000Z",
            metadata_json: {
              loopMinerRunId: "older-run",
              episodeIds: [episodeId],
              evaluation: { episodeIds: [episodeId], estimatedCadence: "weekly" },
              candidateLoop: { episodeIds: [episodeId] },
            },
          }],
          rowCount: 1,
        } as unknown;
      }
      if (sql.includes("FROM episodes") && sql.includes("id = ANY")) {
        return {
          rows: [{
            id: episodeId,
            intent: "Draft weekly changelog",
            sources: ["github"],
            output_type: "changelog",
            tool_names: ["github"],
            turn_count: 1,
            approved: true,
            extraction_json: { intent: "Draft weekly changelog", sources: ["github"], outputType: "changelog", toolNames: ["github"], steps: ["Review commits"], approved: true, eventIds: ["memory-1"] },
            source_fingerprint: "fp-old",
            extraction_version: LOOP_EPISODE_EXTRACTION_VERSION,
            embedding_text_hash: "hash",
            embedding_status: "ready",
            embedded_at: "2026-05-20T00:00:00.000Z",
            sealed_at: "2026-05-20T00:00:00.000Z",
          }],
          rowCount: 1,
        } as unknown;
      }
      if (sql.includes("FROM episode_turns")) {
        return {
          rows: [{
            episode_id: episodeId,
            role: "user",
            content_summary: "Memory\nType: fact\nDraft weekly changelog from GitHub commits",
            source_event_type: "memory_record",
            source_event_id: "memory-1",
            created_at: "2026-05-20T00:00:00.000Z",
          }],
          rowCount: 1,
        } as unknown;
      }
      return { rows: [], rowCount: 0 } as unknown;
    }) as typeof pool.query;

    const view = await repository.getRunView(auth, runId);
    assert.equal(view?.suggestions.length, 1);
    assert.equal(view?.suggestions[0]?.id, suggestionId);
    assert.equal(view?.episodes.length, 1);
    assert.equal(view?.episodes[0]?.id, episodeId);
  } finally {
    (pool as unknown as { query: typeof pool.query }).query = originalQuery;
  }
});

test("loop detector removes strict subset duplicates when intent/output/source match", async () => {
  const detector = new LoopDetectorUseCase(async () => ({
    text: JSON.stringify({
      groups: [
        {
          episodeIds: ["1", "2", "3"],
          loopName: "Tallei newsletter creation",
          sharedIntent: "Create Tallei weekly newsletter",
          sharedSources: ["chatgpt", "memory"],
          sharedOutputType: "newsletter",
          reasoning: "dominant group",
          status: "approved_loop",
          confidence: 0.9,
        },
        {
          episodeIds: ["1", "2"],
          loopName: "Newsletter subset",
          sharedIntent: "Create Tallei weekly newsletter",
          sharedSources: ["chatgpt"],
          sharedOutputType: "newsletter",
          reasoning: "subset group",
          status: "approved_loop",
          confidence: 0.88,
        },
      ],
    }),
    model: "gpt-4.1-nano",
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));

  const result = await detector.execute([
    episode("1", "newsletter"),
    episode("2", "newsletter"),
    episode("3", "newsletter"),
  ]);

  assert.equal(result.loops.length, 1);
  assert.deepEqual(result.loops[0]?.episodeIds, ["1", "2", "3"]);
});

test("loop detector keeps subset group when intent/output/source do not match", async () => {
  const detector = new LoopDetectorUseCase(async () => ({
    text: JSON.stringify({
      groups: [
        {
          episodeIds: ["1", "2", "3"],
          loopName: "AI course content development",
          sharedIntent: "Develop AI course materials",
          sharedSources: ["course docs"],
          sharedOutputType: "slides",
          reasoning: "course loop",
          status: "approved_loop",
          confidence: 0.86,
        },
        {
          episodeIds: ["1", "2"],
          loopName: "Series A deck prep",
          sharedIntent: "Build series A presentation",
          sharedSources: ["investor notes"],
          sharedOutputType: "deck",
          reasoning: "different loop despite overlap",
          status: "approved_loop",
          confidence: 0.84,
        },
      ],
    }),
    model: "gpt-4.1-nano",
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));

  const result = await detector.execute([
    episode("1", "slides"),
    episode("2", "slides"),
    episode("3", "slides"),
  ]);

  assert.equal(result.loops.length, 2);
});
