"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Megaphone,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";

const NEWSLETTER_TASK = "User is writing a newsletter for xyz product every week. Make that a loop.";
const NEWSLETTER_CRON = "0 9 * * 1";

type LoopAgent = {
  id: string;
  name: string;
  task: string;
  integration: string;
  toolPolicy: {
    allowedTools: string[];
    draftBeforeExternalAction: boolean;
  };
};

type LoopWorkflow = {
  id: string;
  title: string;
  status: string;
  nextRunAt: string | null;
  lastScheduledAt: string | null;
  definition: {
    goal: string;
    schedule: { cron: string; timezone: string };
    schedulerTarget: "internal" | "cloudflare";
    integrations: string[];
    ceo: { name: string; task: string; policy: string };
    agents: LoopAgent[];
    draftPolicy: { requireDraftBeforeExternalAction: boolean; approvalRequiredFor: string[] };
  };
};

type LoopRunResult = {
  runId: string;
  status: string;
  draftRequired: boolean;
  finalOutput: string;
  createdAt?: string | null;
};

type WorkflowListRun = {
  id: string;
  status: string;
  draftOutput: string | null;
  createdAt: string;
};

type WorkflowListItem = {
  id: string;
  latestRun: WorkflowListRun | null;
};

const FALLBACK_AGENTS: LoopAgent[] = [
  {
    id: "topic_researcher",
    name: "Topic Researcher",
    task: `Research and source useful context for this loop: ${NEWSLETTER_TASK}`,
    integration: "internal",
    toolPolicy: { allowedTools: ["research_topic"], draftBeforeExternalAction: true },
  },
  {
    id: "creative_writer",
    name: "Creative Writer",
    task: `Write the newsletter draft using only the research output and the loop goal: ${NEWSLETTER_TASK}`,
    integration: "internal",
    toolPolicy: { allowedTools: ["write_draft"], draftBeforeExternalAction: true },
  },
  {
    id: "publicist",
    name: "Publicist",
    task: `Prepare a publication or send plan for approval. Do not publish or send directly: ${NEWSLETTER_TASK}`,
    integration: "internal",
    toolPolicy: { allowedTools: ["prepare_publication_plan"], draftBeforeExternalAction: true },
  },
];

