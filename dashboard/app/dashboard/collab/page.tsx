"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, ArrowRight } from "lucide-react";

import { EmptyCollectionState } from "../components/empty-collection-state";
import styles from "./page.module.css";

type CollabState = "CREATIVE" | "TECHNICAL" | "DONE" | "ERROR";
type CollabActor = "chatgpt" | "claude" | "user";
type CollabFilter = "all" | "active" | "waiting" | "done";

type TranscriptEntry = {
  actor: CollabActor;
  iteration: number;
  content: string;
  ts: string;
};

type CollabTask = {
  id: string;
  title: string;
  brief: string | null;
  state: CollabState;
  lastActor: CollabActor | null;
  iteration: number;
  maxIterations: number;
  updatedAt: string;
  transcript?: TranscriptEntry[];
  context?: Record<string, unknown>;
};

type OrchestrationStatus = "DRAFT" | "INTERVIEWING" | "PLAN_READY" | "RUNNING" | "DONE" | "ABORTED";

type OrchestrationSession = {
  id: string;
  goal: string;
  status: OrchestrationStatus;
  plan: { title?: string; summary?: string; first_actor?: "chatgpt" | "claude" } | null;
  collabTaskId: string | null;
  updatedAt: string;
  transcript?: Array<{ role: "planner" | "user" | "system"; content: string; ts: string }>;
  metadata?: Record<string, unknown>;
};

const FILTERS: Array<{ id: CollabFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "waiting", label: "Waiting on me" },
  { id: "done", label: "Done" },
];

const STATE_CONFIG: Record<CollabState, { label: string; bg: string; border: string; text: string }> = {
  CREATIVE: {
    label: "ChatGPT's turn",
    bg: "var(--actor-chatgpt-bg)",
    border: "var(--actor-chatgpt-border)",
    text: "var(--actor-chatgpt-text)",
  },
  TECHNICAL: {
    label: "Claude's turn",
    bg: "var(--actor-claude-bg)",
    border: "var(--actor-claude-border)",
    text: "var(--actor-claude-text)",
  },
  DONE: {
    label: "Completed",
    bg: "var(--status-success-bg)",
    border: "var(--status-success-border)",
    text: "var(--status-success-text)",
  },
  ERROR: {
    label: "Errored",
    bg: "var(--status-error-bg)",
    border: "var(--status-error-border)",
    text: "var(--status-error-text)",
  },
};

const ORCHESTRATION_CONFIG: Record<OrchestrationStatus, { label: string; bg: string; border: string; text: string }> = {
  DRAFT: { label: "Draft", bg: "#f8fafc", border: "#cbd5e1", text: "#334155" },
  INTERVIEWING: { label: "Grill-me active", bg: "#e0f2fe", border: "#7dd3fc", text: "#075985" },
  PLAN_READY: { label: "Plan ready", bg: "#fef3c7", border: "#fcd34d", text: "#92400e" },
  RUNNING: { label: "Collab created", bg: "var(--actor-chatgpt-bg)", border: "var(--actor-chatgpt-border)", text: "var(--actor-chatgpt-text)" },
  DONE: { label: "Completed", bg: "var(--status-success-bg)", border: "var(--status-success-border)", text: "var(--status-success-text)" },
  ABORTED: { label: "Aborted", bg: "var(--status-error-bg)", border: "var(--status-error-border)", text: "var(--status-error-text)" },
};

const ACTOR_LABEL: Record<CollabActor, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  user: "User",
};

function waitingActorLabel(state: CollabState): string | null {
  if (state === "CREATIVE") return "ChatGPT's turn";
  if (state === "TECHNICAL") return "Claude's turn";
  if (state === "DONE") return "Completed";
  if (state === "ERROR") return "Errored";
  return null;
}

function latestOutput(task: CollabTask): TranscriptEntry | null {
  const transcript = Array.isArray(task.transcript) ? task.transcript : [];
  if (transcript.length === 0) return null;
  const modelEntry = [...transcript].reverse().find((entry) => entry.actor === "chatgpt" || entry.actor === "claude");
  return modelEntry ?? transcript[transcript.length - 1];
}

