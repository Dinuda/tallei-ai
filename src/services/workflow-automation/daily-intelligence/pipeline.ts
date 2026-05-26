import type { AuthContext } from "../../../domain/auth/index.js";
import { getPlanForTenant } from "../../../infrastructure/auth/tenancy.js";
import { pool } from "../../../infrastructure/db/index.js";

import { buildDailyCleanupOptions } from "./cleanup-policy.js";
import {
  claimDailyIntelligenceRun,
  completeDailyIntelligenceRun,
  hasAnyProcessedDailyRun,
  markAlreadyProcessedSkip,
  userHasActiveMemoryRecords,
} from "./state.repository.js";
import type {
  RunDailyIntelligencePipelineDeps,
  RunDailyIntelligencePipelineOptions,
  WorkflowSuggestionLike,
} from "./types.js";

export async function runDailyIntelligencePipeline(
  auth: AuthContext,
  options: RunDailyIntelligencePipelineOptions,
  deps: RunDailyIntelligencePipelineDeps
): Promise<{ suggestionCount: number }> {
  const resolvedPlan = await getPlanForTenant(auth.tenantId);
  const resolvedAuth: AuthContext = {
    ...auth,
    plan: resolvedPlan,
  };

  const claim = await claimDailyIntelligenceRun(resolvedAuth);
  if (!claim.claimed) {
    if (claim.existingRunId) {
      await markAlreadyProcessedSkip({ auth: resolvedAuth, existingRunId: claim.existingRunId }).catch(() => {});
    }
    return { suggestionCount: 0 };
  }
  const runId = claim.runId;

  if (resolvedPlan === "free") {
    await completeDailyIntelligenceRun({
      auth: resolvedAuth,
      runId,
      status: "completed",
      metadata: {
        skipped: true,
        skipReason: "unpaid_plan",
        processed: false,
      },
    });
    return { suggestionCount: 0 };
  }

  const hasActiveMemoryRecords = await userHasActiveMemoryRecords(resolvedAuth);
  if (!hasActiveMemoryRecords) {
    await completeDailyIntelligenceRun({
      auth: resolvedAuth,
      runId,
      status: "completed",
      metadata: {
        skipped: true,
        skipReason: "no_memory_records",
        processed: false,
      },
    });
    return { suggestionCount: 0 };
  }

  const firstProcessedRun = !await hasAnyProcessedDailyRun(resolvedAuth);
  const cleanupOptions = buildDailyCleanupOptions(firstProcessedRun);

  let sdkRunId: string | null = null;
  if (options.workflowSdkEnabled && !options.skipSdkLifecycle) {
    try {
      sdkRunId = await deps.startDailySdkRun(resolvedAuth);
    } catch (error) {
      console.error("[workflow] failed to create sdk daily run:", error);
      sdkRunId = null;
    }
  }

  try {
    const memoryCleanupRun = await deps.runMemoryCleanupForUser(resolvedAuth, cleanupOptions);
    const memoryCleanup = {
      runId: memoryCleanupRun.id,
      status: memoryCleanupRun.status,
      ...memoryCleanupRun.summary,
    };

    if (memoryCleanupRun.status !== "completed" || memoryCleanupRun.summary.skipped) {
      const skipReason = memoryCleanupRun.summary.skipReason
        ? `cleanup_${memoryCleanupRun.summary.skipReason}`
        : "cleanup_not_completed";
      await completeDailyIntelligenceRun({
        auth: resolvedAuth,
        runId,
        status: "completed",
        metadata: {
          skipped: true,
          skipReason,
          processed: false,
          firstProcessedRun,
          memoryCleanup,
        },
      });
      return { suggestionCount: 0 };
    }

    const recentActivities = await pool.query<{ content_text: string }>(
      `SELECT content_text
       FROM ai_activity_events
       WHERE tenant_id = $1
         AND user_id = $2
         AND created_at >= NOW() - interval '30 days'
       ORDER BY created_at DESC
       LIMIT 300`,
      [resolvedAuth.tenantId, resolvedAuth.userId]
    );

    const suggestions: WorkflowSuggestionLike[] = [];
    for (const row of recentActivities.rows) {
      const found = await deps.discoverInlineWorkflowSuggestions({
        auth: resolvedAuth,
        message: row.content_text,
        source: "daily_intelligence",
      });
      suggestions.push(...found);
    }

    if (suggestions.length > 0) {
      const channels = await deps.listEnabledNotificationChannels(resolvedAuth);
      const topSuggestion = suggestions[0];
      const selectedChannel = channels[0];
      if (topSuggestion && selectedChannel) {
        try {
          await deps.sendWorkflowSuggestionNotification({
            auth: resolvedAuth,
            suggestion: topSuggestion,
            to: selectedChannel.destination,
            channel: selectedChannel.kind,
          });
        } catch (error) {
          console.error("[workflow] failed to send daily suggestion notification:", error);
        }
      }
    }

    await completeDailyIntelligenceRun({
      auth: resolvedAuth,
      runId,
      status: "completed",
      metadata: {
        skipped: false,
        processed: true,
        firstProcessedRun,
        suggestionCount: suggestions.length,
        memoryCleanup,
        loopMinerDisabled: true,
        ...(options.workflowSdkEnabled
          ? {
              workflow_sdk_handoff: {
                targetWorld: options.workflowTargetWorld,
                accepted: true,
                sdkRunId,
              },
            }
          : {}),
      },
    });

    await deps.sendMemoryCleanupAdminEmail({
      auth: resolvedAuth,
      run: memoryCleanupRun,
      source: "daily_intelligence",
      dailyRunId: runId,
      suggestionCount: suggestions.length,
    });

    if (sdkRunId && !options.skipSdkLifecycle) {
      await deps.completeDailySdkRun(sdkRunId, {
        tenantId: resolvedAuth.tenantId,
        userId: resolvedAuth.userId,
        suggestionCount: suggestions.length,
        loopMinerSuggestionCount: 0,
      });
    }

    return { suggestionCount: suggestions.length };
  } catch (error) {
    await completeDailyIntelligenceRun({
      auth: resolvedAuth,
      runId,
      status: "failed",
      metadata: {
        skipped: false,
        processed: false,
        failureStage: "daily_pipeline",
        message: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => {});
    throw error;
  }
}
