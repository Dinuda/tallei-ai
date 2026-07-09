import { modelGateway } from "../../model/index.js";
import type { AppModelRequest } from "../../model/types.js";
import { JUDGE_SYSTEM_PROMPT } from "./prompts.js";
import { compactSnapshotForAi, normalizeConfidence, normalizeProposal, readJsonObject, validateProposal } from "./proposal-utils.js";
import type { AdversaryResult, CleanupAiUsage, CleanupProposalInput, CleanupSnapshot, DebateResult, JudgeResult } from "./types.js";
import { emptyCleanupAiUsage, recordCleanupAiUsage } from "./usage.js";

const APPROVAL_THRESHOLDS: Record<CleanupProposalInput["proposalType"], number> = {
  bucket: 0.7,
  keep: 0,
  promote: 0.75,
  rewrite: 0.85,
  merge: 0.85,
  prune: 0.92,
};

function isDestructive(type: CleanupProposalInput["proposalType"]): boolean {
  return type === "prune" || type === "merge";
}

function applyAllowedByPolicy(proposal: CleanupProposalInput, confidence: number, snapshot: CleanupSnapshot): boolean {
  if (validateProposal(proposal, snapshot) !== null) return false;
  if (proposal.proposalType === "keep") return true;
  if (confidence < APPROVAL_THRESHOLDS[proposal.proposalType]) return false;

  const protectedIds = new Set(snapshot.protectedMemoryIds);
  const touchesProtected = proposal.sourceMemoryIds.some((id) => protectedIds.has(id));
  if (touchesProtected && isDestructive(proposal.proposalType)) {
    if (proposal.proposalType === "merge" && confidence >= 0.97) {
      const duplicateGroup = snapshot.duplicateGroups.some((group) =>
        proposal.sourceMemoryIds.every((id) => group.memoryIds.includes(id))
      );
      return duplicateGroup;
    }
    return false;
  }

  return true;
}

export class CleanupJudgeUseCase {
  async execute(input: {
    snapshot: CleanupSnapshot;
    proposal: CleanupProposalInput;
    adversary: AdversaryResult;
    debate: DebateResult;
  }): Promise<{ result: JudgeResult; raw: unknown; aiCalls: number; usage: CleanupAiUsage }> {
    // Fast-path: if adversary was not contested and debate was skipped, decide deterministically
    if (!input.adversary.contested && input.debate.rounds.length === 0) {
      const proposal = input.debate.finalProposal;
      const confidence = proposal.confidence;
      const policyAllows = applyAllowedByPolicy(proposal, confidence, input.snapshot);
      const applyAllowed = policyAllows && input.adversary.recommendedAction !== "reject";
      return {
        result: {
          decision: applyAllowed ? "approve" : "reject",
          finalProposal: proposal,
          confidence,
          rationale: applyAllowed ? "Approved: adversary fast-path, no contest." : "Rejected by cleanup safety policy.",
          applyAllowed,
        },
        raw: { skipped: "adversary_fast_path" },
        aiCalls: 0,
        usage: emptyCleanupAiUsage(),
      };
    }

    const request: AppModelRequest = {
      purpose: "chat",
      model: modelGateway.chatModelName(),
      temperature: 0,
      maxTokens: 600,
      responseFormat: "json",
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            snapshot: compactSnapshotForAi(input.snapshot),
            originalProposal: input.proposal,
            adversary: input.adversary,
            debate: input.debate,
            thresholds: APPROVAL_THRESHOLDS,
          }),
        },
      ],
    };
    const response = await modelGateway.chat(request);
    const usage = emptyCleanupAiUsage();
    recordCleanupAiUsage(usage, request, response);

    const raw = readJsonObject(response.text ?? "");
    const decision = raw.decision === "approve" || raw.decision === "modify" || raw.decision === "reject"
      ? raw.decision
      : "reject";
    const finalProposal = normalizeProposal(raw.finalProposal) ?? input.debate.finalProposal;
    const confidence = normalizeConfidence(raw.confidence ?? finalProposal.confidence);
    const policyAllows = applyAllowedByPolicy(finalProposal, confidence, input.snapshot);
    const applyAllowed = Boolean(raw.applyAllowed) && policyAllows && decision !== "reject";

    return {
      result: {
        decision: applyAllowed ? decision : "reject",
        finalProposal,
        confidence,
        rationale: typeof raw.rationale === "string" && raw.rationale.trim()
          ? raw.rationale.trim()
          : applyAllowed
            ? "Approved by policy."
            : "Rejected by cleanup safety policy.",
        applyAllowed,
      },
      raw,
      aiCalls: 1,
      usage,
    };
  }
}
