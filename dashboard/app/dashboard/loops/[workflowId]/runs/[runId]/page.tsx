"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import {
  Bot,
  Check,
  ChevronRight,
  Code,
  Columns2,
  FileText,
  Info,
  ListChecks,
  Loader2,
  MoreHorizontal,
  PenLine,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type StepAttempt = {
  id: string;
  step_index: number;
  agent_id: string;
  agent_snapshot: { id?: string; name?: string; task?: string };
  attempt: number;
  status: string;
  output_json: { text?: string; data?: Record<string, unknown>; goalEval?: { reason?: string } };
  error_json: { message?: string };
};

type Gate = {
  id: string;
  gate_type: "memory_confirmation" | "missing_input" | "draft_review" | "pre_send";
  status: string;
  question: string;
  payload_json: { items?: Array<{ id: string; excerpt: string; include?: boolean }>; result?: { text?: string } } & Record<string, unknown>;
};

type Artifact = {
  id: string;
  artifact_key: string;
  version: number;
  kind: string;
  body: string;
  invalidated_at: string | null;
};

type RunProjection = {
  id: string;
  workflow_id: string;
  workflow_title: string;
  status: string;
  error_json: { message?: string };
  created_at: string;
  updated_at: string;
  definition?: {
    goal?: string;
    agentGraph?: {
      parent?: { name?: string; task?: string };
      children?: Array<{ id: string; name?: string; task?: string }>;
    };
  };
  context?: Record<string, unknown>;
  steps: StepAttempt[];
  gates: Gate[];
  artifacts: Artifact[];
};

const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "blocked"]);

function label(value: string) {
  return value.replaceAll("_", " ");
}

function preview(value: string | undefined | null, fallback = "No output yet.") {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 128 ? `${text.slice(0, 125)}...` : text;
}

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function inferGoalArtifactName(run: RunProjection | null, artifact?: Artifact | null) {
  const source = `${run?.definition?.goal ?? ""} ${run?.workflow_title ?? ""} ${artifact?.artifact_key ?? ""} ${artifact?.kind ?? ""}`.toLowerCase();
  if (source.includes("newsletter")) return "Newsletter";
  if (source.includes("report")) return "Report";
  if (source.includes("proposal")) return "Proposal";
  if (source.includes("brief")) return "Brief";
  if (source.includes("summary")) return "Summary";
  if (source.includes("plan")) return "Plan";
  if (source.includes("draft")) return "Draft";
  if (artifact?.kind) return titleCase(artifact.kind);
  if (artifact?.artifact_key) return titleCase(artifact.artifact_key);
  return "Final result";
}

function badgeClass(status: string) {
  if (status === "succeeded" || status === "approved" || status === "submitted") return "bg-emerald-50 text-emerald-700";
  if (status === "failed" || status === "blocked" || status === "cancelled" || status === "rejected") return "bg-red-50 text-red-700";
  if (status === "waiting_for_gate" || status === "pending") return "bg-amber-100 text-amber-700";
  if (status === "running") return "bg-sky-100 text-sky-700";
  return "bg-slate-100 text-slate-600";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="secondary" className={cn("rounded-full border-0 px-3 py-1 text-xs font-bold capitalize", badgeClass(status))}>
      {label(status)}
    </Badge>
  );
}

function RunStatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold capitalize", badgeClass(status))}>
      <span className="size-2 rounded-full bg-amber-400" />
      {label(status)}
    </span>
  );
}

function getStepText(step: StepAttempt | null | undefined) {
  return step?.output_json?.text?.trim() ?? "";
}

function agentVisual(step: StepAttempt | null | undefined) {
  const source = `${step?.agent_snapshot?.name ?? ""} ${step?.agent_snapshot?.task ?? ""}`.toLowerCase();
  if (source.includes("memory") || source.includes("search")) return { icon: Search, className: "bg-cyan-100 text-sky-700" };
  if (source.includes("draft") || source.includes("write") || source.includes("content")) return { icon: PenLine, className: "bg-indigo-100 text-indigo-700" };
  if (source.includes("input") || source.includes("validat")) return { icon: ListChecks, className: "bg-slate-100 text-slate-600" };
  if (source.includes("approval") || source.includes("review") || step?.status === "waiting_for_gate") return { icon: ShieldCheck, className: "bg-amber-100 text-amber-700" };
  if (step?.status === "running") return { icon: Bot, className: "bg-sky-100 text-sky-700" };
  if (step?.status === "succeeded") return { icon: Check, className: "bg-emerald-100 text-emerald-700" };
  if (step?.status === "failed" || step?.status === "blocked") return { icon: X, className: "bg-red-100 text-red-700" };
  return { icon: Bot, className: "bg-slate-100 text-slate-600" };
}

