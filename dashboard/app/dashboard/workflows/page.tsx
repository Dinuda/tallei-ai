"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  GitBranch,
  MessageSquarePlus,
  Pause,
  Play,
  Plus,
  Save,
  Send,
  Sparkles,
  Wrench,
  Zap,
  Bot,
  User,
  ChevronRight,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { StickToBottom } from "use-stick-to-bottom";

type WorkflowRun = {
  id: string;
  status: string;
  draftOutput: string | null;
  createdAt: string;
};

type WorkflowView = {
  id: string;
  title: string;
  status: string;
  scheduleRrule: string;
  latestRun: WorkflowRun | null;
};

type BuilderDraft = {
  title: string;
  instruction: string;
  scheduleRrule: string;
  outputType: string;
  sources: string[];
  approvalBehavior: "always_approve" | "auto_after_streak";
};

type BuilderEntry = {
  actor: "user" | "builder" | "critic" | "assistant";
  content: string;
  ts: string;
};

type BuilderSession = {
  id: string;
  status: "draft" | "saved" | "archived";
  title: string;
  goal: string;
  transcript: BuilderEntry[];
  draft: BuilderDraft;
  workflowId: string | null;
  updatedAt: string;
};

type InspectorTarget =
  | { type: "session"; id: string }
  | { type: "workflow"; id: string }
  | null;

function actorLabel(actor: BuilderEntry["actor"]): string {
  if (actor === "builder") return "Builder";
  if (actor === "critic") return "Critic";
  if (actor === "assistant") return "Tallei";
  return "You";
}

function planItemsForDraft(draft: BuilderDraft): string[] {
  return [
    `Trigger on ${draft.scheduleRrule}`,
    `Read ${draft.sources.length ? draft.sources.join(", ") : "the selected sources"}`,
    `Generate ${draft.outputType || "the requested output"}`,
    draft.approvalBehavior === "always_approve"
      ? "Hold for approval before completion"
      : "Auto-complete after repeated approved runs",
  ];
}

