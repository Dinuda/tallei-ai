import { executeComposioAction } from "../../integrations/composio/execute.js";
import type { AuthContext } from "../../domain/auth/index.js";
import type { ResolvedTool } from "../../loops/spec.js";
import { clampComposioArgsForRuntime } from "../../loops/composio-runtime-args.js";
import { filterArgsToSchemaProperties, validateToolArgsAgainstSchema } from "../../loops/tool-schema.js";
import { compactEmailReadToolResult } from "../../loops/tool-result-compact.js";
import { insertRunStep, updateLoopRun } from "../../loops/store.js";

export async function executeToolActivity(input: {
  auth: AuthContext;
  runId: string;
  stepIndex: number;
  tool: ResolvedTool;
  args: Record<string, unknown>;
}): Promise<unknown> {
  await updateLoopRun(input.runId, { status: "running" });

  const args = filterArgsToSchemaProperties(
    clampComposioArgsForRuntime({
      inputSchema: input.tool.inputSchema,
      args: input.args,
    }),
    input.tool.inputSchema,
  );

  const validation = validateToolArgsAgainstSchema(args, input.tool.inputSchema);
  if (!validation.ok) {
    const result = {
      successful: false,
      error: `Missing required fields: ${validation.missing.join(", ")}`,
      data: {
        message: `Missing required fields: ${validation.missing.join(", ")}`,
        required: validation.required,
        provided: Object.keys(args),
      },
    };
    await insertRunStep({
      runId: input.runId,
      stepIndex: input.stepIndex,
      kind: "tool",
      toolId: input.tool.id,
      inputJson: args,
      outputJson: result,
      status: "failed",
    });
    return result;
  }

  const raw = await executeComposioAction({
    auth: input.auth,
    connector: input.tool.connector,
    actionSlug: input.tool.actionSlug,
    credentialRef: input.tool.credentialRef,
    args,
    toolkitVersion: input.tool.toolkitVersion,
  });
  const result = compactEmailReadToolResult(raw);

  await insertRunStep({
    runId: input.runId,
    stepIndex: input.stepIndex,
    kind: "tool",
    toolId: input.tool.id,
    inputJson: args,
    outputJson: result,
    status: "completed",
  });

  return result;
}
