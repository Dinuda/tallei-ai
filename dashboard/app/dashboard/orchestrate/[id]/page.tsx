"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import styles from "./page.module.css";

type OrchestrationStatus = "DRAFT" | "INTERVIEWING" | "PLAN_READY" | "RUNNING" | "DONE" | "ABORTED";

type PlannerTurn = {
  role: "planner" | "user" | "system";
  content: string;
  ts: string;
  web_searches?: Array<{ query: string; url: string; snippet: string }>;
};

type OrchestrationPlan = {
  title: string;
  summary: string;
  phases: Array<{ id: string; name: string; outputs: string[] }>;
  success_criteria: Array<{ id: string; text: string; weight: number }>;
  open_questions: string[];
};

type OrchestrationSession = {
  id: string;
  goal: string;
  status: OrchestrationStatus;
  transcript: PlannerTurn[];
  plan: OrchestrationPlan | null;
  collabTaskId: string | null;
  updatedAt: string;
  errorMessage: string | null;
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

export default function OrchestrationSessionPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [session, setSession] = useState<OrchestrationSession | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  const sessionId = params?.id ?? "";

  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    const res = await fetch(`/api/orchestrate/sessions/${sessionId}`, { cache: "no-store" });
    const body = await res.json();
    if (!res.ok || !body?.session) {
      setSession(null);
      return;
    }
    setSession(body.session as OrchestrationSession);
  }, [sessionId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => {
      void loadSession();
    }, 2_000);
    return () => clearInterval(timer);
  }, [sessionId, loadSession]);

  const latestQuestion = useMemo(() => {
    if (!session) return null;
    return [...session.transcript].reverse().find((entry) => entry.role === "planner") ?? null;
  }, [session]);

  const submitAnswer = useCallback(async () => {
    const trimmed = answer.trim();
    if (!session || !trimmed || busy || session.status !== "INTERVIEWING") return;
    setBusy(true);
    try {
      await fetch(`/api/orchestrate/sessions/${session.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: trimmed }),
      });
      setAnswer("");
      await loadSession();
    } finally {
      setBusy(false);
    }
  }, [session, answer, busy, loadSession]);

  const approvePlan = useCallback(async () => {
    if (!session || session.status !== "PLAN_READY" || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orchestrate/sessions/${session.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      await loadSession();
      if (typeof body?.task_id === "string") {
        router.push(`/dashboard/collab/${body.task_id}`);
      }
    } finally {
      setBusy(false);
    }
  }, [session, busy, loadSession, router]);

  if (!session) {
    return (
      <div className={styles.page}>
        <p className={styles.subtle}>Session not found.</p>
        <Link href="/dashboard/orchestrate" className={styles.secondaryBtn}>Back</Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <Link href="/dashboard/orchestrate" className={styles.backLink}>← Orchestrate</Link>
        <span className={`${styles.status} ${styles[`status_${session.status}`] ?? ""}`}>{session.status}</span>
      </div>

      <section className={styles.card}>
        <h1 className={styles.title}>{session.plan?.title ?? session.goal}</h1>
        <p className={styles.subtle}>Updated {relativeTime(session.updatedAt)}</p>
        {session.plan?.summary ? <p className={styles.summary}>{session.plan.summary}</p> : null}
        {session.collabTaskId ? (
          <Link href={`/dashboard/collab/${session.collabTaskId}`} className={styles.primaryBtn}>Open Linked Collab Task</Link>
        ) : null}
      </section>

      {session.status === "INTERVIEWING" && latestQuestion && (
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>Current Question</h2>
          <p className={styles.question}>{latestQuestion.content}</p>
          <textarea
            className={styles.input}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Type your answer"
          />
          <div className={styles.actions}>
            <button type="button" className={styles.primaryBtn} onClick={() => void submitAnswer()} disabled={busy || answer.trim().length === 0}>
              {busy ? "Submitting..." : "Submit Answer"}
            </button>
            <a href="https://chatgpt.com" target="_blank" rel="noreferrer" className={styles.secondaryBtn}>Continue in ChatGPT</a>
            <a href="https://claude.ai" target="_blank" rel="noreferrer" className={styles.secondaryBtn}>Continue in Claude</a>
          </div>
        </section>
      )}

      {session.status === "PLAN_READY" && session.plan && (
        <section className={styles.card}>
          <h2 className={styles.sectionTitle}>Plan Ready</h2>
          <div className={styles.criteriaList}>
            {session.plan.success_criteria.map((criterion) => (
              <div key={criterion.id} className={styles.criteriaRow}>
                <p className={styles.criteriaText}>{criterion.text}</p>
                <span className={styles.criteriaMeta}>{criterion.id} · weight {criterion.weight}</span>
              </div>
            ))}
          </div>
          {session.plan.open_questions.length > 0 ? (
            <p className={styles.subtle}>Open questions: {session.plan.open_questions.join(" | ")}</p>
          ) : null}
          <button type="button" className={styles.primaryBtn} disabled={busy} onClick={() => void approvePlan()}>
            {busy ? "Approving..." : "Approve Plan"}
          </button>
        </section>
      )}

      <section className={styles.card}>
        <h2 className={styles.sectionTitle}>Transcript</h2>
        <div className={styles.transcriptList}>
          {session.transcript.map((entry, index) => (
            <article key={`${entry.ts}:${index}`} className={styles.turn}>
              <p className={styles.turnMeta}>{entry.role} · {relativeTime(entry.ts)}</p>
              <p className={styles.turnBody}>{entry.content}</p>
              {entry.web_searches && entry.web_searches.length > 0 && (
                <div className={styles.researchList}>
                  {entry.web_searches.map((result, idx) => (
                    <a key={`${result.url}:${idx}`} href={result.url} target="_blank" rel="noreferrer" className={styles.researchItem}>
                      <span>{result.query}</span>
                      <small>{result.snippet}</small>
                    </a>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      {session.errorMessage ? <p className={styles.errorText}>{session.errorMessage}</p> : null}
    </div>
  );
}
