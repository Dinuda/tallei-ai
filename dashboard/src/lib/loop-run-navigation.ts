export type LoopRunSummary = {
  id: string;
  status?: string;
  triggerSource?: "manual" | "schedule" | "event";
  triggerLabel?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export function loopRunHref(workflowId: string, runId: string): string {
  return `/dashboard/loops/${workflowId}/runs/${runId}`;
}

export function loopBuilderHref(sessionId: string): string {
  return `/dashboard/loops/new?session=${encodeURIComponent(sessionId)}`;
}

export function loopSettingsHref(workflowId: string): string {
  return `/dashboard/loops/${workflowId}`;
}

export async function resolveLoopRunNavigation(workflowId: string, latestRun?: LoopRunSummary | null): Promise<string> {
  if (latestRun?.id) {
    return loopRunHref(workflowId, latestRun.id);
  }
  const response = await fetch(`/api/workflows/internal/loops/${workflowId}/runs`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (response.ok && Array.isArray(payload.runs) && payload.runs.length > 0) {
    const run = payload.runs[0] as LoopRunSummary;
    return loopRunHref(workflowId, run.id);
  }
  const createResponse = await fetch(`/api/workflows/internal/loops/${workflowId}/runs`, { method: "POST" });
  const createPayload = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok) {
    throw new Error((createPayload as { error?: string }).error ?? "Failed to open loop run");
  }
  const runId = String((createPayload as { run?: { id?: string } }).run?.id ?? "");
  if (!runId) throw new Error("Failed to open loop run");
  return loopRunHref(workflowId, runId);
}

export function triggerSourceLabel(source?: string, label?: string | null): string {
  if (source === "event") return label ? `Triggered by ${label}` : "Event trigger";
  if (source === "schedule") return label ?? "Scheduled run";
  return "Manual run";
}
