"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
import { isLennyNewsletterGoal, isNewsletterLoopDefinition, LENNY_NEWSLETTER_LOOP_GOAL } from "@/lib/lenny-newsletter";

const NEWSLETTER_TASK = LENNY_NEWSLETTER_LOOP_GOAL;
const NEWSLETTER_CRON = "0 9 * * 1";
const NEWSLETTER_CEO_TASK =
  "Run the fixed Lenny newsletter pipeline for product builders. Keep the roster in this order: Search Agent -> Web Search Agent -> Research Agent -> Writer -> Approval Handoff. Ground the run in recent Lenny themes, weekly AI and product-builder sources, and produce one subscriber-ready newsletter draft for approval.";
const NEWSLETTER_CEO_POLICY =
  "Use only the fixed newsletter preset roster. Search Agent surfaces memory-backed topics and voice cues. Web Search Agent gathers current weekly sources. Research Agent recommends one lead topic with rationale. Writer drafts the final newsletter. Approval Handoff sends the draft for operator approval before contacts upload and delivery.";

const NEWSLETTER_PRESET_AGENTS: Array<Omit<LoopAgentPreview, "status">> = [
  {
    id: "search_agent",
    name: "Search Agent",
    task: "Search every relevant memory about Lenny's Newsletter, including prior issue examples, writing style, voice, formatting, recurring sections, sign-offs, and editorial preferences. Output three ranked topic candidates plus Lenny voice and theme guidance.",
    tools: [{
      ref: "internal.memory_search",
      config: {
        limit: 20,
        query: "Lenny's Newsletter previous issues writing style voice formatting examples editorial preferences recurring sections tone sign-off product builders",
      },
    }],
  },
  {
    id: "web_search_agent",
    name: "Web Search Agent",
    task: "Gather evidence from this week's AI and product-builder sources. In development, use the seeded weekly links; in production, use live web search across the approved source domains.",
    tools: [{ ref: "internal.web_search" }],
  },
  {
    id: "research_agent",
    name: "Research Agent",
    task: "Synthesize the candidate topics, choose one recommended lead topic, explain why it fits Lenny's recent direction, and hand the writer a concise briefing.",
    tools: [{ ref: "internal.llm_only" }],
  },
  {
    id: "writer",
    name: "Writer",
    task: "Draft the subscriber-facing newsletter from the selected topic and briefing. Output only the final newsletter body with subject metadata, not workflow notes.",
    tools: [{ ref: "internal.llm_only" }],
  },
  {
    id: "approval_handoff",
    name: "Approval Handoff",
    task: "Send the final draft to the operator for approval before delivery.",
    tools: [
      { ref: "internal.email_approval_request" },
      { ref: "internal.email_builder_compose" },
      { ref: "internal.email_builder_render" },
    ],
  },
];

type LoopAgentPreview = {
  id: string;
  name: string;
  task: string;
  tools: Array<{ ref: string; config?: Record<string, unknown> }>;
  status?: string;
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
    allowedIntegrations?: string[];
    integrations?: string[];
    ceo: { name: string; task: string; policy: string };
    draftPolicy: { requireDraftBeforeExternalAction: boolean; approvalRequiredFor: string[] };
    presetId?: string;
  };
};

type LoopRunResult = {
  runId: string;
  status: string;
  draftRequired: boolean;
  createdAt?: string | null;
};

type RunResponse = Partial<LoopRunResult> & {
  id?: string;
  draftOutput?: string | null;
};

type WorkflowListRun = {
  id: string;
  workflowId?: string;
  status: string;
  runMode?: string;
  scheduledFor?: string | null;
  draftOutput: string | null;
  createdAt: string;
  updatedAt?: string;
};

type WorkflowListItem = {
  id: string;
  latestRun: WorkflowListRun | null;
};

