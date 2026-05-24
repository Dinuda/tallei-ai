import { aiProviderRegistry } from "../../providers/ai/index.js";
import { CONSOLIDATOR_SYSTEM_PROMPT } from "./prompts.js";
import { compactSnapshotForAi, findCandidate, normalizeProposal, readJsonObject, validateProposal } from "./proposal-utils.js";
import type { CleanupAiUsage, CleanupProposalInput, CleanupSnapshot } from "./types.js";
import { emptyCleanupAiUsage, mergeCleanupAiUsage, recordCleanupAiUsage } from "./usage.js";

function deterministicProposals(snapshot: CleanupSnapshot): CleanupProposalInput[] {
  const proposals: CleanupProposalInput[] = [];
  const covered = new Set<string>();

  for (const memory of snapshot.memories) {
    proposals.push({
      proposalType: "bucket",
      sourceMemoryIds: [memory.id],
      targetMemoryId: null,
      proposedContent: null,
      rationale: memory.bucketReason,
      riskLevel: memory.bucket === "permanent" ? "low" : "medium",
      confidence: memory.bucketConfidence,
      bucket: memory.bucket,
      bucketReason: memory.bucketReason,
      bucketConfidence: memory.bucketConfidence,
    });
  }

  for (const group of snapshot.duplicateGroups) {
    const candidates = group.memoryIds
      .map((id) => findCandidate(snapshot, id))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    if (candidates.length < 2) continue;
    const target = [...candidates].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      if (a.referenceCount !== b.referenceCount) return b.referenceCount - a.referenceCount;
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    })[0];
    proposals.push({
      proposalType: "merge",
      sourceMemoryIds: group.memoryIds,
      targetMemoryId: target.id,
      proposedContent: target.content,
      rationale: "Exact duplicate content hash found; keep the strongest canonical memory and supersede duplicates.",
      riskLevel: candidates.some((candidate) => candidate.protected) ? "medium" : "low",
      confidence: candidates.some((candidate) => candidate.protected) ? 0.97 : 0.99,
      bucket: target.bucket,
      bucketReason: `Canonical memory remains in ${target.bucket}.`,
      bucketConfidence: target.bucketConfidence,
    });
    group.memoryIds.forEach((id) => covered.add(id));
  }

  for (const id of snapshot.staleCandidateIds) {
    if (covered.has(id)) continue;
    const candidate = findCandidate(snapshot, id);
    if (!candidate || candidate.protected) continue;
    proposals.push({
      proposalType: "prune",
      sourceMemoryIds: [id],
      targetMemoryId: null,
      proposedContent: null,
      rationale: "Memory is old, unpinned, low-reference, and not protected.",
      riskLevel: "medium",
      confidence: 0.93,
      bucket: candidate.bucket,
      bucketReason: candidate.bucketReason,
      bucketConfidence: candidate.bucketConfidence,
    });
    covered.add(id);
  }

  return proposals.filter((proposal) => validateProposal(proposal, snapshot) === null);
}

function proposalKey(proposal: CleanupProposalInput): string {
  return `${proposal.proposalType}:${[...proposal.sourceMemoryIds].sort().join(",")}:${proposal.targetMemoryId ?? ""}`;
}

const CONSOLIDATOR_SUB_BATCH_SIZE = 20;

function subSnapshot(snapshot: CleanupSnapshot, batchMemories: CleanupSnapshot["memories"]): CleanupSnapshot {
  const batchIds = new Set(batchMemories.map((memory) => memory.id));
  return {
    ...snapshot,
    memoryCount: batchMemories.length,
    memories: batchMemories,
    selectedMemoryIds: snapshot.selectedMemoryIds.filter((id) => batchIds.has(id)),
    duplicateGroups: snapshot.duplicateGroups.filter((group) =>
      group.memoryIds.some((id) => batchIds.has(id))
    ),
    staleCandidateIds: snapshot.staleCandidateIds.filter((id) => batchIds.has(id)),
    conflictCandidateIds: snapshot.conflictCandidateIds.filter((id) => batchIds.has(id)),
    protectedMemoryIds: snapshot.protectedMemoryIds.filter((id) => batchIds.has(id)),
  };
}

export class CleanupConsolidatorUseCase {
  async execute(snapshot: CleanupSnapshot): Promise<{ proposals: CleanupProposalInput[]; raw: unknown; aiCalls: number; usage: CleanupAiUsage }> {
    if (snapshot.memoryCount === 0) return { proposals: [], raw: { skipped: "empty_snapshot" }, aiCalls: 0, usage: emptyCleanupAiUsage() };
    const deterministic = deterministicProposals(snapshot);

    // Split into small sub-batches and run in parallel to avoid timeout
    const subBatches: CleanupSnapshot["memories"][] = [];
    for (let i = 0; i < snapshot.memories.length; i += CONSOLIDATOR_SUB_BATCH_SIZE) {
      subBatches.push(snapshot.memories.slice(i, i + CONSOLIDATOR_SUB_BATCH_SIZE));
    }

    const batchResults = await Promise.all(subBatches.map(async (batchMemories, batchIdx) => {
      const sub = subSnapshot(snapshot, batchMemories);
      const request = {
        model: aiProviderRegistry.chatModelName(),
        temperature: 0,
        maxTokens: 900,
        responseFormat: "json_object",
        messages: [
          { role: "system", content: CONSOLIDATOR_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              snapshot: compactSnapshotForAi(sub),
              batch: `${batchIdx + 1}/${subBatches.length}`,
            }),
          },
        ],
      } as const;
      const response = await aiProviderRegistry.chat(request);
      const callUsage = emptyCleanupAiUsage();
      recordCleanupAiUsage(callUsage, request, response);
      const raw = readJsonObject(response.text);
      const rawProposals = Array.isArray(raw.proposals) ? raw.proposals : [];
      return { raw, rawProposals, usage: callUsage };
    }));

    const usage = emptyCleanupAiUsage();
    const allRaw: unknown[] = [];
    const aiProposals: CleanupProposalInput[] = [];
    for (const batch of batchResults) {
      mergeCleanupAiUsage(usage, batch.usage);
      allRaw.push(batch.raw);
      for (const item of batch.rawProposals) {
        const proposal = normalizeProposal(item);
        if (proposal && validateProposal(proposal, snapshot) === null) {
          aiProposals.push(proposal);
        }
      }
    }

    const seen = new Set<string>();
    const proposals = [...deterministic, ...aiProposals].filter((proposal) => {
      const key = proposalKey(proposal);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      proposals,
      raw: { deterministic, ai: allRaw },
      aiCalls: subBatches.length,
      usage,
    };
  }
}