function latestPlannerText(session: OrchestrationSession): string | null {
  const transcript = Array.isArray(session.transcript) ? session.transcript : [];
  const latest = [...transcript].reverse().find((entry) => entry.role === "planner" || entry.role === "user");
  return latest?.content ?? session.plan?.summary ?? null;
}

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function CollabTasksPage() {
  const [filter, setFilter] = useState<CollabFilter>("active");
  const [tasks, setTasks] = useState<CollabTask[]>([]);
  const [orchestrationSessions, setOrchestrationSessions] = useState<OrchestrationSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchTasks = useCallback(async (mode: "initial" | "refresh") => {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);

    try {
      const res = await fetch(`/api/tasks?filter=${filter}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : "Failed to load tasks");
      }
      setTasks(Array.isArray(body?.tasks) ? body.tasks : []);
      setOrchestrationSessions(Array.isArray(body?.orchestrationSessions) ? body.orchestrationSessions : []);
    } catch {
      setTasks([]);
      setOrchestrationSessions([]);
    } finally {
      if (mode === "initial") setLoading(false);
      if (mode === "refresh") setRefreshing(false);
    }
  }, [filter]);

  useEffect(() => {
    void fetchTasks("initial");
  }, [fetchTasks]);

  const hasTasks = tasks.length > 0 || orchestrationSessions.length > 0;

  const stats = useMemo(() => {
    const activeCount = tasks.filter((task) => task.state === "CREATIVE" || task.state === "TECHNICAL").length;
    const activePlanningCount = orchestrationSessions.filter((session) =>
      session.status === "INTERVIEWING" || session.status === "PLAN_READY"
    ).length;
    const doneCount = tasks.filter((task) => task.state === "DONE").length;
    return { active: activeCount, planning: activePlanningCount, done: doneCount, total: tasks.length + orchestrationSessions.length };
  }, [tasks, orchestrationSessions]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Collab Tasks</h1>
          <p className={styles.subtle}>
            {stats.total} total · {stats.active} active · {stats.planning} planning · {stats.done} done
          </p>
        </div>
        <div className={styles.headerRight}>
          <button
            className={styles.actionBtn}
            onClick={() => void fetchTasks("refresh")}
            disabled={refreshing || loading}
          >
            <RefreshCw size={14} className={refreshing ? styles.spin : ""} />
            Refresh
          </button>
          <Link className={styles.primaryBtn} href="/dashboard/tasks/new">
            <Plus size={16} />
            New Task
          </Link>
        </div>
      </header>

      <div className={styles.filters}>
        {FILTERS.map((item) => {
          const isActive = item.id === filter;
          let count = 0;
          if (item.id === "all") count = stats.total;
          else if (item.id === "active") count = stats.active + stats.planning;
          else if (item.id === "waiting") count = tasks.filter((t) => t.state === "CREATIVE" || t.state === "TECHNICAL").length;
          else if (item.id === "done") count = stats.done;

          return (
            <button
              key={item.id}
              type="button"
              className={`${styles.filterChip} ${isActive ? styles.filterChipActive : ""}`}
              onClick={() => setFilter(item.id)}
            >
              <span>{item.label}</span>
              <span className={`${styles.filterCount} ${isActive ? styles.filterCountActive : ""}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className={styles.grid}>
          {[1, 2, 3, 4, 5, 6].map((idx) => (
            <div key={idx} className={styles.skeletonCard}>
              <div className={`${styles.skeleton} ${styles.skeletonShort}`} />
              <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
              <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
              <div className={styles.skeletonFooter}>
                <div className={`${styles.skeleton} ${styles.skeletonBadge}`} />
                <div className={`${styles.skeleton} ${styles.skeletonBadge}`} />
              </div>
            </div>
          ))}
        </div>
      ) : hasTasks ? (
        <div className={styles.grid}>
          {/* Orchestration session cards */}
          {orchestrationSessions.map((session) => {
            const latest = latestPlannerText(session);
            const config = ORCHESTRATION_CONFIG[session.status];
            const isPlanReady = session.status === "PLAN_READY";
            const ctaText = isPlanReady ? "Approve" : "Continue";
            // Fake progress for orchestration cards
            const progressPercent = isPlanReady ? 100 : 50;
            const currentTurn = isPlanReady ? 2 : 1;
            const totalTurns = 2;

            return (
              <Link
                key={session.id}
                href={session.collabTaskId ? `/dashboard/tasks/${session.collabTaskId}` : `/dashboard/tasks/plan/${session.id}`}
                className={styles.card}
              >
                <div className={styles.cardTop}>
                  <span
                    className={styles.statusBadge}
                    style={{
                      background: config.bg,
                      borderColor: config.border,
                      color: config.text,
                    }}
                  >
                    {config.label}
                  </span>
                </div>

                <h2 className={styles.cardTitle}>{session.plan?.title || session.goal}</h2>
                <p className={styles.cardMeta}>
                  Orchestrator · {relativeTime(session.updatedAt)}
                </p>

                <div className={styles.progressWrap}>
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressFill}
                      style={{
                        width: `${progressPercent}%`,
                        background: "#0ea5e9",
                      }}
                    />
                  </div>
                  <span className={styles.progressLabel}>Turn {currentTurn} of {totalTurns}</span>
                </div>

                {latest && (
                  <p className={styles.cardPreview}>{latest.slice(0, 180)}</p>
                )}

                <div className={styles.cardFooter}>
                  <div className={styles.actorBadges}>
                    <span className={`${styles.actorBadge} ${styles.actorChatgpt}`}>ChatGPT</span>
                    <span className={styles.swapArrow}>⇄</span>
                    <span className={`${styles.actorBadge} ${styles.actorClaude}`}>Claude</span>
                  </div>
                  <span className={styles.footerCta}>
                    {ctaText} <ArrowRight size={12} />
                  </span>
                </div>
              </Link>
            );
          })}

          {/* Collab task cards */}
          {tasks.map((task) => {
            const latest = latestOutput(task);
            const config = STATE_CONFIG[task.state];
            const progressPercent = Math.min(100, Math.round((task.iteration / Math.max(1, task.maxIterations)) * 100));

            return (
              <Link key={task.id} className={styles.card} href={`/dashboard/tasks/${task.id}`}>
                <div className={styles.cardTop}>
                  <span
                    className={styles.statusBadge}
                    style={{
                      background: config.bg,
                      borderColor: config.border,
                      color: config.text,
                    }}
                  >
                    {waitingActorLabel(task.state)}
                  </span>
                </div>

                <h2 className={styles.cardTitle}>{task.title}</h2>
                <p className={styles.cardMeta}>
                  {task.lastActor ? ACTOR_LABEL[task.lastActor] : "-"} · {relativeTime(task.updatedAt)}
                </p>

                <div className={styles.progressWrap}>
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressFill}
                      style={{
                        width: `${progressPercent}%`,
                        background: task.state === "DONE" ? "var(--status-success-text)" : task.state === "ERROR" ? "var(--status-error-text)" : "var(--actor-chatgpt)",
                      }}
                    />
                  </div>
                  <span className={styles.progressLabel}>Turn {task.iteration} of {task.maxIterations}</span>
                </div>

                {latest && (
                  <p className={styles.cardPreview}>{latest.content.slice(0, 140)}</p>
                )}

                <div className={styles.cardFooter}>
                  <div className={styles.actorBadges}>
                    <span className={`${styles.actorBadge} ${styles.actorChatgpt}`}>ChatGPT</span>
                    <span className={styles.swapArrow}>⇄</span>
                    <span className={`${styles.actorBadge} ${styles.actorClaude}`}>Claude</span>
                  </div>
                  <span className={styles.footerCta}>
                    Open <ArrowRight size={12} />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <EmptyCollectionState
          title="No collab tasks yet"
          description="Create a task to start ChatGPT ↔ Claude turn-taking with live transcript updates."
          actionLabel="Start your first collab"
          actionHref="/dashboard/tasks/new"
          illustration="default"
          actionIcon={
            <svg width="18" height="18" viewBox="0 0 15 15" fill="none" aria-hidden>
              <circle cx="4.2" cy="4.2" r="1.7" stroke="currentColor" strokeWidth="1.2" />
              <circle cx="10.8" cy="10.8" r="1.7" stroke="currentColor" strokeWidth="1.2" />
              <path d="M5.8 5.3 9.2 8.7M9.2 5.3 5.8 8.7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          }
        />
      )}
    </div>
  );
}
