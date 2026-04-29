"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, FileText, ArrowRight } from "lucide-react";

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

function documentCount(task: CollabTask): number {
  const context = task.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) return 0;
  const docsContainer = context.documents;
  if (!docsContainer || typeof docsContainer !== "object" || Array.isArray(docsContainer)) return 0;
  const docs = (docsContainer as { documents?: unknown }).documents;
  return Array.isArray(docs) ? docs.length : 0;
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchTasks = useCallback(async (mode: "initial" | "refresh") => {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);

    try {
      const res = await fetch(`/api/collab/tasks?filter=${filter}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : "Failed to load tasks");
      }
      setTasks(Array.isArray(body?.tasks) ? body.tasks : []);
    } catch {
      setTasks([]);
    } finally {
      if (mode === "initial") setLoading(false);
      if (mode === "refresh") setRefreshing(false);
    }
  }, [filter]);

  useEffect(() => {
    void fetchTasks("initial");
  }, [fetchTasks]);

  const hasTasks = tasks.length > 0;

  const stats = useMemo(() => {
    const activeCount = tasks.filter((task) => task.state === "CREATIVE" || task.state === "TECHNICAL").length;
    const doneCount = tasks.filter((task) => task.state === "DONE").length;
    return { active: activeCount, done: doneCount, total: tasks.length };
  }, [tasks]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Collab Tasks</h1>
          <p className={styles.subtle}>
            {stats.total} total · {stats.active} active · {stats.done} done
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
          <Link className={styles.primaryBtn} href="/dashboard/collab/new">
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
          else if (item.id === "active") count = stats.active;
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
          {tasks.map((task) => {
            const latest = latestOutput(task);
            const docs = documentCount(task);
            const config = STATE_CONFIG[task.state];
            const progressPercent = Math.min(100, Math.round((task.iteration / Math.max(1, task.maxIterations)) * 100));

            return (
              <Link key={task.id} className={styles.card} href={`/dashboard/collab/${task.id}`}>
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
                  {docs > 0 && (
                    <span className={styles.docBadge}>
                      <FileText size={11} />
                      {docs}
                    </span>
                  )}
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
                  <p className={styles.outputPreview}>
                    {latest.content.slice(0, 140)}
                  </p>
                )}

                <div className={styles.cardFooter}>
                  <div className={styles.actorBadges}>
                    <span className={`${styles.actorBadge} ${styles.actorChatgpt}`}>ChatGPT</span>
                    <span className={styles.swapArrow}>⇄</span>
                    <span className={`${styles.actorBadge} ${styles.actorClaude}`}>Claude</span>
                  </div>
                  <span className={styles.openCta}>
                    Open
                    <ArrowRight size={12} />
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
          actionHref="/dashboard/collab/new"
          imageSrc="/tallei-home.png"
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
