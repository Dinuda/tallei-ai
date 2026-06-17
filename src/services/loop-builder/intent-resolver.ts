import type { AuthContext } from "../../domain/auth/index.js";
import { createLoopFromRunnableSpec } from "../loop-executor/creator.js";
import { noSlopSpecSnapshotSchema } from "../loop-engine/spec-contracts.js";
import { normalizeDesignCron } from "../loop-executor/cron.js";
import { selectedArtifactContract } from "../loop-engine/build-contract.js";
import type { ToolContract } from "../tool-spec/types.js";
import type { LoopBuildContract } from "../loop-engine/build-contract.js";

export type LoopBuilderProposal = {
  title: string;
  summary: string;
  [key: string]: unknown;
};

export async function saveLoopFromSpec(input: {
  auth: AuthContext;
  specSnapshot: import("../loop-engine/spec-contracts.js").NoSlopSpecSnapshot;
  discoveredToolContracts: ToolContract[];
  buildContract: LoopBuildContract;
  cron: string;
  timezone: string;
  workspaceId?: string | null;
  builderSessionId?: string;
  initialStatus?: "active" | "verifying";
}) {
  const snapshot = noSlopSpecSnapshotSchema.parse(input.specSnapshot);
  const buildContract = input.buildContract;
  const cron = normalizeDesignCron(input.cron, snapshot.specJson.purpose);
  const artifacts = selectedArtifactContract(buildContract);
  const runnableSpec = {
    version: "v1" as const,
    goal: snapshot.specJson.purpose,
    title: snapshot.title,
    noSlopSpec: snapshot,
    discoveredToolContracts: input.discoveredToolContracts as unknown as Array<Record<string, unknown>>,
    schedule: { cron, timezone: input.timezone },
    buildContract,
    ...(artifacts ? { artifacts } : {}),
    workspaceId: input.workspaceId ?? null,
    ...(input.builderSessionId ? { builderSessionId: input.builderSessionId } : {}),
  };
  return createLoopFromRunnableSpec({
    auth: input.auth,
    spec: runnableSpec,
    title: snapshot.title,
    workspaceId: input.workspaceId ?? null,
    initialStatus: input.initialStatus ?? "verifying",
  });
}
