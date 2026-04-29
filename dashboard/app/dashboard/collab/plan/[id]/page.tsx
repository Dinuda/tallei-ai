"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";

import styles from "./page.module.css";

type PlanningStatus = "DRAFT" | "INTERVIEWING" | "PLAN_READY" | "RUNNING" | "DONE" | "ABORTED";

type PlanningSession = {
  id: string;
  goal: string;
  status: PlanningStatus;
  plan: {
    title?: string;
    summary?: string;
    success_criteria?: Array<{ id: string; text: string; weight: number }>;
    first_actor?: "chatgpt" | "claude";
  } | null;
  collabTaskId: string | null;
  transcript?: Array<{
    role: "planner" | "user" | "system";
    content: string;
    ts: string;
    suggested_answers?: string[];
    default_answer?: string | null;
  }>;
};

function latestPlannerTurn(session: PlanningSession | null) {
  const transcript = Array.isArray(session?.transcript) ? session.transcript : [];
  return [...transcript].reverse().find((entry) => entry.role === "planner") ?? null;
}

export default function CollabPlanPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sessionId = params.id;
  const [session, setSession] = useState<PlanningSession | null>(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    setLoading(true);
    setErrorText(null);
    try {
      const res = await fetch(`/api/tasks/orchestrations/${sessionId}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : "Failed to load planning task");
      setSession(body);
      if (typeof body?.collabTaskId === "string" && body.collabTaskId) {
        router.replace(`/dashboard/tasks/${body.collabTaskId}`);
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to load planning task.");
    } finally {
      setLoading(false);
    }
  }, [router, sessionId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const plannerTurn = useMemo(() => latestPlannerTurn(session), [session]);
  const isPlanReady = session?.status === "PLAN_READY";

  const submitAnswer = async (value?: string) => {
    const nextAnswer = (value ?? answer).trim();
    if (!nextAnswer || busy) return;
    setBusy(true);
    setErrorText(null);
    try {
      const res = await fetch(`/api/tasks/planning/${sessionId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: nextAnswer }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : "Failed to submit answer");
      await loadSession();
      setAnswer("");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to submit answer.");
    } finally {
      setBusy(false);
    }
  };

  const approvePlan = async () => {
    if (busy) return;
    setBusy(true);
    setErrorText(null);
    try {
      const res = await fetch(`/api/tasks/planning/${sessionId}/approve`, { method: "POST" });
      const body = await res.json();
      const taskId = typeof body?.task?.id === "string" ? body.task.id : null;
      if (!res.ok || !taskId) throw new Error(typeof body?.error === "string" ? body.error : "Failed to approve plan");
      router.push(`/dashboard/tasks/${taskId}`);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : "Failed to approve plan.");
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p className={styles.loadingText}>Loading planning task...</p>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <Link href="/dashboard/tasks" className={styles.secondaryBtn}>
        <ArrowLeft size={14} />
        Tasks
      </Link>

      <section className={styles.card}>
        <div className={styles.iconWrap}>
          {isPlanReady ? <Check size={24} /> : <Loader2 size={24} />}
        </div>
        <h1 className={styles.title}>{isPlanReady ? "Plan ready" : "Grill-me planning"}</h1>
        <p className={styles.text}>{session?.plan?.title || session?.goal}</p>

        {errorText && <p className={styles.errorText}>{errorText}</p>}

        {isPlanReady ? (
          <>
            <div className={styles.planBox}>
              <p className={styles.planSummary}>{session?.plan?.summary}</p>
              {(session?.plan?.success_criteria ?? []).map((criterion) => (
                <div key={criterion.id} className={styles.criterion}>{criterion.text}</div>
              ))}
            </div>
            <button type="button" className={styles.primaryBtn} onClick={() => void approvePlan()} disabled={busy}>
              {busy ? <Loader2 size={14} className={styles.inlineSpin} /> : <Check size={14} />}
              Approve and start task
            </button>
          </>
        ) : (
          <>
            <p className={styles.question}>{plannerTurn?.content ?? "Answer the next planning question."}</p>
            {plannerTurn?.suggested_answers?.length ? (
              <div className={styles.suggestions}>
                {plannerTurn.suggested_answers.map((item) => (
                  <button key={item} type="button" className={styles.suggestionBtn} onClick={() => void submitAnswer(item)} disabled={busy}>
                    {item}
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              className={styles.answerBox}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder={plannerTurn?.default_answer ?? "Type your answer..."}
            />
            <button type="button" className={styles.primaryBtn} onClick={() => void submitAnswer()} disabled={busy || !answer.trim()}>
              {busy ? <Loader2 size={14} className={styles.inlineSpin} /> : <ArrowRight size={14} />}
              Submit answer
            </button>
          </>
        )}
      </section>
    </main>
  );
}
