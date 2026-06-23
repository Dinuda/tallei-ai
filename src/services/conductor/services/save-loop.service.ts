import type { AuthContext } from "../../../domain/auth/index.js";
import { createLoopFromDefinition } from "./loop-workflow.service.js";
import { noSlopSpecSnapshotSchema } from "../contracts/spec-contracts.js";
import { normalizeDesignCron } from "../domain/schedule-cron.js";
import { selectedArtifactContract } from "../domain/build-contract.js";
import type { ToolContract } from "../../tool-spec/types.js";
import type { LoopBuildContract } from "../domain/build-contract.js";
import { definitionFromApprovedSpec } from "../runtime/spec-run-types.js";
import { bindLoopSpecAgentAvatars } from "./personas/enrichment.js";
import { persistApprovedLoopSpecSnapshot } from "./spec.service.js";
import { linkWorkflowBuilderSessionToLoop } from "../data/session.repository.js";

export type LoopBuilderProposal = {
  title: string;
  summary: string;
  [key: string]: unknown;
};

export async function saveLoopFromSpec(input: {
  auth: AuthContext;
  specSnapshot: import("../contracts/spec-contracts.js").NoSlopSpecSnapshot;
  discoveredToolContracts: ToolContract[];
  buildContract: LoopBuildContract;
  cron: string;
  timezone: string;
  workspaceId?: string | null;
  builderSessionId?: string;
  initialStatus?: "active" | "verifying";
}) {
  const snapshot = noSlopSpecSnapshotSchema.parse(input.specSnapshot);
  await persistApprovedLoopSpecSnapshot(input.auth, snapshot);
  await bindLoopSpecAgentAvatars(input.auth, snapshot);
  const buildContract = input.buildContract;
  const cron = normalizeDesignCron(input.cron, snapshot.specJson.purpose);
  const artifacts = selectedArtifactContract(buildContract);
  const resolvedWorkspaceId = input.workspaceId ?? input.auth.workspaceId ?? null;
  const definition = definitionFromApprovedSpec({
    snapshot,
    buildContract,
    discoveredToolContracts: input.discoveredToolContracts,
    ...(artifacts ? { artifacts } : {}),
    cron,
    timezone: input.timezone,
    workspaceId: resolvedWorkspaceId,
    ...(input.builderSessionId ? { builderSessionId: input.builderSessionId } : {}),
  });
  const loop = await createLoopFromDefinition({
    auth: input.auth,
    definition,
    title: snapshot.title,
    workspaceId: resolvedWorkspaceId,
    initialStatus: input.initialStatus ?? "verifying",
  });
  if (input.builderSessionId) {
    await linkWorkflowBuilderSessionToLoop(
      input.auth,
      input.builderSessionId,
      loop.id,
      snapshot.id,
    );
  }
  return loop;
}
