import { aiProviderRegistry } from "../../providers/ai/index.js";
import { ADVERSARY_SYSTEM_PROMPT } from "./prompts.js";
import { compactSnapshotForAi, normalizeRiskLevel, readJsonObject } from "./proposal-utils.js";
import type { AdversaryResult, CleanupAiUsage, CleanupProposalInput, CleanupSnapshot } from "./types.js";
import { emptyCleanupAiUsage, recordCleanupAiUsage } from "./usage.js";

function fallbackAdversary(proposal: CleanupProposalInput, snapshot: CleanupSnapshot): AdversaryResult {
  const protectedIds = new Set(snapshot.protectedMemoryIds);
  const touchesProtected = proposal.sourceMemoryIds.some((id) => protectedIds.has(id));
  const destructive = proposal.proposalType === "prune" || proposal.proposalType === "merge";
  const contested =
    (destructive && proposal.riskLevel === "high") ||
    (touchesProtected && destructive) ||
    (proposal.proposalType === "merge" && proposal.confidence < 0.8) ||
    (proposal.proposalType === "prune" && proposal.confidence < 0.9) ||
    (proposal.proposalType === "rewrite" && proposal.confidence < 0.85);
  return {
    contested,
    riskLevel: touchesProtected && destructive ? "high" : proposal.riskLevel,
    critique: contested ? "Proposal needs more evidence before applying." : "No major objection.",
    failureModes: contested ? ["insufficient_evidence"] : [],
    recommendedAction: contested ? "reject" : "approve",
  };
}

export class CleanupAdversaryUseCase {
  async execute(input: {
    snapshot: CleanupSnapshot;
    proposal: CleanupProposalInput;
  }): Promise<{ result: AdversaryResult; raw: unknown; aiCalls: number; usage: CleanupAiUsage }> {
    if (input.proposal.proposalType === "keep") {
      return {
        result: {
          contested: false,
          riskLevel: "low",
          critique: "Keep proposals are safe.",
          failureModes: [],
          recommendedAction: "approve",
        },
        raw: { skipped: "keep" },
        aiCalls: 0,
        usage: emptyCleanupAiUsage(),
      };
    }

    const deterministic = fallbackAdversary(input.proposal, input.snapshot);
    const request = {
      model: aiProviderRegistry.chatModelName(),
      temperature: 0,
      maxTokens: 900,
      responseFormat: "json_object",
      messages: [
        { role: "system", content: ADVERSARY_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            snapshot: compactSnapshotForAi(input.snapshot),
            proposal: input.proposal,
            deterministicRisk: deterministic,
          }),
        },
      ],
    } as const;
    const response = await aiProviderRegistry.chat(request);
    const usage = emptyCleanupAiUsage();
    recordCleanupAiUsage(usage, request, response);

    const raw = readJsonObject(response.text);
    const recommendedAction = raw.recommendedAction === "approve" || raw.recommendedAction === "modify" || raw.recommendedAction === "reject"
      ? raw.recommendedAction
      : deterministic.recommendedAction;
    const result: AdversaryResult = {
      contested: Boolean(raw.contested) || deterministic.contested,
      riskLevel: normalizeRiskLevel(raw.riskLevel, deterministic.riskLevel),
      critique: typeof raw.critique === "string" && raw.critique.trim() ? raw.critique.trim() : deterministic.critique,
      failureModes: Array.isArray(raw.failureModes)
        ? raw.failureModes.filter((item): item is string => typeof item === "string")
        : deterministic.failureModes,
      recommendedAction,
    };

    return { result, raw, aiCalls: 1, usage };
  }
}
