import { getConnectorProvider } from "../../integrations/connectors/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import type { ResolvedTool } from "../../loops/spec.js";
import { clampComposioArgsForRuntime } from "../../loops/composio-runtime-args.js";
import { filterArgsToSchemaProperties, validateToolArgsAgainstSchema } from "@tallei/composio-tools/tool-schema.js";
import { compactEmailReadToolResult } from "../../loops/tool-result-compact.js";
import { claimRunStep, completeClaimedRunStep, insertRunStep, updateLoopRun } from "../../loops/store.js";

export async function executeToolActivity(input: {
  auth: AuthContext;
  runId: string;
  stepIndex: number;
  tool: ResolvedTool;
  args: Record<string, unknown>;
  idempotencyKey?: string;
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

  if (input.idempotencyKey) {
    const claim = await claimRunStep({
      runId: input.runId,
      stepIndex: input.stepIndex,
      kind: "tool",
      toolId: input.tool.id,
      inputJson: args,
      idempotencyKey: input.idempotencyKey,
    });
    if (!claim.claimed) {
      if (claim.step.status === "completed" || claim.step.status === "failed") {
        return claim.step.output_json;
      }
      return {
        successful: false,
        error: "tool_execution_outcome_unknown",
        data: { idempotencyKey: input.idempotencyKey },
      };
    }
  }

  const raw = await getConnectorProvider().execute({
    auth: input.auth,
    toolkit: input.tool.connector,
    actionSlug: input.tool.actionSlug,
    connectedAccountId: input.tool.credentialRef,
    args,
    toolkitVersion: input.tool.toolkitVersion,
  });
  const result = compactEmailReadToolResult(raw);

  if (input.idempotencyKey) {
    await completeClaimedRunStep({
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      outputJson: result,
      status: "completed",
    });
  } else {
    await insertRunStep({
      runId: input.runId,
      stepIndex: input.stepIndex,
      kind: "tool",
      toolId: input.tool.id,
      inputJson: args,
      outputJson: result,
      status: "completed",
    });
  }

  return result;
}
