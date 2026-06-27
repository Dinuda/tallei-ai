"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type LoopRun = {
  id: string;
  status: string;
  trigger_kind: string;
  started_at: string;
  finished_at: string | null;
  temporal_workflow_id: string | null;
  error_json: unknown;
  result_json: unknown;
};

type LoopRunStep = {
  id: string;
  step_index: number;
  kind: string;
  tool_id: string | null;
  status: string;
  input_json: unknown;
  output_json: unknown;
  started_at: string;
  finished_at: string | null;
};

type PendingApproval = {
  id: string;
  tool_id: string;
  proposed_action: unknown;
  status: string;
  created_at: string;
};

type RunChatMessage = {
  id: string;
  role: string;
  parts?: Array<{ type: string; text?: string }>;
};

function chatMessageText(message: RunChatMessage): string {
  const parts = message.parts ?? [];
  const text = parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
  if (text) return text;
  const toolPart = parts.find((part) => part.type.startsWith("tool-"));
  if (toolPart) return `[${toolPart.type.replace(/^tool-/, "")}]`;
  return "";
}

export default function LoopRunDetailPage() {
  const params = useParams<{ loopId: string; runId: string }>();
  const { loopId, runId } = params;
  const [run, setRun] = useState<LoopRun | null>(null);
  const [steps, setSteps] = useState<LoopRunStep[]>([]);
  const [chatMessages, setChatMessages] = useState<RunChatMessage[]>([]);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/loops/${loopId}/runs/${runId}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Run not found");
      return;
    }
    setError(null);
    setRun(data.run ?? null);
    setSteps(data.steps ?? []);
    setChatMessages(data.chatMessages ?? []);
    setPendingApproval(data.pendingApproval ?? null);
    return data.run as LoopRun | null;
  }, [loopId, runId]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function refresh() {
      try {
        const nextRun = await load();
        if (cancelled) return;
        const status = nextRun?.status;
        if (status === "running" || status === "waiting_approval") {
          pollTimer = setTimeout(() => void refresh(), 3000);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    void refresh();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [load]);

  async function decide(decision: "approve" | "reject") {
    if (!pendingApproval) return;
    setDeciding(true);
    try {
      const res = await apiFetch(`/api/approvals/${pendingApproval.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error ?? "Failed to decide approval");
        return;
      }
      await load();
    } finally {
      setDeciding(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#182506]">Run detail</h1>
          <p className="font-mono text-xs text-[#7a9a4a]">{runId}</p>
        </div>
        <Button variant="outline" asChild>
          <Link href={`/dashboard/loops/${loopId}/runs`}>All runs</Link>
        </Button>
      </div>

      {loading ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {pendingApproval ? (
        <Card className="border-amber-300 bg-amber-50">
          <CardHeader>
            <CardTitle className="text-base text-amber-900">Approval required</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-amber-900">
              The run is paused until you approve <strong>{pendingApproval.tool_id}</strong>.
            </p>
            <pre className="max-h-48 overflow-auto rounded bg-white p-2 text-xs">
              {JSON.stringify(pendingApproval.proposed_action, null, 2)}
            </pre>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={deciding} onClick={() => void decide("approve")}>
                Approve &amp; continue
              </Button>
              <Button size="sm" variant="outline" disabled={deciding} onClick={() => void decide("reject")}>
                Reject
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link href="/dashboard/approvals">Open inbox</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {run ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                <span className="text-[#7a9a4a]">Status:</span>{" "}
                {pendingApproval ? "waiting_approval" : run.status}
              </p>
              <p><span className="text-[#7a9a4a]">Trigger:</span> {run.trigger_kind}</p>
              <p><span className="text-[#7a9a4a]">Started:</span> {new Date(run.started_at).toLocaleString()}</p>
              {run.finished_at ? (
                <p><span className="text-[#7a9a4a]">Finished:</span> {new Date(run.finished_at).toLocaleString()}</p>
              ) : null}
              {run.temporal_workflow_id ? (
                <p className="break-all"><span className="text-[#7a9a4a]">Workflow:</span> {run.temporal_workflow_id}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Steps ({steps.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {steps.length === 0 ? (
                <p className="text-sm text-muted-foreground">No steps recorded yet.</p>
              ) : (
                <ul className="space-y-3">
                  {steps.map((step) => (
                    <li key={step.id} className="rounded-lg border border-[#e4f5c6] bg-[#f8fdf2] p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[#182506]">
                          #{step.step_index} {step.kind}
                          {step.tool_id ? ` · ${step.tool_id}` : ""}
                        </span>
                        <span className="text-xs uppercase text-[#7a9a4a]">{step.status}</span>
                      </div>
                      {step.output_json ? (
                        <pre className="mt-2 max-h-40 overflow-auto rounded bg-white p-2 text-xs">
                          {JSON.stringify(step.output_json, null, 2)}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {chatMessages.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Transcript ({chatMessages.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {chatMessages.map((message) => {
                    const text = chatMessageText(message);
                    if (!text) return null;
                    return (
                      <li
                        key={message.id}
                        className={`rounded-lg border p-3 text-sm ${
                          message.role === "user"
                            ? "border-[#cce89e] bg-white"
                            : "border-[#e4f5c6] bg-[#f8fdf2]"
                        }`}
                      >
                        <span className="text-xs uppercase text-[#7a9a4a]">{message.role}</span>
                        <p className="mt-1 whitespace-pre-wrap text-[#182506]">{text}</p>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {run.error_json ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base text-red-700">Error</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="overflow-auto text-xs">{JSON.stringify(run.error_json, null, 2)}</pre>
              </CardContent>
            </Card>
          ) : null}

          {run.result_json ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Result</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="overflow-auto text-xs">{JSON.stringify(run.result_json, null, 2)}</pre>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
