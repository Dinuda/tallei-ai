"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "./page.module.css";

type OrchestrationStatus = "DRAFT" | "INTERVIEWING" | "PLAN_READY" | "RUNNING" | "DONE" | "ABORTED";

type OrchestrationSession = {
  id: string;
  goal: string;
  status: OrchestrationStatus;
  collabTaskId: string | null;
  updatedAt: string;
  plan: { title: string; summary: string } | null;
};

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.floor(delta / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function OrchestratePage() {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState<OrchestrationSession[]>([]);
  const [recent, setRecent] = useState<OrchestrationSession[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const [activeRes, doneRes] = await Promise.all([
        fetch("/api/orchestrate/sessions?filter=active", { cache: "no-store" }),
        fetch("/api/orchestrate/sessions?filter=done", { cache: "no-store" }),
      ]);
      const activeBody = await activeRes.json();
      const doneBody = await doneRes.json();
      setActive(Array.isArray(activeBody?.sessions) ? activeBody.sessions : []);
      setRecent(Array.isArray(doneBody?.sessions) ? doneBody.sessions : []);
    } catch {
      setActive([]);
      setRecent([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const createSession = useCallback(async () => {
    const trimmed = goal.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/orchestrate/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: trimmed, source_platform: "dashboard" }),
      });
      const body = await res.json();
      if (!res.ok || typeof body?.session?.id !== "string") {
        throw new Error("Failed to create session");
      }
      router.push(`/dashboard/orchestrate/${body.session.id}`);
    } catch {
      setCreating(false);
    }
  }, [goal, creating, router]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Orchestrate</h1>
        <p className={styles.subtle}>Plan first, then run collab with explicit success criteria.</p>
      </header>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>New Goal</h2>
        <textarea
          className={styles.input}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="Ship a reliable /healthz endpoint with auth and tests"
        />
        <button type="button" className={styles.primaryBtn} onClick={() => void createSession()} disabled={creating || goal.trim().length === 0}>
          {creating ? "Creating..." : "Start Planning"}
        </button>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Active Sessions</h2>
        {loading ? (
          <p className={styles.subtle}>Loading...</p>
        ) : active.length === 0 ? (
          <p className={styles.subtle}>No active sessions.</p>
        ) : (
          <div className={styles.list}>
            {active.map((session) => (
              <Link key={session.id} href={`/dashboard/orchestrate/${session.id}`} className={styles.item}>
                <p className={styles.itemTitle}>{session.plan?.title ?? session.goal}</p>
                <p className={styles.itemMeta}>{session.status} · updated {relativeTime(session.updatedAt)}</p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Recent Completed</h2>
        {loading ? (
          <p className={styles.subtle}>Loading...</p>
        ) : recent.length === 0 ? (
          <p className={styles.subtle}>No completed sessions.</p>
        ) : (
          <div className={styles.list}>
            {recent.map((session) => (
              <Link key={session.id} href={`/dashboard/orchestrate/${session.id}`} className={styles.item}>
                <p className={styles.itemTitle}>{session.plan?.title ?? session.goal}</p>
                <p className={styles.itemMeta}>
                  {session.status} · {session.collabTaskId ? "linked" : "no task"} · {relativeTime(session.updatedAt)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
