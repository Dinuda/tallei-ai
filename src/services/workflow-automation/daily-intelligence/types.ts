import type { AuthContext } from "../../../domain/auth/index.js";
import type { MemoryCleanupRunView } from "../../../orchestration/memory-cleanup/types.js";
import type { RunMemoryCleanupOptions } from "../../memory-cleanup.js";

export interface WorkflowSuggestionLike {
  id: string;
  title: string;
  reason: string;
  suggestedPrompt: string;
  status: string;
  confidence: number;
  fingerprint: string;
  triggerCount: number;
  createdAt: string;
}

export interface NotificationChannelConfigLike {
  kind: "email" | "whatsapp";
  destination: string;
}

export interface RunDailyIntelligencePipelineOptions {
  skipSdkLifecycle: boolean;
  workflowSdkEnabled: boolean;
  workflowTargetWorld: string;
}

export interface RunDailyIntelligencePipelineDeps {
  startDailySdkRun(auth: AuthContext): Promise<string | null>;
  completeDailySdkRun(
    sdkRunId: string,
    payload: {
      tenantId: string;
      userId: string;
      suggestionCount: number;
      loopMinerSuggestionCount: number;
    }
  ): Promise<void>;
  runMemoryCleanupForUser(
    auth: AuthContext,
    options: RunMemoryCleanupOptions
  ): Promise<MemoryCleanupRunView>;
  discoverInlineWorkflowSuggestions(input: {
    auth: AuthContext;
    message: string;
    source: "daily_intelligence";
  }): Promise<WorkflowSuggestionLike[]>;
  listEnabledNotificationChannels(auth: AuthContext): Promise<NotificationChannelConfigLike[]>;
  sendWorkflowSuggestionNotification(input: {
    auth: AuthContext;
    suggestion: WorkflowSuggestionLike;
    to: string;
    channel: "email" | "whatsapp";
  }): Promise<void>;
  sendMemoryCleanupAdminEmail(input: {
    auth: AuthContext;
    run: MemoryCleanupRunView;
    source: "daily_intelligence";
    dailyRunId: string;
    suggestionCount: number;
  }): Promise<void>;
}
