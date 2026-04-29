"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import styles from "./page.module.css";

type OrchestrationStatus = "DRAFT" | "INTERVIEWING" | "PLAN_READY" | "RUNNING" | "DONE" | "ABORTED";

type TranscriptEntry = {
  role: "planner" | "user" | "system";
  content: string;
  ts: string;
  suggested_answers?: string[];
  default_answer?: string | null;
};

type PlanCriterion = {
  id: string;
  text: string;
  weight: number;
};

type OrchestrationPlan = {
  title?: string;
  summary?: string;
  first_actor?: "chatgpt" | "claude";
  max_iterations?: number;
  success_criteria?: PlanCriterion[];
  open_questions?: string[];
};

type OrchestrationSession = {
  id: string;
  goal: string;
  status: OrchestrationStatus;
  transcript: TranscriptEntry[];
  plan: OrchestrationPlan | null;
  collabTaskId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

const STATUS_LABEL: Record<OrchestrationStatus, string> = {
  DRAFT: "Draft",
  INTERVIEWING: "Grill-me active",
  PLAN_READY: "Plan ready",
  RUNNING: "Collab created",
  DONE: "Done",
  ABORTED: "Aborted",
};

function latestPlannerQuestion(session: OrchestrationSession): TranscriptEntry | null {
  return [...session.transcript].reverse().find((entry) => entry.role === "planner") ?? null;
}

function statusClass(status: OrchestrationStatus): string {
  return `${styles.status} ${styles[`status_${status}`] ?? ""}`;
}

export default function OrchestrateSessionPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ?? "";

  const [session, setSession] = useState<OrchestrationSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function loadSession() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/collab/orchestrations/${id}`, { cache: "no-store" });
        const body = await res.json();
        if (!res.ok || typeof body?.id !== "string") {
          throw new Error(typeof body?.error === "string" ? body.error : "Session not found");
        }

        if (body.collabTaskId && (body.status === "RUNNING" || body.status === "DONE")) {
          router.replace(`/dashboard/collab/${body.collabTaskId}`);
          return;
        }

        if (!cancelled) {
          setSession(body as OrchestrationSession);
        }
      } catch (err) {
        if (!cancelled) {
          setSession(null);
          setError(err instanceof Error ? err.message : "Failed to load orchestration session");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadSession();
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  const question = useMemo(() => (session ? latestPlannerQuestion(session) : null), [session]);

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loader}>Loading orchestration session...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={styles.page}>
        <div className={styles.sessionCard}>
          <p className={styles.errorText}>{error ?? "Orchestration session not found."}</p>
          <Link className={styles.secondaryBtn} href="/dashboard/collab">
            Back to Collab Tasks
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <Link className={styles.backLink} href="/dashboard/collab">
          Back to Collab Tasks
        </Link>
        <span className={statusClass(session.status)}>{STATUS_LABEL[session.status]}</span>
      </div>

      <section className={styles.sessionCard}>
        <p className={styles.subtle}>Orchestration session</p>
        <h1 className={styles.title}>{session.plan?.title || session.goal}</h1>
        <p className={styles.summary}>{session.goal}</p>
      </section>

      {question && (
        <section className={styles.chatShell}>
          <div className={styles.chatHeader}>
            <div>
              <p className={styles.subtle}>Current grill-me prompt</p>
              <h2 className={styles.sectionTitle}>Answer this in ChatGPT or Claude</h2>
            </div>
          </div>
          <div className={styles.chatList}>
            <article className={`${styles.message} ${styles.assistantMessage}`}>
              <p className={styles.turnMeta}>Planner</p>
              <p className={styles.turnBody}>{question.content}</p>
              {Array.isArray(question.suggested_answers) && question.suggested_answers.length > 0 && (
                <div className={styles.toolBlock}>
                  <p className={styles.toolLabel}>Suggested answers</p>
                  <div className={styles.quickOptions}>
                    {question.suggested_answers.map((answer) => (
                      <span key={answer} className={styles.quickOptionBtn}>
                        {answer}
                      </span>
                    ))}
                  </div>
                  {question.default_answer && (
                    <p className={styles.toolMeta}>Default: {question.default_answer}</p>
                  )}
                </div>
              )}
            </article>
          </div>
          <div className={styles.composer}>
            <p className={styles.composerTitle}>Next step</p>
            <p className={styles.subtle}>
              Continue this setup in the provider chat. When the plan is ready, approve it there to create the actual collab task.
            </p>
          </div>
        </section>
      )}

      {session.plan && (
        <section className={styles.planCard}>
          <h2 className={styles.sectionTitle}>Plan</h2>
          {session.plan.summary && <p className={styles.summary}>{session.plan.summary}</p>}
          <div className={styles.chips}>
            {session.plan.first_actor && <span className={styles.chipSuccess}>First actor: {session.plan.first_actor}</span>}
            {session.plan.max_iterations && <span className={styles.chipSuccess}>{session.plan.max_iterations} iterations</span>}
          </div>
          {Array.isArray(session.plan.success_criteria) && session.plan.success_criteria.length > 0 && (
            <div className={styles.criteriaList}>
              {session.plan.success_criteria.map((criterion) => (
                <div key={criterion.id} className={styles.criteriaRow}>
                  <p className={styles.criteriaText}>{criterion.text}</p>
                  <span className={styles.criteriaMeta}>Weight {criterion.weight}</span>
                </div>
              ))}
            </div>
          )}
          {Array.isArray(session.plan.open_questions) && session.plan.open_questions.length > 0 && (
            <div className={styles.toolBlock}>
              <p className={styles.toolLabel}>Open questions</p>
              {session.plan.open_questions.map((item) => (
                <p key={item} className={styles.toolMeta}>{item}</p>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
