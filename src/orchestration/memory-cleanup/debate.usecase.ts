import { modelGateway } from "../../model/index.js";
import type { AppModelRequest } from "../../model/types.js";
import { DEBATE_SYSTEM_PROMPT } from "./prompts.js";
import { compactSnapshotForAi, normalizeProposal, readJsonObject, validateProposal } from "./proposal-utils.js";
import type { AdversaryResult, CleanupAiUsage, CleanupProposalInput, CleanupSnapshot, DebateResult } from "./types.js";
import { emptyCleanupAiUsage, recordCleanupAiUsage } from "./usage.js";

export class CleanupDebateUseCase {
  async execute(input: {
    snapshot: CleanupSnapshot;
    proposal: CleanupProposalInput;
    adversary: AdversaryResult;
  }): Promise<{ result: DebateResult; raw: unknown; aiCalls: number; usage: CleanupAiUsage }> {
    if (!input.adversary.contested) {
      return {
        result: { rounds: [], finalProposal: input.proposal },
        raw: { skipped: "not_contested" },
        aiCalls: 0,
        usage: emptyCleanupAiUsage(),
      };
    }

    const request: AppModelRequest = {
      purpose: "chat",
      model: modelGateway.chatModelName(),
      temperature: 0,
      maxTokens: 1500,
      responseFormat: "json",
      messages: [
        { role: "system", content: DEBATE_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            snapshot: compactSnapshotForAi(input.snapshot),
            proposal: input.proposal,
            adversary: input.adversary,
            maxRounds: 2,
          }),
        },
      ],
    };
    const response = await modelGateway.chat(request);
    const usage = emptyCleanupAiUsage();
    recordCleanupAiUsage(usage, request, response);

    const raw = readJsonObject(response.text ?? "");
    const finalProposal = normalizeProposal(raw.finalProposal) ?? input.proposal;
    const safeFinalProposal = validateProposal(finalProposal, input.snapshot) === null
      ? finalProposal
      : { ...input.proposal, proposalType: "keep" as const, rationale: "Debate produced an invalid proposal; defaulted to keep.", riskLevel: "low" as const, confidence: 1 };
    const rounds = Array.isArray(raw.rounds)
      ? raw.rounds.slice(0, 2).map((round) => {
          const row = round && typeof round === "object" ? round as Record<string, unknown> : {};
          const updatedProposal = normalizeProposal(row.updatedProposal);
          return {
            consolidator: typeof row.consolidator === "string" ? row.consolidator : "",
            adversary: typeof row.adversary === "string" ? row.adversary : "",
            updatedProposal: updatedProposal && validateProposal(updatedProposal, input.snapshot) === null ? updatedProposal : null,
          };
        })
      : [];

    return {
      result: {
        rounds,
        finalProposal: safeFinalProposal,
      },
      raw,
      aiCalls: 1,
      usage,
    };
  }
}
