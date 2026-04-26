"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { EmptyCollectionState } from "../components/empty-collection-state";
import styles from "./page.module.css";

type CollabState = "CREATIVE" | "TECHNICAL" | "DONE" | "ERROR";
type CollabActor = "chatgpt" | "claude" | "user";
type CollabFilter = "all" | "active" | "waiting" | "done";

type CollabTask = {
  id: string;
  title: string;
  brief: string | null;
  state: CollabState;
  lastActor: CollabActor | null;
  iteration: number;
  maxIterations: number;
  updatedAt: string;
};

const FILTERS: Array<{ id: CollabFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "waiting", label: "Waiting on me" },
  { id: "done", label: "Done" },
];

const STATE_COLOR: Record<CollabState, string> = {
  CREATIVE: "#10a37f",
  TECHNICAL: "#D97757",
  DONE: "var(--text-muted)",
  ERROR: "var(--destructive)",
};

const ACTOR_LABEL: Record<CollabActor, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  user: "User",
};

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

  const title = useMemo(() => {
    const activeCount = tasks.filter((task) => task.state === "CREATIVE" || task.state === "TECHNICAL").length;
    return `${activeCount} active`;
  }, [tasks]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Collab Tasks</h1>
          <p className={styles.subtle}>{title}</p>
        </div>
        <div className={styles.headerRight}>
          <button className={styles.actionBtn} onClick={() => void fetchTasks("refresh")} disabled={refreshing || loading}>
            <RefreshCw size={15} className={refreshing ? styles.spin : ""} />
            Refresh
          </button>
          <Link className={styles.primaryBtn} href="/dashboard/collab/new">
            <Plus size={16} />
            New Task
          </Link>
        </div>
      </header>

      <div className={styles.filters}>
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`${styles.filterChip} ${item.id === filter ? styles.filterChipActive : ""}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className={styles.grid}>
          {[1, 2, 3, 4, 5].map((idx) => (
            <div key={idx} className={styles.skeletonCard}>
              <div className={`${styles.skeleton} ${styles.skeletonShort}`} />
              <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
              <div className={`${styles.skeleton} ${styles.skeletonLine}`} />
            </div>
          ))}
        </div>
      ) : hasTasks ? (
        <div className={styles.grid}>
          {tasks.map((task) => (
            <Link key={task.id} className={styles.card} href={`/dashboard/collab/${task.id}`}>
              <div className={styles.cardTop}>
                <span className={styles.stateRow}>
                  <span className={styles.stateDot} style={{ backgroundColor: STATE_COLOR[task.state] }} />
                  {task.state}
                </span>
                <span className={styles.iteration}>iter {task.iteration}/{task.maxIterations}</span>
              </div>

              <h2 className={styles.cardTitle}>{task.title}</h2>
              <p className={styles.cardMeta}>
                Last update: {task.lastActor ? ACTOR_LABEL[task.lastActor] : "-"} · {relativeTime(task.updatedAt)}
              </p>

              <div className={styles.cardBadges}>
                <span className={`${styles.platformBadge} ${styles.platformChatgpt}`}>chatgpt</span>
                <span className={styles.swapArrow}>⇄</span>
                <span className={`${styles.platformBadge} ${styles.platformClaude}`}>claude</span>
                <span className={styles.openCta}>Open →</span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyCollectionState
          title="No collab tasks yet"
          description="Create a task to start ChatGPT ↔ Claude turn-taking with live transcript updates."
          actionLabel="Start your first collab"
          actionHref="/dashboard/collab/new"
          imageSrc="/tallei-home.png"
        />
      )}
    </div>
  );
}
