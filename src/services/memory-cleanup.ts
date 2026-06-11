import type { AuthContext } from "../domain/auth/index.js";
import { config } from "../config/index.js";
import { decryptMemoryContent } from "../infrastructure/crypto/memory-crypto.js";
import { MemoryCleanupRepository } from "../infrastructure/repositories/memory-cleanup.repository.js";
import { invalidateBm25Cache } from "../infrastructure/recall/hybrid-retrieval.js";
import { bumpRecallStamp } from "../infrastructure/recall/fast-recall.js";
import { createLogger } from "../observability/index.js";
import { CleanupAdversaryUseCase } from "../orchestration/memory-cleanup/adversary.usecase.js";
import { ApplyCleanupProposalUseCase } from "../orchestration/memory-cleanup/apply.usecase.js";
import { CleanupConsolidatorUseCase } from "../orchestration/memory-cleanup/consolidator.usecase.js";
import { CleanupDebateUseCase } from "../orchestration/memory-cleanup/debate.usecase.js";
import { CleanupJudgeUseCase } from "../orchestration/memory-cleanup/judge.usecase.js";
import { BuildCleanupSnapshotUseCase } from "../orchestration/memory-cleanup/snapshot.usecase.js";
import type {
  CleanupProposalInput,
  CleanupRunReason,
  MemoryCleanupRunView,
  MemoryCleanupSummary,
} from "../orchestration/memory-cleanup/types.js";
import type { LoopMinerSummary } from "../orchestration/loop-miner/core/loop-miner.types.js";
import type { MemorySelectionStrategy } from "../orchestration/memory/hybrid-memory-selection.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage } from "../orchestration/memory-cleanup/usage.js";
import { invalidateRecallCache } from "./memory.js";
import { sendResendEmail } from "./notifications/resend-email.js";

export interface RunMemoryCleanupOptions {
  maxMemories?: number;
  dryRun?: boolean;
  runReason?: CleanupRunReason;
  processAll?: boolean;
  includeReviewed?: boolean;
  logImplicitKeeps?: boolean;
  selectionStrategy?: MemorySelectionStrategy;
  newestLimit?: number;
  interestingLimit?: number;
  candidateLimit?: number;
}

const DEFAULT_MAX_MEMORIES = 500;
const PROCESS_ALL_BATCH_SIZE = 500;
const DEFAULT_NEWEST_LIMIT = 150;
const DEFAULT_INTERESTING_LIMIT = 50;
const logger = createLogger({ baseFields: { component: "memory_cleanup" } });

const cleanupRepository = new MemoryCleanupRepository();
const snapshotUseCase = new BuildCleanupSnapshotUseCase({
  listCandidateMemories: cleanupRepository.listCandidateMemories.bind(cleanupRepository),
  decryptMemoryContent,
});
const consolidatorUseCase = new CleanupConsolidatorUseCase();
const adversaryUseCase = new CleanupAdversaryUseCase();
const debateUseCase = new CleanupDebateUseCase();
const judgeUseCase = new CleanupJudgeUseCase();
const applyUseCase = new ApplyCleanupProposalUseCase({
  cleanupRepository,
  invalidateRecallCache,
  invalidateBm25Cache,
  bumpRecallStamp,
});

function emptySummary(overrides: Partial<MemoryCleanupSummary> = {}): MemoryCleanupSummary {
  return {
    proposed: 0,
    contested: 0,
    approved: 0,
    rejected: 0,
    applied: 0,
    failed: 0,
    kept: 0,
    bucketed: 0,
    shortTerm: 0,
    longTerm: 0,
    permanent: 0,
    promoted: 0,
    merged: 0,
    rewritten: 0,
    pruned: 0,
    ...overrides,
  };
}

function incrementType(summary: MemoryCleanupSummary, proposal: CleanupProposalInput): void {
  if (proposal.proposalType === "bucket") {
    summary.bucketed += 1;
    if (proposal.bucket === "short_term") summary.shortTerm += 1;
    if (proposal.bucket === "long_term") summary.longTerm += 1;
    if (proposal.bucket === "permanent") summary.permanent += 1;
  }
  if (proposal.proposalType === "keep") summary.kept += 1;
  if (proposal.proposalType === "promote") summary.promoted += 1;
  if (proposal.proposalType === "merge") summary.merged += 1;
  if (proposal.proposalType === "rewrite") summary.rewritten += 1;
  if (proposal.proposalType === "prune") summary.pruned += 1;
}

function errorJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

export async function listMemoryCleanupRuns(auth: AuthContext): Promise<MemoryCleanupRunView[]> {
  return cleanupRepository.listRuns(auth);
}

export async function getMemoryCleanupRun(auth: AuthContext, runId: string): Promise<MemoryCleanupRunView | null> {
  return cleanupRepository.getRunView(auth, runId);
}

export interface MemoryCleanupAdminEmailResult {
  sent: boolean;
  skipped: boolean;
  to: string | null;
  error?: string;
}

function formatCurrency(value: number | undefined): string {
  return `$${(value ?? 0).toFixed(6)}`;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendMemoryCleanupAdminEmail(input: {
  auth: AuthContext;
  run: MemoryCleanupRunView;
  source: "manual" | "daily_intelligence";
  dailyRunId?: string;
  suggestionCount?: number;
  loopMiner?: { runId: string; status: string; summary: LoopMinerSummary };
}): Promise<MemoryCleanupAdminEmailResult> {
  if (!config.adminEmail) {
    return { sent: false, skipped: true, to: null, error: "TALLEI_ADMIN__EMAIL is not configured" };
  }
  const usage = input.run.summary.usage;
  const models = usage?.models
    ? Object.entries(usage.models).map(([model, count]) => `${model}: ${count}`).join(", ")
    : "none";
  const lines = [
    `Tallei memory cleanup completed (${input.source}).`,
    "",
    `Tenant: ${input.auth.tenantId}`,
    `User: ${input.auth.userId}`,
    input.dailyRunId ? `Daily run: ${input.dailyRunId}` : null,
    `Cleanup run: ${input.run.id}`,
    `Status: ${input.run.status}`,
    `Dry run: ${input.run.dryRun}`,
    "",
    `Selected memories: ${input.run.summary.selectedMemories ?? 0}`,
    `Bucketed: ${input.run.summary.bucketed ?? 0}`,
    `Short term: ${input.run.summary.shortTerm ?? 0}`,
    `Long term: ${input.run.summary.longTerm ?? 0}`,
    `Permanent: ${input.run.summary.permanent ?? 0}`,
    `Applied: ${input.run.summary.applied}`,
    `Rejected: ${input.run.summary.rejected}`,
    `Failed: ${input.run.summary.failed}`,
    input.suggestionCount === undefined ? null : `Workflow suggestions: ${input.suggestionCount}`,
    input.loopMiner ? "" : null,
    input.loopMiner ? `Loop miner run: ${input.loopMiner.runId}` : null,
    input.loopMiner ? `Loop miner status: ${input.loopMiner.status}` : null,
    input.loopMiner ? `Loop miner episodes: ${input.loopMiner.summary.episodesBuilt}` : null,
    input.loopMiner ? `Loop miner loops detected: ${input.loopMiner.summary.loopsDetected}` : null,
    input.loopMiner ? `Loop miner loops qualified: ${input.loopMiner.summary.loopsQualified}` : null,
    input.loopMiner ? `Loop miner suggestions: ${input.loopMiner.summary.suggestionsCreated}` : null,
    input.loopMiner?.summary.skipped ? `Loop miner skipped: ${input.loopMiner.summary.skipReason ?? "unknown"}` : null,
    "",
    `AI calls: ${usage?.calls ?? input.run.summary.aiCalls ?? 0}`,
    `Provider prompt tokens: ${usage?.promptTokens ?? 0}`,
    `Provider completion tokens: ${usage?.completionTokens ?? 0}`,
    `Provider total tokens: ${usage?.totalTokens ?? 0}`,
    `Estimated prompt tokens: ${usage?.estimatedPromptTokens ?? 0}`,
    `Estimated completion tokens: ${usage?.estimatedCompletionTokens ?? 0}`,
    `Estimated total tokens: ${usage?.estimatedTotalTokens ?? 0}`,
    `Estimated cost: ${formatCurrency(usage?.estimatedCostUsd)}`,
    `Models: ${models}`,
  ].filter((line): line is string => line !== null);
  const text = lines.join("\n");
  const result = await sendResendEmail({
    to: config.adminEmail,
    subject: input.source === "manual"
      ? "Tallei manual memory cleanup stats"
      : "Tallei daily memory cleanup stats",
    text,
    html: `<pre style="font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap;">${htmlEscape(text)}</pre>`,
  });

  if (!result.ok) {
    const error = result.error ?? `HTTP ${result.status ?? 0}`;
    logger.error("cleanup admin email failed", { runId: input.run.id, to: config.adminEmail, error });
    return { sent: false, skipped: false, to: config.adminEmail, error };
  }
  logger.info("cleanup admin email sent", { runId: input.run.id, to: config.adminEmail, source: input.source });
  return { sent: true, skipped: false, to: config.adminEmail };
}

export async function resetMemoryCleanupReviewFlags(auth: AuthContext): Promise<{
  resetCount: number;
  bucketMetadataResetCount: number;
}> {
  const resetCount = await cleanupRepository.resetMemoryReviewFlags(auth);
  const bucketMetadataResetCount = await cleanupRepository.resetMemoryBucketMetadata(auth);
  return { resetCount, bucketMetadataResetCount };
}

export async function runMemoryCleanupForUser(
  auth: AuthContext,
  options: RunMemoryCleanupOptions = {}
): Promise<MemoryCleanupRunView> {
  const runReason = options.runReason ?? "manual";
  const dryRun = options.dryRun ?? (runReason === "manual");
  const processAll = options.processAll ?? true;
  const includeReviewed = options.includeReviewed ?? false;
  const logImplicitKeeps = options.logImplicitKeeps ?? false;
  const selectionStrategy = options.selectionStrategy ?? "current_priority";
  const maxMemories = processAll
    ? Math.max(1, options.maxMemories ?? PROCESS_ALL_BATCH_SIZE)
    : Math.max(1, Math.min(options.maxMemories ?? DEFAULT_MAX_MEMORIES, 500));
  const newestLimit = processAll
    ? maxMemories
    : Math.max(1, Math.min(options.newestLimit ?? DEFAULT_NEWEST_LIMIT, maxMemories));
  const interestingLimit = processAll
    ? 0
    : Math.max(0, Math.min(options.interestingLimit ?? DEFAULT_INTERESTING_LIMIT, maxMemories - newestLimit));
  const candidateLimit = Math.max(maxMemories, options.candidateLimit ?? 2_000);
  const startedAt = Date.now();

  if (runReason === "daily_intelligence") {
    if (await cleanupRepository.hasRunningDailyCleanup(auth)) {
      return {
        id: "skipped-running",
        status: "completed",
        runReason,
        dryRun,
        summary: emptySummary({ skipped: true, skipReason: "running_cleanup_exists" }),
        proposals: [],
      };
    }
    if (await cleanupRepository.hasCompletedDailyCleanupToday(auth)) {
      return {
        id: "skipped-completed-today",
        status: "completed",
        runReason,
        dryRun,
        summary: emptySummary({ skipped: true, skipReason: "completed_cleanup_exists_today" }),
        proposals: [],
      };
    }
  }

  const runId = await cleanupRepository.createRun({ auth, runReason, dryRun });
  let summary = emptySummary();
  let aiCalls = 0;
  const usage = emptyCleanupAiUsage();

  try {
    logger.info("cleanup run started", { runId, runReason, dryRun, maxMemories });
    const snapshotSummaries: unknown[] = [];
    const seenMemoryIds = new Set<string>();
    let batchCount = 0;

    while (true) {
      const snapshot = await snapshotUseCase.execute(auth, maxMemories, includeReviewed, [...seenMemoryIds], {
        strategy: selectionStrategy,
        newestLimit,
        interestingLimit,
        candidateLimit,
      });
      if (snapshot.memoryCount === 0) break;
      for (const memoryId of snapshot.selectedMemoryIds) seenMemoryIds.add(memoryId);

      batchCount += 1;
      snapshotSummaries.push({
        batch: batchCount,
        memoryCount: snapshot.memoryCount,
        selectedMemoryIds: snapshot.selectedMemoryIds,
        duplicateGroups: snapshot.duplicateGroups,
        staleCandidateIds: snapshot.staleCandidateIds,
        conflictCandidateIds: snapshot.conflictCandidateIds,
        protectedMemoryIds: snapshot.protectedMemoryIds,
        bucketCounts: snapshot.bucketCounts,
        selection: snapshot.selection,
      });
      summary.selectedMemories = (summary.selectedMemories ?? 0) + snapshot.memoryCount;
      if (snapshot.selection) {
        summary.memorySelection = {
          ...(summary.memorySelection ?? {
            considered: 0,
            selected: 0,
            newestSelected: 0,
            interestingSelected: 0,
            candidateLimit: snapshot.selection.candidateLimit,
            truncated: false,
          }),
          considered: (summary.memorySelection?.considered ?? 0) + snapshot.selection.considered,
          selected: (summary.memorySelection?.selected ?? 0) + snapshot.selection.selected,
          newestSelected: (summary.memorySelection?.newestSelected ?? 0) + snapshot.selection.newestSelected,
          interestingSelected: (summary.memorySelection?.interestingSelected ?? 0) + snapshot.selection.interestingSelected,
          candidateLimit: Math.max(summary.memorySelection?.candidateLimit ?? 0, snapshot.selection.candidateLimit),
          truncated: Boolean(summary.memorySelection?.truncated || snapshot.selection.truncated),
        };
      }
      logger.info("cleanup snapshot built", { runId, batch: batchCount, selectedMemories: snapshot.memoryCount });

      const consolidated = await consolidatorUseCase.execute(snapshot);
      aiCalls += consolidated.aiCalls;
      mergeCleanupAiUsage(usage, consolidated.usage);
      summary.proposed += consolidated.proposals.length;
      logger.info("cleanup proposals generated", { runId, batch: batchCount, proposed: consolidated.proposals.length });

      if (logImplicitKeeps) {
        const memoryIdsWithActions = new Set<string>();
        for (const proposal of consolidated.proposals) {
          for (const memoryId of proposal.sourceMemoryIds) memoryIdsWithActions.add(memoryId);
        }
        const implicitKeepIds = snapshot.selectedMemoryIds.filter((memoryId) => !memoryIdsWithActions.has(memoryId));
        for (const memoryId of implicitKeepIds) {
          const keepProposal: CleanupProposalInput = {
            proposalType: "keep",
            sourceMemoryIds: [memoryId],
            targetMemoryId: null,
            proposedContent: null,
            rationale: "No cleanup action candidate matched thresholds; keep memory unchanged.",
            riskLevel: "low",
            confidence: 0.99,
          };
          await cleanupRepository.createProposal({
            auth,
            runId,
            proposal: keepProposal,
            status: dryRun ? "approved" : "applied",
            consolidatorJson: {
              implicit: true,
              reason: "no_action_candidate",
              batch: batchCount,
            },
          });
          summary.proposed += 1;
          summary.approved += 1;
          summary.kept += 1;
          if (!dryRun) summary.applied += 1;
        }
      }

      for (const initialProposal of consolidated.proposals) {
        const proposalId = await cleanupRepository.createProposal({
          auth,
          runId,
          proposal: initialProposal,
          consolidatorJson: consolidated.raw,
        });

        if (initialProposal.proposalType === "bucket") {
          summary.approved += 1;
          incrementType(summary, initialProposal);
          if (dryRun) {
            await cleanupRepository.updateProposal({
              auth,
              proposalId,
              status: "approved",
              proposal: initialProposal,
              judgeJson: {
                decision: "approve",
                confidence: initialProposal.bucketConfidence ?? initialProposal.confidence,
                rationale: initialProposal.rationale,
                applyAllowed: false,
                bucketFastPath: true,
              },
            });
            continue;
          }

          const applied = await applyUseCase.execute({ auth, proposalId, proposal: initialProposal });
          if (applied.applied) {
            summary.applied += 1;
            await cleanupRepository.updateProposal({
              auth,
              proposalId,
              status: "applied",
              applyJson: applied.applyJson,
              judgeJson: {
                decision: "approve",
                confidence: initialProposal.bucketConfidence ?? initialProposal.confidence,
                rationale: initialProposal.rationale,
                applyAllowed: true,
                bucketFastPath: true,
              },
            });
          } else {
            summary.failed += 1;
          }
          continue;
        }

        const adversary = await adversaryUseCase.execute({ snapshot, proposal: initialProposal });
        aiCalls += adversary.aiCalls;
        mergeCleanupAiUsage(usage, adversary.usage);
        if (adversary.result.contested) summary.contested += 1;
        await cleanupRepository.updateProposal({
          auth,
          proposalId,
          status: adversary.result.contested ? "contested" : "proposed",
          adversaryJson: adversary.result,
        });

        const debate = await debateUseCase.execute({
          snapshot,
          proposal: initialProposal,
          adversary: adversary.result,
        });
        aiCalls += debate.aiCalls;
        mergeCleanupAiUsage(usage, debate.usage);

        const judge = await judgeUseCase.execute({
          snapshot,
          proposal: initialProposal,
          adversary: adversary.result,
          debate: debate.result,
        });
        aiCalls += judge.aiCalls;
        mergeCleanupAiUsage(usage, judge.usage);

        const finalProposal = judge.result.finalProposal;
        const approved = judge.result.applyAllowed;
        if (!approved) {
          summary.rejected += 1;
          await cleanupRepository.updateProposal({
            auth,
            proposalId,
            status: "rejected",
            proposal: finalProposal,
            debateJson: debate.result.rounds,
            judgeJson: judge.result,
          });
          continue;
        }

        summary.approved += 1;
        await cleanupRepository.updateProposal({
          auth,
          proposalId,
          status: "approved",
          proposal: finalProposal,
          debateJson: debate.result.rounds,
          judgeJson: judge.result,
        });

        if (dryRun) {
          incrementType(summary, finalProposal);
          continue;
        }

        const applied = await applyUseCase.execute({ auth, proposalId, proposal: finalProposal });
        if (applied.applied) {
          summary.applied += 1;
          incrementType(summary, finalProposal);
          await cleanupRepository.updateProposal({
            auth,
            proposalId,
            status: "applied",
            applyJson: applied.applyJson,
          });
        } else {
          summary.failed += 1;
        }
      }

      if (!dryRun) {
        await cleanupRepository.markMemoriesReviewed({
          auth,
          runId,
          memoryIds: snapshot.selectedMemoryIds,
          status: "reviewed",
          metadata: { batch: batchCount },
        });
      }

      if (!processAll || snapshot.memoryCount < maxMemories) break;
    }

    await cleanupRepository.updateRunSnapshot({
      auth,
      runId,
      snapshot: { batches: snapshotSummaries },
    });

    summary.durationMs = Date.now() - startedAt;
    summary.aiCalls = aiCalls;
    summary.usage = {
      ...usage,
      estimatedCostUsd: Number(usage.estimatedCostUsd.toFixed(6)),
    };
    summary.batches = batchCount;
    summary.remainingUnreviewed = await cleanupRepository.countUnreviewedMemories(auth);
    await cleanupRepository.completeRun({ auth, runId, status: "completed", summary });
    logger.info("cleanup run completed", { runId, ...summary });
    const view = await cleanupRepository.getRunView(auth, runId);
    return view ?? {
      id: runId,
      status: "completed",
      runReason,
      dryRun,
      summary,
      proposals: [],
    };
  } catch (error) {
    summary = {
      ...summary,
      durationMs: Date.now() - startedAt,
      aiCalls,
      usage: {
        ...usage,
        estimatedCostUsd: Number(usage.estimatedCostUsd.toFixed(6)),
      },
    };
    await cleanupRepository.completeRun({
      auth,
      runId,
      status: "failed",
      summary,
      error: errorJson(error),
    }).catch(() => {});
    logger.error("cleanup run failed", { runId, error: errorJson(error) });
    const view = await cleanupRepository.getRunView(auth, runId);
    if (view) return view;
    return {
      id: runId,
      status: "failed",
      runReason,
      dryRun,
      summary,
      proposals: [],
    };
  }
}