function formatDate(value: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function iconForAgent(agentId: string) {
  if (agentId.includes("research")) return <Search className="h-4 w-4" />;
  if (agentId.includes("writer")) return <FileText className="h-4 w-4" />;
  return <Megaphone className="h-4 w-4" />;
}

function findNewsletterLoop(loops: LoopWorkflow[]): LoopWorkflow | null {
  return loops.find((loop) =>
    loop.definition?.goal === NEWSLETTER_TASK
    || loop.title === "Newsletter Loop"
    || loop.id === "hardcoded-newsletter-loop-v1"
  ) ?? null;
}

function mapWorkflowRun(run: WorkflowListRun): LoopRunResult {
  return {
    runId: run.id,
    status: run.status,
    draftRequired: run.status === "waiting_for_approval",
    finalOutput: run.draftOutput ?? "",
    createdAt: run.createdAt,
  };
}

export default function NewsletterLoopPage() {
  const [workflow, setWorkflow] = useState<LoopWorkflow | null>(null);
  const [run, setRun] = useState<LoopRunResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [running, setRunning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const agents = workflow?.definition.agents ?? FALLBACK_AGENTS;
  const initialized = Boolean(workflow);
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

  const loadWorkflow = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [loopResponse, workflowResponse] = await Promise.all([
        fetch("/api/workflows/internal/loops", { cache: "no-store" }),
        fetch("/api/workflows", { cache: "no-store" }),
      ]);
      const loopPayload = await loopResponse.json().catch(() => ({}));
      const workflowPayload = await workflowResponse.json().catch(() => ({}));
      if (!loopResponse.ok) throw new Error(loopPayload.error ?? "Failed to load loop");
      if (!workflowResponse.ok) throw new Error(workflowPayload.error ?? "Failed to load workflows");
      const loops = Array.isArray(loopPayload.loops) ? loopPayload.loops as LoopWorkflow[] : [];
      const nextWorkflow = findNewsletterLoop(loops);
      setWorkflow(nextWorkflow);

      const workflows = Array.isArray(workflowPayload.workflows) ? workflowPayload.workflows as WorkflowListItem[] : [];
      const linked = nextWorkflow ? workflows.find((item) => item.id === nextWorkflow.id) : null;
      if (linked?.latestRun?.id) {
        setRun(mapWorkflowRun(linked.latestRun));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load loop");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkflow();
  }, [loadWorkflow]);

  async function initializeLoop(): Promise<LoopWorkflow> {
    setInitializing(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/workflows/internal/loops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: NEWSLETTER_TASK,
          cron: NEWSLETTER_CRON,
          timezone,
          integrations: ["internal"],
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to initialize newsletter loop");
      const created = payload.loop as LoopWorkflow;
      setWorkflow(created);
      setNotice("Newsletter loop is active.");
      return created;
    } finally {
      setInitializing(false);
    }
  }

  async function runLoop() {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const activeWorkflow = workflow ?? await initializeLoop();
      const response = await fetch(`/api/workflows/internal/loops/${activeWorkflow.id}/run`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to run newsletter loop");
      setRun(payload.run as LoopRunResult);
      const runStatus = (payload.run as LoopRunResult | undefined)?.status;
      setNotice(runStatus === "waiting_for_approval"
        ? "Newsletter loop run completed and is waiting for approval."
        : "Newsletter loop run completed.");
      await loadWorkflow();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to run newsletter loop");
    } finally {
      setRunning(false);
    }
  }

  async function approveRun() {
    if (!run?.runId) return;
    setApproving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/workflows/runs/${run.runId}/approve`, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Failed to approve run");
      const approved = payload.run as WorkflowListRun;
      setRun({
        runId: approved.id,
        status: approved.status,
        draftRequired: approved.status === "waiting_for_approval",
        finalOutput: approved.draftOutput ?? run.finalOutput,
        createdAt: approved.createdAt,
      });
      setNotice("Draft approved. Run completed.");
      await loadWorkflow();
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : "Failed to approve run");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-72px)] bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-5">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="icon-sm">
              <Link href="/dashboard/loops">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <div>
              <h1 className="text-xl font-semibold text-slate-950">Weekly Product Newsletter</h1>
              <p className="mt-1 text-sm text-slate-500">CEO loop with three scoped execution agents.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!initialized ? (
              <Button type="button" variant="outline" onClick={initializeLoop} disabled={initializing || loading}>
                {initializing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                Initialize
              </Button>
            ) : null}
            {run?.status === "waiting_for_approval" ? (
              <Button
                type="button"
                variant="outline"
                className="rounded-none border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                onClick={approveRun}
                disabled={approving || running || loading}
              >
                {approving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
                Approve draft
              </Button>
            ) : null}
            <Button type="button" className="rounded-none bg-indigo-600 text-white hover:bg-indigo-700" onClick={runLoop} disabled={running || loading}>
              {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
              Run loop
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 px-6 py-6 lg:grid-cols-[320px_1fr]">
        <section className="space-y-4">
          <div className="border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-[0.08em] text-slate-400">Status</span>
              <span className={`h-2 w-2 rounded-full ${initialized ? "bg-emerald-500" : "bg-amber-400"}`} />
            </div>
            <p className="mt-2 text-sm font-medium text-slate-900">{initialized ? "Initialized" : "Not initialized"}</p>
            <p className="mt-1 text-xs text-slate-500">Schedule: {workflow?.definition.schedule.cron ?? NEWSLETTER_CRON}</p>
            <p className="mt-1 text-xs text-slate-500">Next: {formatDate(workflow?.nextRunAt ?? null)}</p>
          </div>

          <div className="border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ShieldCheck className="h-4 w-4 text-indigo-600" />
              Draft gate
            </div>
            <p className="mt-2 text-sm text-slate-600">External actions stop at a pending publication draft. Approval is required before send or publish.</p>
          </div>

          <div className="border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Clock className="h-4 w-4 text-slate-500" />
              Last run
            </div>
            <p className="mt-2 text-sm text-slate-600">{run ? `${run.runId} · ${run.status}` : "No run in this view yet."}</p>
            {run?.createdAt ? <p className="mt-1 text-xs text-slate-500">{formatDate(run.createdAt)}</p> : null}
          </div>
        </section>

        <section className="space-y-5">
          {error ? (
            <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
          ) : null}
          {notice ? (
            <div className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>
          ) : null}

          <div className="border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Sparkles className="h-4 w-4 text-indigo-600" />
              CEO
            </div>
            <p className="mt-3 text-sm text-slate-700">
              {workflow?.definition.ceo.task ?? `Orchestrate this recurring loop, spawn each specialist once, pass structured output forward, and produce the final result: ${NEWSLETTER_TASK}`}
            </p>
            <p className="mt-3 border-l-2 border-indigo-200 pl-3 text-xs text-slate-500">
              {workflow?.definition.ceo.policy ?? "Decide and coordinate only. Do not call specialist tools directly. All external actions must become approval drafts."}
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {agents.map((agent, index) => (
              <div key={agent.id} className="border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <span className="grid h-7 w-7 place-items-center border border-slate-200 bg-slate-50 text-slate-600">
                      {iconForAgent(agent.id)}
                    </span>
                    {agent.name}
                  </div>
                  <span className="text-xs text-slate-400">0{index + 1}</span>
                </div>
                <p className="mt-3 text-sm text-slate-600">{agent.task}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">{agent.integration}</span>
                  <span className="border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">{agent.toolPolicy.allowedTools[0]}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              Latest output
            </div>
            {run?.finalOutput ? (
              <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap bg-slate-950 p-4 text-xs leading-5 text-slate-100">
                {run.finalOutput}
              </pre>
            ) : (
              <p className="mt-3 text-sm text-slate-500">Run the loop to see the researcher, writer, publicist, and final approval draft output here.</p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