function readContextEntries(context: Record<string, unknown> | undefined): Array<{ key: string; value: string }> {
  const inputs = context?.inputs && typeof context.inputs === "object" && !Array.isArray(context.inputs)
    ? context.inputs as Record<string, unknown>
    : {};
  const memories = Array.isArray(context?.approvedMemories) ? context.approvedMemories : [];
  const rows: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(inputs)) {
    rows.push({ key, value: typeof value === "string" ? value : JSON.stringify(value) });
  }
  for (const item of memories) {
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      rows.push({
        key: typeof record.id === "string" ? record.id : "memory",
        value: typeof record.excerpt === "string" ? record.excerpt : JSON.stringify(record),
      });
    }
  }
  return rows.slice(0, 5);
}

export default function StableLoopRunPage() {
  const { workflowId, runId } = useParams<{ workflowId: string; runId: string }>();
  const [run, setRun] = useState<RunProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<"output" | "attempts" | "artifact">("output");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/workflows/runs/${runId}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to load run");
      setRun(payload.run as RunProjection);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load run");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!run || terminalStatuses.has(run.status)) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [run, load]);

  const orderedSteps = useMemo(
    () => [...(run?.steps ?? [])].sort((a, b) => a.step_index - b.step_index || a.attempt - b.attempt),
    [run],
  );
  const latestSteps = useMemo(() => {
    const byStep = new Map<number, StepAttempt>();
    for (const step of orderedSteps) byStep.set(step.step_index, step);
    return [...byStep.values()].sort((a, b) => a.step_index - b.step_index);
  }, [orderedSteps]);
  const visibleArtifacts = useMemo(() => run?.artifacts.filter((artifact) => !artifact.invalidated_at) ?? [], [run]);
  const pendingGate = useMemo(() => run?.gates.find((gate) => gate.status === "pending") ?? null, [run]);
  const selectedStep = useMemo(() => {
    if (selectedStepId) return orderedSteps.find((step) => step.id === selectedStepId) ?? null;
    return [...orderedSteps].reverse().find((step) => getStepText(step) || step.status === "waiting_for_gate" || step.status === "running") ?? null;
  }, [orderedSteps, selectedStepId]);
  const latestArtifact = visibleArtifacts.at(-1) ?? null;
  const finalArtifacts = latestArtifact ? [latestArtifact] : [];
  const selectedArtifact = useMemo(() => {
    if (selectedArtifactId) return visibleArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
    return latestArtifact;
  }, [latestArtifact, selectedArtifactId, visibleArtifacts]);
  const attemptsForSelectedStep = useMemo(() => {
    if (!selectedStep) return [];
    return orderedSteps.filter((step) => step.step_index === selectedStep.step_index);
  }, [orderedSteps, selectedStep]);

  const finalArtifactName = inferGoalArtifactName(run, selectedArtifact);
  const inspectingAgentOutput = Boolean(selectedStepId && selectedStep);
  const centerTitle = inspectingAgentOutput
    ? `${selectedStep?.agent_snapshot?.name ?? selectedStep?.agent_id} output`
    : selectedArtifact
      ? `${finalArtifactName} artifact`
      : `${finalArtifactName} artifact`;
  const centerBody = inspectingAgentOutput
    ? getStepText(selectedStep)
    : selectedArtifact?.body || pendingGate?.payload_json.result?.text || getStepText(selectedStep);
  const contextEntries = readContextEntries(run?.context);
  const doneSteps = latestSteps.filter((step) => step.status === "succeeded").length;
  const gateHeading = pendingGate
    ? pendingGate.gate_type === "missing_input"
      ? "Input is needed to continue"
      : `${label(pendingGate.gate_type)} is ready for approval`
    : null;

  async function post(path: string, body?: Record<string, unknown>) {
    setBusy(path);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Command failed");
      await load();
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : "Command failed");
    } finally {
      setBusy(null);
    }
  }

  function submitGate(gate: Gate, action: "approve" | "input" | "reject") {
    if (action === "reject") {
      void post(`/api/workflows/runs/${runId}/gates/${gate.id}/reject`, { reason: "Rejected by operator" });
      return;
    }
    if (action === "input") {
      void post(`/api/workflows/runs/${runId}/gates/${gate.id}/input`, { value: inputValues[gate.id] ?? "" });
      return;
    }
    void post(`/api/workflows/runs/${runId}/gates/${gate.id}/approve`, {
      channel: "dashboard",
      ...(gate.gate_type === "memory_confirmation" ? { items: gate.payload_json.items ?? [] } : {}),
    });
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50">
        <Loader2 className="size-7 animate-spin text-slate-500" />
      </div>
    );
  }

  if (!run) return <main className="p-8 text-sm text-red-700">{error ?? "Run not found"}</main>;

  return (
    <main className="min-h-screen bg-[#f7f8fb] text-[#121a31]">
      <div className="mx-auto max-w-[1660px] px-7 py-6">
        <header className="mb-7 flex items-start justify-between gap-4">
          <div>
            <nav className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-500">
              <Link href="/dashboard/loops" className="hover:text-slate-900">Loops</Link>
              <ChevronRight className="size-4" />
              <Link href={`/dashboard/loops/${workflowId}`} className="hover:text-slate-900">{run.workflow_title}</Link>
              <ChevronRight className="size-4" />
              <span className="text-slate-900">Run {run.id.slice(0, 6)}</span>
            </nav>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[25px] font-extrabold leading-tight tracking-[-0.02em]">{run.workflow_title}</h1>
              <RunStatusPill status={run.status} />
            </div>
          </div>
          <div className="flex items-center gap-3 text-slate-500">
            <button className="rounded-lg p-2 hover:bg-white hover:text-slate-900" title="Info"><Info className="size-5" /></button>
            <button className="rounded-lg p-2 hover:bg-white hover:text-slate-900" title="View raw"><Code className="size-5" /></button>
            <button onClick={() => void load()} className="rounded-lg p-2 hover:bg-white hover:text-slate-900" title="Refresh"><RefreshCw className="size-5" /></button>
            <button className="rounded-lg p-2 hover:bg-white hover:text-slate-900" title="Panels"><Columns2 className="size-5" /></button>
            {!terminalStatuses.has(run.status) ? (
              <button
                onClick={() => void post(`/api/workflows/runs/${runId}/cancel`)}
                disabled={Boolean(busy)}
                className="rounded-lg p-2 hover:bg-white hover:text-red-700 disabled:opacity-50"
                title="Cancel"
              >
                <X className="size-5" />
              </button>
            ) : null}
            <button className="rounded-lg p-2 hover:bg-white hover:text-slate-900" title="More"><MoreHorizontal className="size-5" /></button>
          </div>
        </header>

        {error || run.error_json?.message ? (
          <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error ?? run.error_json?.message}
          </div>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_490px]">
          <section className="space-y-5">
            {pendingGate ? (
              <Card className="overflow-hidden rounded-[22px] border-0 bg-[#eefdff] shadow-md shadow-slate-300/60">
                <CardContent className="flex min-h-[178px] gap-5 p-7">
                  <div className="grid size-14 shrink-0 place-items-center rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <ShieldCheck className="size-7 text-slate-700" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[19px] font-extrabold">{gateHeading}</h2>
                    <p className="mt-2 max-w-4xl text-[18px] font-medium leading-7 text-[#53627a]">
                      {pendingGate.gate_type === "missing_input"
                        ? pendingGate.question
                        : preview(centerBody || pendingGate.question || run.definition?.goal, "Review the current artifact and approve or request changes.")}
                    </p>
                    {pendingGate.gate_type === "missing_input" ? (
                      <textarea
                        value={inputValues[pendingGate.id] ?? ""}
                        onChange={(event) => setInputValues((current) => ({ ...current, [pendingGate.id]: event.target.value }))}
                        className="mt-5 min-h-28 w-full rounded-xl border border-cyan-200 bg-white p-3 text-sm outline-none focus:border-cyan-400"
                        placeholder="Provide the required input"
                      />
                    ) : null}
                    <div className="mt-7 flex flex-wrap items-center gap-4">
                      <Button
                        disabled={Boolean(busy) || (pendingGate.gate_type === "missing_input" && !(inputValues[pendingGate.id] ?? "").trim())}
                        onClick={() => submitGate(pendingGate, pendingGate.gate_type === "missing_input" ? "input" : "approve")}
                        className="h-9 rounded-lg bg-[#0077b6] px-5 text-[16px] font-bold shadow-md shadow-sky-800/20 hover:bg-[#00689f]"
                      >
                        <Check className="mr-2 size-4" />
                        {pendingGate.gate_type === "missing_input" ? "Submit input" : "Approve"}
                      </Button>
                      <Button variant="ghost" disabled={Boolean(busy)} onClick={() => submitGate(pendingGate, "reject")} className="text-[16px] font-semibold text-[#364761]">
                        Request changes
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            <Card className="min-h-[860px] overflow-hidden rounded-[22px] border-0 bg-white shadow-sm">
              <Tabs value={leftTab} onValueChange={(value) => setLeftTab(value as typeof leftTab)} className="gap-0">
                <CardHeader className="border-b bg-gradient-to-r from-[#fffaf2] via-white to-[#f0fbff] px-7 py-6">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <CardTitle className="truncate text-[20px] font-bold text-[#35455f]">{centerTitle}</CardTitle>
                    </div>
                  </div>
                  <TabsList variant="line" className="mt-5 h-auto gap-1 rounded-none bg-transparent p-0">
                    <TabsTrigger value="output" className="h-10 rounded-none px-4 text-sm font-semibold capitalize text-slate-500 data-[state=active]:bg-transparent data-[state=active]:text-[#10182d] data-[state=active]:shadow-none">
                      Output
                    </TabsTrigger>
                    <TabsTrigger value="attempts" className="h-10 rounded-none px-4 text-sm font-semibold capitalize text-slate-500 data-[state=active]:bg-transparent data-[state=active]:text-[#10182d] data-[state=active]:shadow-none">
                      Attempts
                    </TabsTrigger>
                    <TabsTrigger value="artifact" className="h-10 rounded-none px-4 text-sm font-semibold capitalize text-slate-500 data-[state=active]:bg-transparent data-[state=active]:text-[#10182d] data-[state=active]:shadow-none">
                      Artifact
                    </TabsTrigger>
                  </TabsList>
                </CardHeader>
                <CardContent className="p-7">
                    <TabsContent value="output" className="mt-0">
                      <div className="rounded-2xl border bg-white p-7 shadow-sm">
                        {selectedStep?.status === "waiting_for_gate" || pendingGate ? (
                          <div className="mb-6 flex items-start gap-4 rounded-2xl border border-amber-100 bg-amber-50 p-4">
                            <div className="grid size-12 place-items-center rounded-xl bg-amber-100 text-amber-700">
                              <ShieldCheck className="size-6" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-3">
                                <h3 className="text-[18px] font-extrabold">Awaiting operator response</h3>
                                <StatusBadge status="pending" />
                              </div>
                              <p className="mt-1 text-[15px] text-slate-600">
                                {pendingGate?.question ?? "The selected step is paused at a gate."}
                              </p>
                            </div>
                          </div>
                        ) : null}

                        {centerBody ? (
                          <div className="prose prose-slate max-w-none text-[16px] leading-7">
                            <Streamdown>{centerBody}</Streamdown>
                          </div>
                        ) : (
                          <div className="grid min-h-[560px] place-items-center rounded-2xl border border-dashed bg-slate-50 p-8 text-center text-sm text-slate-500">
                            No {finalArtifactName.toLowerCase()} artifact yet. The stable worker will update this projection when the run produces its reviewed result.
                          </div>
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="attempts" className="mt-0">
                      <div className="space-y-4">
                        {(attemptsForSelectedStep.length > 0 ? attemptsForSelectedStep : orderedSteps).map((attempt) => (
                          <div key={attempt.id} className="rounded-2xl border bg-white p-5 shadow-sm">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <p className="text-sm font-bold uppercase tracking-wide text-slate-500">Step {attempt.step_index + 1} · Attempt {attempt.attempt}</p>
                                <h3 className="mt-1 text-lg font-extrabold">{attempt.agent_snapshot?.name ?? attempt.agent_id}</h3>
                              </div>
                              <div className="flex items-center gap-2">
                                {(attempt.status === "failed" || attempt.status === "cancelled") ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={Boolean(busy)}
                                    onClick={() => void post(`/api/workflows/runs/${runId}/steps/${attempt.id}/retry`)}
                                    className="rounded-full"
                                  >
                                    <RotateCcw className="mr-1 size-3" />
                                    Rerun
                                  </Button>
                                ) : null}
                                <StatusBadge status={attempt.status} />
                              </div>
                            </div>
                            <p className="mt-3 text-sm leading-6 text-slate-600">
                              {preview(getStepText(attempt) || attempt.error_json?.message || attempt.agent_snapshot?.task)}
                            </p>
                          </div>
                        ))}
                        {orderedSteps.length === 0 ? (
                          <div className="grid min-h-[360px] place-items-center rounded-2xl border border-dashed bg-slate-50 p-8 text-sm text-slate-500">
                            No attempts have been created yet.
                          </div>
                        ) : null}
                      </div>
                    </TabsContent>

                    <TabsContent value="artifact" className="mt-0">
                      <div className="space-y-4">
                        <div className="rounded-2xl border border-sky-100 bg-sky-50 p-5">
                          <h3 className="text-lg font-extrabold text-[#172139]">{finalArtifactName} artifact</h3>
                          <p className="mt-1 text-sm font-medium leading-6 text-[#64718a]">
                            This is the run result. Agent rows are intermediate work; the artifact is the reviewed end result.
                          </p>
                        </div>
                        {finalArtifacts.map((artifact) => (
                          <button
                            key={artifact.id}
                            onClick={() => {
                              setSelectedArtifactId(artifact.id);
                              setSelectedStepId(null);
                              setLeftTab("output");
                            }}
                            className="flex w-full items-center gap-4 rounded-2xl border bg-white p-5 text-left shadow-sm hover:border-slate-300"
                          >
                            <div className="grid size-12 place-items-center rounded-xl bg-slate-100 text-slate-600">
                              <FileText className="size-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-extrabold">{inferGoalArtifactName(run, artifact)} artifact</p>
                              <p className="mt-1 text-sm text-slate-500">Version {artifact.version} · {artifact.kind}</p>
                            </div>
                          </button>
                        ))}
                        {finalArtifacts.length === 0 ? (
                          <div className="grid min-h-[360px] place-items-center rounded-2xl border border-dashed bg-slate-50 p-8 text-sm text-slate-500">
                            No {finalArtifactName.toLowerCase()} artifact yet.
                          </div>
                        ) : null}
                      </div>
                    </TabsContent>
                  </CardContent>
              </Tabs>
            </Card>
          </section>

          <aside className="space-y-4 overflow-hidden">
            <Card className="overflow-hidden rounded-[22px] border-0 bg-white shadow-md shadow-slate-300/60">
              <CardHeader className="border-b px-5 py-5">
                <CardTitle className="text-[20px] font-extrabold">Final result</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                {finalArtifacts.map((artifact) => (
                  <button
                    key={artifact.id}
                    onClick={() => {
                      setSelectedArtifactId(artifact.id);
                      setSelectedStepId(null);
                      setLeftTab("output");
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-2xl border p-4 text-left shadow-sm transition hover:border-slate-300",
                      (selectedArtifactId === artifact.id || (!selectedArtifactId && latestArtifact?.id === artifact.id)) ? "border-sky-200 bg-sky-50" : "bg-white",
                    )}
                  >
                    <div className="grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-600">
                      <FileText className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[17px] font-extrabold text-[#26334d]">{inferGoalArtifactName(run, artifact)} artifact</p>
                      <p className="text-xs font-medium text-slate-500">v{artifact.version} · {artifact.kind}</p>
                    </div>
                  </button>
                ))}
                {finalArtifacts.length === 0 ? (
                  <p className="rounded-2xl border border-dashed p-4 text-sm text-slate-500">No {finalArtifactName.toLowerCase()} artifact yet.</p>
                ) : null}
              </CardContent>
            </Card>

            <Card className="overflow-hidden rounded-[22px] border-0 bg-white shadow-md shadow-slate-300/60">
              <CardHeader className="flex flex-row items-center justify-between border-b px-5 py-5">
                <CardTitle className="text-[20px] font-extrabold">Agents</CardTitle>
                <Badge variant="secondary" className="rounded-full">{doneSteps}/{latestSteps.length} done</Badge>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                <button
                  onClick={() => {
                    setSelectedArtifactId(null);
                    setSelectedStepId(selectedStep?.id ?? latestSteps[0]?.id ?? null);
                    setLeftTab("output");
                  }}
                  className="w-full rounded-2xl border border-amber-200 bg-white p-4 text-left shadow-sm"
                >
                  <div className="flex gap-4">
                    <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#10182d] text-white shadow">
                      <Bot className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-[18px] font-extrabold">Parent Agent</p>
                        <StatusBadge status={run.status} />
                      </div>
                      <p className="mt-1 line-clamp-2 text-[15px] font-medium leading-5 text-[#637089]">
                        {run.definition?.agentGraph?.parent?.task ?? "Orchestrates the run"}
                      </p>
                    </div>
                  </div>
                </button>

                {latestSteps.map((step) => {
                  const selected = selectedStepId === step.id || (!selectedStepId && selectedStep?.id === step.id);
                  const visual = agentVisual(step);
                  const Icon = visual.icon;
                  const canRetry = step.status === "failed" || step.status === "cancelled";
                  return (
                    <button
                      key={step.id}
                      onClick={() => {
                        setSelectedStepId(step.id);
                        setSelectedArtifactId(null);
                        setLeftTab("output");
                      }}
                      className={cn(
                        "w-full rounded-2xl border p-4 text-left transition",
                        selected ? "border-[#8aa0bd] bg-white shadow-sm ring-2 ring-[#8aa0bd]/40" : "border-slate-100 bg-white hover:border-slate-300",
                        step.status === "waiting_for_gate" ? "border-amber-200 bg-amber-50/70" : "",
                        step.status === "running" ? "border-yellow-200 bg-yellow-50/70" : "",
                      )}
                    >
                      <div className="flex gap-4">
                        <div className={cn("grid size-11 shrink-0 place-items-center rounded-xl", visual.className)}>
                          <Icon className="size-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className="truncate text-[18px] font-extrabold text-[#172139]">{step.agent_snapshot?.name ?? step.agent_id}</p>
                            <div className="flex shrink-0 items-center gap-2">
                              {canRetry ? (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void post(`/api/workflows/runs/${runId}/steps/${step.id}/retry`);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void post(`/api/workflows/runs/${runId}/steps/${step.id}/retry`);
                                    }
                                  }}
                                  className="inline-flex items-center rounded-full border bg-white px-3 py-1 text-xs font-bold hover:bg-slate-50"
                                >
                                  <RotateCcw className="mr-1 size-3" />
                                  Rerun
                                </span>
                              ) : (
                                <span className="inline-flex items-center rounded-full border bg-white px-3 py-1 text-xs font-bold text-slate-400 opacity-70">
                                  <RotateCcw className="mr-1 size-3" />
                                  Rerun
                                </span>
                              )}
                              <StatusBadge status={step.status} />
                            </div>
                          </div>
                          <p className="mt-1 line-clamp-2 text-[15px] font-medium leading-5 text-[#64718a]">
                            {preview(getStepText(step) || step.error_json?.message || step.agent_snapshot?.task)}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Badge variant="secondary" className="rounded-full border-0 text-xs">attempt {step.attempt}</Badge>
                            <Badge variant="secondary" className="rounded-full border-0 text-xs">
                              {step.output_json?.data?.mode ? String(step.output_json.data.mode) : "llm only"}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {latestSteps.length === 0 ? (
                  <p className="rounded-2xl border border-dashed p-4 text-sm text-slate-500">Waiting for worker claim.</p>
                ) : null}
              </CardContent>
            </Card>

            <Card className="overflow-hidden rounded-[22px] border-0 bg-white shadow-md shadow-slate-300/60">
              <CardHeader className="border-b px-5 py-5">
                <CardTitle className="text-[20px] font-extrabold">From memory</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                {contextEntries.map((entry) => (
                  <div key={`${entry.key}:${entry.value}`} className="rounded-2xl border p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate font-medium">{entry.key}</p>
                      <Badge variant="secondary" className="bg-amber-50 text-amber-700">context</Badge>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm text-slate-600">{entry.value}</p>
                  </div>
                ))}
                {contextEntries.length === 0 ? (
                  <p className="rounded-2xl border border-dashed p-4 text-sm text-slate-500">No approved memory or submitted input yet.</p>
                ) : null}
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </main>
  );
}