function formatDate(value: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function iconForAgent(agent: LoopAgentPreview) {
  const key = `${agent.id} ${agent.name} ${agent.tools.map((tool) => tool.ref).join(" ")}`.toLowerCase();
  if (key.includes("search") || key.includes("research")) return <Search className="h-4 w-4" />;
  if (key.includes("writer") || key.includes("draft") || key.includes("llm")) return <FileText className="h-4 w-4" />;
  return <Megaphone className="h-4 w-4" />;
}

function agentStatusClass(status?: string) {
  if (status === "done" || status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "in_progress") return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "blocked" || status === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-slate-50 text-slate-500";
}

function prettyAgentStatus(status?: string) {
  if (!status) return "Queued";
  if (status === "done" || status === "completed") return "Done";
  if (status === "in_progress") return "Running";
  return status.replace(/_/g, " ");
}

function ToolConfigDetails({ tools, compact = false }: { tools: LoopAgentPreview["tools"]; compact?: boolean }) {
  const configuredTools = tools.filter((tool) => tool.config);
  if (configuredTools.length === 0) return null;
  return (
    <div className={compact ? "mt-2 space-y-2" : "mt-3 space-y-2"}>
      {configuredTools.map((tool) => (
        <div key={`${tool.ref}-config`} className="border border-slate-200 bg-white px-2 py-2 text-xs text-slate-600">
          <div className="font-medium text-slate-700">{tool.ref} config</div>
          {typeof tool.config?.limit === "number" ? (
            <div className="mt-1">limit: {tool.config.limit}</div>
          ) : null}
          {typeof tool.config?.query === "string" ? (
            <div className="mt-1 break-words">query: {tool.config.query}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function newsletterPresetAgents(status?: string): LoopAgentPreview[] {
  const agentStatus = status === "running" ? "in_progress" : "queued";
  return NEWSLETTER_PRESET_AGENTS.map((agent) => ({ ...agent, status: agentStatus }));
}

function isExplicitLennyNewsletterLoop(loop: LoopWorkflow): boolean {
  return loop.definition?.presetId === "newsletter" && isLennyNewsletterGoal(loop.definition?.goal);
}

function isAnyLennyNewsletterLoop(loop: LoopWorkflow): boolean {
  return isLennyNewsletterGoal(loop.definition?.goal) || /lenny/i.test(loop.title);
}

function findNewsletterLoop(loops: LoopWorkflow[]): LoopWorkflow | null {
  return loops.find(isExplicitLennyNewsletterLoop)
    ?? loops.find(isAnyLennyNewsletterLoop)
    ?? loops.find((loop) =>
      isNewsletterLoopDefinition({
        goal: loop.definition?.goal,
        presetId: loop.definition?.presetId,
        title: loop.title,
      })
      && !/\bxyz\b/i.test(`${loop.title} ${loop.definition?.goal ?? ""}`)
    )
    ?? null;
}

function mapWorkflowRun(run: WorkflowListRun): LoopRunResult {
  return {
    runId: run.id,
    status: run.status,
    draftRequired: run.status === "waiting_for_approval",
    createdAt: run.createdAt,
  };
}

function normalizeRunResponse(run: RunResponse): LoopRunResult | null {
  const runId = typeof run.runId === "string" && run.runId.trim()
    ? run.runId
    : typeof run.id === "string" && run.id.trim()
      ? run.id
      : null;
  if (!runId) return null;
  const status = typeof run.status === "string" && run.status.trim() ? run.status : "running";
  return {
    runId,
    status,
    draftRequired: run.draftRequired === true || status === "waiting_for_approval",
    createdAt: typeof run.createdAt === "string" ? run.createdAt : null,
  };
}

export default function NewsletterLoopPage() {
  const router = useRouter();
  const [workflow, setWorkflow] = useState<LoopWorkflow | null>(null);
  const [run, setRun] = useState<LoopRunResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializing, setInitializing] = useState(false);
  const [running, setRunning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [agents, setAgents] = useState<LoopAgentPreview[]>([]);
  const [runHistory, setRunHistory] = useState<WorkflowListRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

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
      const runsResponse = nextWorkflow
        ? await fetch(`/api/workflows/internal/loops/${nextWorkflow.id}/runs`, { cache: "no-store" })
        : null;
      const runsPayload = runsResponse ? await runsResponse.json().catch(() => ({})) : {};
      const runs = runsResponse?.ok && Array.isArray((runsPayload as { runs?: WorkflowListRun[] }).runs)
        ? (runsPayload as { runs: WorkflowListRun[] }).runs
        : linked?.latestRun?.id
          ? [linked.latestRun]
          : [];
      setRunHistory(runs);
      const activeRun = runs.find((item) => item.id === selectedRunId) ?? runs[0] ?? null;
      if (activeRun?.id) {
        setSelectedRunId(activeRun.id);
        setRun(mapWorkflowRun(activeRun));
        setAgents(newsletterPresetAgents());
      } else {
        setRun(null);
        setAgents(newsletterPresetAgents());
        setSelectedRunId(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load loop");
    } finally {
      setLoading(false);
    }
  }, [selectedRunId]);

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
          preset_id: "newsletter",
          integrations: ["internal", "react_email"],
          allowed_tool_refs: [
            "internal.memory_search",
            "internal.web_search",
            "internal.llm_only",
            "internal.email_approval_request",
            "internal.email_builder_compose",
            "internal.email_builder_render",
            "internal.resend_broadcast",
            "internal.react_email_template",
          ],
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
      const nextRun = normalizeRunResponse(payload.run as RunResponse);
      if (nextRun?.runId) {
        router.push(`/dashboard/loops/${activeWorkflow.id}/runs/${nextRun.runId}`);
        return;
      }
      throw new Error("Run started but backend did not return a run id");
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
              <h1 className="text-xl font-semibold text-slate-950">Lenny&apos;s Weekly Newsletter</h1>
              <p className="mt-1 text-sm text-slate-500">Fixed Search → Research → Writer → Approval pipeline from the newsletter preset.</p>
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

          <div className="border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Clock className="h-4 w-4 text-slate-500" />
                Previous runs
              </div>
              <span className="text-xs text-slate-400">{runHistory.length}</span>
            </div>
            {runHistory.length > 0 ? (
              <div className="mt-3 space-y-2">
                {runHistory.map((item) => {
                  const selected = item.id === selectedRunId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        if (!workflow?.id) return;
                        router.push(`/dashboard/loops/${workflow.id}/runs/${item.id}`);
                      }}
                      className={`w-full border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-slate-900 bg-slate-50"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium text-slate-900">
                          Run {item.id.slice(0, 6)}
                        </span>
                        <span className={`shrink-0 border px-1.5 py-0.5 text-[10px] font-medium capitalize ${agentStatusClass(item.status)}`}>
                          {prettyAgentStatus(item.status)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{formatDate(item.createdAt)}</p>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No previous runs yet.</p>
            )}
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
              {NEWSLETTER_CEO_TASK}
            </p>
            <p className="mt-3 border-l-2 border-indigo-200 pl-3 text-xs text-slate-500">
              {NEWSLETTER_CEO_POLICY}
            </p>
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900">Agents triggered for this run</h2>
              <span className="text-xs text-slate-500">{agents.length} agents</span>
            </div>
            {agents.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {agents.map((agent, index) => (
                  <div key={`${agent.id}-${index}`} className="border border-slate-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900">
                        <span className="grid h-7 w-7 shrink-0 place-items-center border border-slate-200 bg-slate-50 text-slate-600">
                          {iconForAgent(agent)}
                        </span>
                        <span className="truncate">{agent.name}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className={`border px-2 py-0.5 text-[11px] font-medium capitalize ${agentStatusClass(agent.status)}`}>
                          {prettyAgentStatus(agent.status)}
                        </span>
                        <span className="text-xs text-slate-400">{String(index + 1).padStart(2, "0")}</span>
                      </div>
                    </div>
                    <p className="mt-3 text-sm text-slate-600">{agent.task}</p>
                    {agent.tools.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {agent.tools.map((tool) => (
                          <span key={tool.ref} className="border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                            {tool.ref}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <ToolConfigDetails tools={agent.tools} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="border border-dashed border-slate-200 bg-white px-4 py-5 text-sm text-slate-500">
                Run the loop to see the exact agent roster selected for that run.
              </div>
            )}
          </div>

          <div className="border border-slate-200 bg-white p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              Run agents
            </div>
            {agents.length > 0 ? (
              <div className="mt-4 space-y-3">
                {agents.map((agent, index) => (
                  <div key={`summary-${agent.id}-${index}`} className="flex items-start justify-between gap-3 border border-slate-200 bg-slate-50 px-3 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="grid h-7 w-7 shrink-0 place-items-center border border-slate-200 bg-white text-slate-600">
                          {iconForAgent(agent)}
                        </span>
                        <p className="text-sm font-medium text-slate-900">{agent.name}</p>
                      </div>
                      <p className="mt-2 text-sm text-slate-600">{agent.task}</p>
                      <ToolConfigDetails tools={agent.tools} compact />
                    </div>
                    <span className={`shrink-0 border px-2 py-0.5 text-[11px] font-medium capitalize ${agentStatusClass(agent.status)}`}>
                      {prettyAgentStatus(agent.status)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">Run the loop to see the exact agents selected for this run here.</p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
