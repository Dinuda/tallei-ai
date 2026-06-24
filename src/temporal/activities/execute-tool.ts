import { executeComposioAction } from "../../integrations/composio/execute.js";
import type { AuthContext } from "../../domain/auth/index.js";
import type { ResolvedTool } from "../../loops/spec.js";
import { insertRunStep, updateLoopRun } from "../../loops/store.js";

export async function executeToolActivity(input: {
  auth: AuthContext;
  runId: string;
  stepIndex: number;
  tool: ResolvedTool;
  args: Record<string, unknown>;
}): Promise<unknown> {
  await updateLoopRun(input.runId, { status: "running" });

  const result = await executeComposioAction({
    auth: input.auth,
    connector: input.tool.connector,
    actionSlug: input.tool.actionSlug,
    credentialRef: input.tool.credentialRef,
    args: input.args,
    toolkitVersion: input.tool.toolkitVersion,
  });

  await insertRunStep({
    runId: input.runId,
    stepIndex: input.stepIndex,
    kind: "tool",
    toolId: input.tool.id,
    inputJson: input.args,
    outputJson: result,
    status: "completed",
  });

  return result;
}