function workflowFromSession(
  session: BuilderSession | null,
  workflows: WorkflowView[]
): WorkflowView | null {
  if (!session?.workflowId) return null;
  return workflows.find((w) => w.id === session.workflowId) ?? null;
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
//  UI Components
/* ------------------------------------------------------------------ */

function SessionDropdown({
  sessions,
  workflows,
  selectedId,
  onSelect,
  onNew,
}: {
  sessions: BuilderSession[];
  workflows: WorkflowView[];
  selectedId: string | null;
  onSelect: (id: string, type: "session" | "workflow") => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected =
    sessions.find((s) => s.id === selectedId) ??
    (workflows.find((w) => w.id === selectedId)
      ? ({ title: workflows.find((w) => w.id === selectedId)!.title, id: selectedId } as BuilderSession)
      : null);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-[#e4f5c6] bg-[#f8fdf2] px-3 py-2 text-sm font-medium text-[#182506] transition hover:border-[#7eb71b] hover:shadow-sm"
      >
        <span className="max-w-[200px] truncate">
          {selected ? selected.title : "Select a conversation"}
        </span>
        <ChevronDown size={14} className="text-[#7a9a4a]" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-xl border border-[#e4f5c6] bg-white shadow-lg">
          <div className="max-h-[60vh] overflow-auto p-1.5">
            <button
              onClick={() => {
                onNew();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-[#7eb71b] transition hover:bg-[#f8fdf2]"
            >
              <Plus size={14} />
              New workflow chat
            </button>
            <div className="my-1 h-px bg-[#e4f5c6]" />

            {sessions.length > 0 && (
              <>
                <p className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#7a9a4a]">
                  Active drafts
                </p>
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      onSelect(s.id, "session");
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                      selectedId === s.id
                        ? "bg-[#f8fdf2] font-medium text-[#182506]"
                        : "text-[#3d5c18] hover:bg-[#f8fdf2]"
                    }`}
                  >
                    <MessageSquarePlus size={14} className="shrink-0 text-[#7a9a4a]" />
                    <span className="truncate">{s.title || s.goal}</span>
                  </button>
                ))}
              </>
            )}

            {workflows.length > 0 && (
              <>
                <div className="my-1 h-px bg-[#e4f5c6]" />
                <p className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#7a9a4a]">
                  Saved workflows
                </p>
                {workflows.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => {
                      onSelect(w.id, "workflow");
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                      selectedId === w.id
                        ? "bg-[#f8fdf2] font-medium text-[#182506]"
                        : "text-[#3d5c18] hover:bg-[#f8fdf2]"
                    }`}
                  >
                    <Zap size={14} className="shrink-0 text-[#7a9a4a]" />
                    <span className="truncate">{w.title}</span>
                    <span
                      className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        w.status === "active"
                          ? "bg-[#ecfdf5] text-[#166534]"
                          : "bg-[#f1f5f9] text-[#64748b]"
                      }`}
                    >
                      {w.status}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowCard({
  session,
  onClick,
}: {
  session: BuilderSession;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group w-full max-w-[680px] rounded-2xl border border-[#e4f5c6] bg-[#f8fdf2] p-4 text-left transition hover:border-[#7eb71b] hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[#7eb71b]/10">
            <Wrench size={16} className="text-[#7eb71b]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[#182506]">{session.draft.title}</p>
            <p className="text-xs text-[#7a9a4a]">
              {session.draft.scheduleRrule} · {session.status}
            </p>
          </div>
        </div>
        <ChevronRight
          size={16}
          className="mt-1.5 shrink-0 text-[#7a9a4a] transition group-hover:translate-x-0.5"
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {planItemsForDraft(session.draft).map((item) => (
          <span
            key={item}
            className="inline-flex items-center rounded-lg border border-[#e4f5c6] bg-white px-2 py-1 text-xs text-[#3d5c18]"
          >
            {item}
          </span>
        ))}
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-[#ecfdf5] text-[#166534] border-[#bbf7d0]",
    paused: "bg-[#fff7ed] text-[#9a3412] border-[#fdba74]",
    archived: "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]",
    draft: "bg-[#f8fdf2] text-[#3d5c18] border-[#e4f5c6]",
    saved: "bg-[#ecfdf5] text-[#166534] border-[#bbf7d0]",
    waiting_for_approval: "bg-amber-50 text-amber-700 border-amber-200",
    completed: "bg-[#ecfdf5] text-[#166534] border-[#bbf7d0]",
    failed: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${
        map[status] ?? map.draft
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

/* ------------------------------------------------------------------ */
//  Main Page
/* ------------------------------------------------------------------ */

export default function WorkflowsPage() {
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [goalInput, setGoalInput] = useState("");
  const [messageInput, setMessageInput] = useState("");
  const [sessions, setSessions] = useState<BuilderSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [inspectorTarget, setInspectorTarget] = useState<InspectorTarget>(null);
  const [workflows, setWorkflows] = useState<WorkflowView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  );

  const inspectedSession = useMemo(() => {
    if (inspectorTarget?.type !== "session") return selectedSession;
    return sessions.find((s) => s.id === inspectorTarget.id) ?? selectedSession;
  }, [inspectorTarget, selectedSession, sessions]);

  const inspectedWorkflow = useMemo(() => {
    if (inspectorTarget?.type === "workflow") {
      return workflows.find((w) => w.id === inspectorTarget.id) ?? null;
    }
    return workflowFromSession(inspectedSession, workflows);
  }, [inspectorTarget, inspectedSession, workflows]);

  const activeDraft = inspectedSession?.draft ?? selectedSession?.draft ?? null;
  const activePlan = activeDraft ? planItemsForDraft(activeDraft) : [];

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/workflows", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok)
        throw new Error(
          typeof data?.error === "string" ? data.error : "Failed to load workflows"
        );
      const nextSessions = Array.isArray(data?.builderSessions)
        ? data.builderSessions
        : [];
      const nextWorkflows = Array.isArray(data?.workflows) ? data.workflows : [];
      setSessions(nextSessions);
      setWorkflows(nextWorkflows);
      if (!selectedSessionId && nextSessions[0]?.id) {
        setSelectedSessionId(nextSessions[0].id);
        setInspectorTarget({ type: "session", id: nextSessions[0].id });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflows");
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const createSession = useCallback(
    async (goalOverride?: string) => {
      const goal = (goalOverride ?? goalInput).trim();
      if (!goal) return;
      setCreating(true);
      setError(null);
      try {
        const res = await fetch("/api/workflows/builder/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal }),
        });
        const data = await res.json();
        if (!res.ok)
          throw new Error(
            typeof data?.error === "string" ? data.error : "Failed to create session"
          );
        const session = data?.session as BuilderSession;
        setSessions((prev) => [session, ...prev]);
        setSelectedSessionId(session.id);
        setInspectorTarget({ type: "session", id: session.id });
        setGoalInput("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create session");
      } finally {
        setCreating(false);
      }
    },
    [goalInput]
  );

  const sendMessage = useCallback(async () => {
    const message = selectedSession ? messageInput.trim() : goalInput.trim();
    if (!message) return;
    if (!selectedSession) {
      await createSession(message);
      return;
    }

    setSending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workflows/builder/sessions/${selectedSession.id}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        }
      );
      const data = await res.json();
      if (!res.ok)
        throw new Error(
          typeof data?.error === "string" ? data.error : "Failed to send message"
        );
      const updated = data?.session as BuilderSession;
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s))
      );
      setInspectorTarget({ type: "session", id: updated.id });
      setMessageInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }, [createSession, messageInput, selectedSession]);

  const saveWorkflow = useCallback(async () => {
    if (!selectedSession) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workflows/builder/sessions/${selectedSession.id}/save`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok)
        throw new Error(
          typeof data?.error === "string" ? data.error : "Failed to save workflow"
        );
      const updated = data?.session as BuilderSession;
      setSessions((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s))
      );
      setInspectorTarget({ type: "session", id: updated.id });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save workflow");
    } finally {
      setSaving(false);
    }
  }, [loadData, selectedSession]);

  const runWorkflow = useCallback(
    async (workflowId: string) => {
      setError(null);
      const res = await fetch(`/api/workflows/${workflowId}/run`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          typeof data?.error === "string"
            ? data.error
            : "Failed to start workflow run"
        );
        return;
      }
      setInspectorTarget({ type: "workflow", id: workflowId });
      await loadData();
    },
    [loadData]
  );

  const changeWorkflowStatus = useCallback(
    async (workflowId: string, action: "pause" | "resume" | "archive") => {
      setError(null);
      const res = await fetch(`/api/workflows/${workflowId}/${action}`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          typeof data?.error === "string"
            ? data.error
            : `Failed to ${action} workflow`
        );
        return;
      }
      await loadData();
    },
    [loadData]
  );

  const decideRun = useCallback(
    async (runId: string, action: "approve" | "skip") => {
      setError(null);
      const res = await fetch(`/api/workflows/runs/${runId}/${action}`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          typeof data?.error === "string"
            ? data.error
            : `Failed to ${action} run`
        );
        return;
      }
      await loadData();
    },
    [loadData]
  );

  // Auto-resize textarea
  const adjustInputHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  useEffect(() => {
    adjustInputHeight();
  }, [goalInput, messageInput, adjustInputHeight]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const handleSelect = (id: string, type: "session" | "workflow") => {
    if (type === "session") {
      setSelectedSessionId(id);
      setInspectorTarget({ type: "session", id });
    } else {
      setSelectedSessionId(null);
      setInspectorTarget({ type: "workflow", id });
    }
  };

  const handleNew = () => {
    setSelectedSessionId(null);
    setInspectorTarget(null);
    setGoalInput("");
    setMessageInput("");
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  // Derive the current conversation items
  const conversation = useMemo(() => {
    if (!selectedSession) return null;
    return selectedSession;
  }, [selectedSession]);

  const hasContent = conversation !== null || inspectedWorkflow !== null;

  return (
    <main className="flex h-[calc(100vh-72px)] gap-4 p-8 font-[var(--font-fustat)]">
      {/* =====================  CHAT AREA  ===================== */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[#e4f5c6] bg-white shadow-sm">
        <header className="flex items-start justify-between gap-4 px-7 py-6">
          <div>
            <h1 className="text-4xl font-bold leading-tight tracking-[-0.01em] text-slate-950">Loops</h1>
            <p className="mt-1 text-sm text-slate-500">Patterns Tallei noticed in your work</p>
          </div>
          <button
            onClick={() => void loadData()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-700 transition hover:border-[#7eb71b] hover:text-slate-900 disabled:opacity-40"
            aria-label="Refresh"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        </header>

        {error ? (
          <div className="border-b border-red-100 bg-red-50 px-5 py-2.5 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {/* Messages */}
        <StickToBottom className="min-h-0 flex-1">
          {({ scrollRef, contentRef }) => (
            <div ref={scrollRef} className="h-full overflow-y-auto">
              <div
                ref={contentRef}
                className="mx-auto flex max-w-[760px] flex-col gap-5 px-5 py-8"
              >
                {!hasContent && !loading ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-6 py-20">
                    <div className="grid h-14 w-14 place-items-center rounded-2xl bg-[#f8fdf2]">
                      <Sparkles size={28} className="text-[#7eb71b]" />
                    </div>
                    <div className="text-center">
                      <h2 className="text-lg font-semibold text-[#182506]">
                        What should Tallei do on repeat?
                      </h2>
                      <p className="mt-1 text-sm text-[#7a9a4a]">
                        Describe a recurring task and I&apos;ll turn it into a workflow.
                      </p>
                    </div>
                    <div className="flex w-full max-w-md flex-col gap-2">
                      {[
                        "Send me a weekly summary of my product updates every Friday",
                        "Daily competitor price check at 9am and alert on changes",
                        "Monthly report on support ticket trends",
                      ].map((suggestion) => (
                        <button
                          key={suggestion}
                          onClick={() => {
                            setGoalInput(suggestion);
                            inputRef.current?.focus();
                          }}
                          className="rounded-xl border border-[#e4f5c6] bg-[#f8fdf2] px-4 py-3 text-left text-sm text-[#3d5c18] transition hover:border-[#7eb71b] hover:shadow-sm"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {loading && !hasContent ? (
                  <div className="flex flex-col gap-4 py-10">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`flex gap-3 ${i % 2 === 0 ? "flex-row-reverse" : ""}`}
                      >
                        <div className="h-7 w-7 shrink-0 rounded-full bg-[#f1f5f9]" />
                        <div className="h-16 w-2/3 rounded-2xl bg-[#f1f5f9]" />
                      </div>
                    ))}
                  </div>
                ) : null}

                {/* Conversation transcript */}
                {conversation?.transcript.map((entry, index) => {
                  const isUser = entry.actor === "user";
                  const isReasoning = entry.actor === "builder" || entry.actor === "critic";

                  if (isReasoning) {
                    return (
                      <div
                        key={`${entry.ts}-${index}`}
                        className="mx-auto w-full max-w-[640px]"
                      >
                        <details className="group rounded-xl border border-[#e4f5c6] bg-[#f8fdf2]">
                          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-[#7a9a4a]">
                            <ChevronRight
                              size={12}
                              className="transition group-open:rotate-90"
                            />
                            {actorLabel(entry.actor)} thought process
                          </summary>
                          <div className="px-3 pb-3">
                            <p className="whitespace-pre-wrap text-sm text-[#3d5c18]">
                              {entry.content}
                            </p>
                          </div>
                        </details>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={`${entry.ts}-${index}`}
                      className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}
                    >
                      <div
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${
                          isUser
                            ? "bg-[#182506] text-white"
                            : "bg-[#f8fdf2] text-[#7eb71b]"
                        }`}
                      >
                        {isUser ? <User size={12} /> : <Bot size={12} />}
                      </div>
                      <div
                        className={`max-w-[640px] ${
                          isUser
                            ? "rounded-2xl rounded-tr-sm bg-[#182506] px-4 py-3 text-white"
                            : "rounded-2xl rounded-tl-sm border border-[#e4f5c6] bg-[#f8fdf2] px-4 py-3 text-[#182506]"
                        }`}
                      >
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider opacity-60">
                          {actorLabel(entry.actor)}
                        </p>
                        <div className="prose-sm max-w-none">
                          <p className="whitespace-pre-wrap text-sm leading-relaxed">
                            {entry.content}
                          </p>
                        </div>
                        <p
                          className={`mt-1.5 text-[10px] ${
                            isUser ? "text-white/40" : "text-[#7a9a4a]"
                          }`}
                        >
                          {formatTime(entry.ts)}
                        </p>
                      </div>
                    </div>
                  );
                })}

                {/* Inline workflow draft card */}
                {conversation && conversation.status !== "archived" ? (
                  <div className="flex gap-3">
                    <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#f8fdf2] text-[#7eb71b]">
                      <Bot size={12} />
                    </div>
                    <WorkflowCard
                      session={conversation}
                      onClick={() => {
                        setInspectorTarget({
                          type: "session",
                          id: conversation.id,
                        });
                      }}
                    />
                  </div>
                ) : null}

                {/* Saved workflow list shown inline when no session selected */}
                {!conversation && !inspectedWorkflow && workflows.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#7a9a4a]">
                      Saved workflows
                    </p>
                    {workflows.map((w) => (
                      <button
                        key={w.id}
                        onClick={() =>
                          setInspectorTarget({ type: "workflow", id: w.id })
                        }
                        className="flex items-center justify-between rounded-xl border border-[#e4f5c6] bg-white px-4 py-3 text-left transition hover:border-[#7eb71b] hover:shadow-sm"
                      >
                        <div className="flex items-center gap-3">
                          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[#f8fdf2]">
                            <Zap size={16} className="text-[#7eb71b]" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-[#182506]">
                              {w.title}
                            </p>
                            <p className="text-xs text-[#7a9a4a]">
                              {w.scheduleRrule}
                              {w.latestRun
                                ? ` · latest run ${w.latestRun.status}`
                                : ""}
                            </p>
                          </div>
                        </div>
                        <StatusBadge status={w.status} />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </StickToBottom>

        {/* Input */}
        <footer className="border-t border-[#e4f5c6] bg-white p-4">
          <div className="mx-auto flex max-w-[760px] flex-col gap-2 rounded-2xl border border-[#cce89e] bg-white p-3 shadow-sm transition focus-within:border-[#7eb71b] focus-within:shadow-md">
            <textarea
              ref={inputRef}
              value={selectedSession ? messageInput : goalInput}
              onChange={(e) => {
                if (selectedSession) setMessageInput(e.target.value);
                else setGoalInput(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              className="w-full resize-none border-0 bg-transparent text-sm text-[#182506] outline-none placeholder:text-[#7a9a4a]/60"
              placeholder={
                selectedSession
                  ? "Ask Tallei to refine the workflow..."
                  : "Describe a recurring task you want automated..."
              }
            />
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] text-[#7a9a4a]">
                <Wrench size={12} />
                {selectedSession ? "Workflow draft active" : "New workflow chat"}
              </span>
              <div className="flex items-center gap-2">
                {selectedSession && (
                  <button
                    onClick={() => void saveWorkflow()}
                    disabled={saving}
                    className="flex items-center gap-1.5 rounded-lg border border-[#e4f5c6] px-3 py-1.5 text-xs font-medium text-[#3d5c18] transition hover:bg-[#f8fdf2] disabled:opacity-40"
                  >
                    {saving ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Save size={12} />
                    )}
                    Save
                  </button>
                )}
                <button
                  onClick={() => void sendMessage()}
                  disabled={
                    creating ||
                    sending ||
                    (!selectedSession
                      ? !goalInput.trim()
                      : !messageInput.trim())
                  }
                  className="flex items-center gap-1.5 rounded-lg bg-[#7eb71b] px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[#6aa015] disabled:opacity-40"
                >
                  {sending || creating ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Send size={12} />
                  )}
                  {creating ? "Creating..." : sending ? "Sending..." : "Send"}
                </button>
              </div>
            </div>
          </div>
        </footer>
      </section>

      {/* =====================  RIGHT PANEL  ===================== */}
      <aside className="hidden min-h-0 w-[340px] flex-col overflow-hidden rounded-2xl border border-[#e4f5c6] bg-white shadow-sm lg:flex">
        <div className="flex h-full flex-col">
          {/* Panel header */}
          <div className="border-b border-[#e4f5c6] px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7a9a4a]">
              Workflow Details
            </p>
            <h2 className="mt-1 text-base font-bold text-[#182506]">
              {activeDraft?.title ?? inspectedWorkflow?.title ?? "No workflow selected"}
            </h2>
            {activeDraft || inspectedWorkflow ? (
              <p className="mt-1 text-xs text-[#7a9a4a]">
                {activeDraft?.scheduleRrule ?? inspectedWorkflow?.scheduleRrule}
              </p>
            ) : null}
          </div>

          {/* Panel body */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {!activeDraft && !inspectedWorkflow ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#f8fdf2]">
                  <GitBranch size={20} className="text-[#7a9a4a]" />
                </div>
                <p className="text-sm text-[#7a9a4a]">
                  Select a workflow from the chat to view details and actions.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {/* Status */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-[#7a9a4a]">Status</span>
                  <StatusBadge
                    status={
                      inspectedWorkflow?.status ??
                      inspectedSession?.status ??
                      "draft"
                    }
                  />
                </div>

                {/* Execution flow */}
                <div className="rounded-xl border border-[#e4f5c6] bg-[#f8fdf2] p-3">
                  <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-[#182506]">
                    <GitBranch size={14} className="text-[#7eb71b]" />
                    Execution Flow
                  </div>
                  <div className="flex flex-col gap-2">
                    {["Trigger", "Gather context", "Generate output", "Approval"].map(
                      (node, idx) => (
                        <div key={node} className="flex items-center gap-2.5">
                          <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#7eb71b]/10 text-[10px] font-bold text-[#7eb71b]">
                            {idx + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-[#182506]">{node}</p>
                            <p className="truncate text-[11px] text-[#7a9a4a]">
                              {activePlan[idx] ?? "Ready"}
                            </p>
                          </div>
                        </div>
                      )
                    )}
                  </div>
                </div>

                {/* Plan */}
                {activePlan.length > 0 && (
                  <div className="rounded-xl border border-[#e4f5c6] bg-white p-3">
                    <p className="mb-2 text-xs font-semibold text-[#182506]">
                      Implementation Plan
                    </p>
                    <ul className="flex flex-col gap-2">
                      {activePlan.map((item) => (
                        <li
                          key={item}
                          className="flex items-start gap-2 text-xs text-[#3d5c18]"
                        >
                          <CheckCircle2
                            size={14}
                            className="mt-0.5 shrink-0 text-[#7eb71b]"
                          />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Sources */}
                {activeDraft?.sources && activeDraft.sources.length > 0 && (
                  <div className="rounded-xl border border-[#e4f5c6] bg-white p-3">
                    <p className="mb-2 text-xs font-semibold text-[#182506]">Sources</p>
                    <div className="flex flex-wrap gap-1.5">
                      {activeDraft.sources.map((s) => (
                        <span
                          key={s}
                          className="rounded-lg border border-[#e4f5c6] bg-[#f8fdf2] px-2 py-1 text-[11px] text-[#3d5c18]"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Instruction */}
                {activeDraft?.instruction && (
                  <div className="rounded-xl border border-[#e4f5c6] bg-white p-3">
                    <p className="mb-2 text-xs font-semibold text-[#182506]">
                      Instruction
                    </p>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-[#3d5c18]">
                      {activeDraft.instruction}
                    </p>
                  </div>
                )}

                {/* Latest run info */}
                {inspectedWorkflow?.latestRun && (
                  <div className="rounded-xl border border-[#e4f5c6] bg-white p-3">
                    <p className="mb-2 text-xs font-semibold text-[#182506]">
                      Latest Run
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[#3d5c18]">
                        {new Date(
                          inspectedWorkflow.latestRun.createdAt
                        ).toLocaleString()}
                      </span>
                      <StatusBadge status={inspectedWorkflow.latestRun.status} />
                    </div>
                    {inspectedWorkflow.latestRun.draftOutput ? (
                      <p className="mt-2 whitespace-pre-wrap rounded-lg bg-[#f8fdf2] p-2 text-[11px] text-[#3d5c18]">
                        {inspectedWorkflow.latestRun.draftOutput}
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Panel footer actions */}
          <div className="border-t border-[#e4f5c6] px-5 py-4">
            {inspectedWorkflow ? (
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => void runWorkflow(inspectedWorkflow.id)}
                  className="flex items-center justify-center gap-2 rounded-xl bg-[#7eb71b] px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#6aa015]"
                >
                  <Play size={14} />
                  Run now
                </button>
                <div className="grid grid-cols-2 gap-2">
                  {inspectedWorkflow.status === "active" ? (
                    <button
                      onClick={() =>
                        void changeWorkflowStatus(inspectedWorkflow.id, "pause")
                      }
                      className="flex items-center justify-center gap-2 rounded-xl border border-[#e4f5c6] px-3 py-2 text-sm font-medium text-[#3d5c18] transition hover:bg-[#f8fdf2]"
                    >
                      <Pause size={14} />
                      Pause
                    </button>
                  ) : (
                    <button
                      onClick={() =>
                        void changeWorkflowStatus(inspectedWorkflow.id, "resume")
                      }
                      className="flex items-center justify-center gap-2 rounded-xl border border-[#e4f5c6] px-3 py-2 text-sm font-medium text-[#3d5c18] transition hover:bg-[#f8fdf2]"
                    >
                      <Play size={14} />
                      Resume
                    </button>
                  )}
                  <button
                    onClick={() =>
                      void changeWorkflowStatus(inspectedWorkflow.id, "archive")
                    }
                    className="flex items-center justify-center gap-2 rounded-xl border border-[#e4f5c6] px-3 py-2 text-sm font-medium text-[#3d5c18] transition hover:bg-[#f8fdf2]"
                  >
                    <Archive size={14} />
                    Archive
                  </button>
                </div>
                {inspectedWorkflow.latestRun?.status === "waiting_for_approval" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() =>
                        void decideRun(inspectedWorkflow.latestRun!.id, "approve")
                      }
                      className="rounded-xl border border-[#bbf7d0] bg-[#ecfdf5] px-3 py-2 text-sm font-medium text-[#166534] transition hover:bg-[#d1fae5]"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() =>
                        void decideRun(inspectedWorkflow.latestRun!.id, "skip")
                      }
                      className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700 transition hover:bg-amber-100"
                    >
                      Skip
                    </button>
                  </div>
                ) : null}
              </div>
            ) : selectedSession ? (
              <button
                onClick={() => void saveWorkflow()}
                disabled={saving}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#7eb71b] px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#6aa015] disabled:opacity-40"
              >
                {saving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Save size={14} />
                )}
                {saving ? "Saving..." : "Save workflow"}
              </button>
            ) : null}
          </div>
        </div>
      </aside>
    </main>
  );
}
