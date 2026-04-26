"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useParams, useRouter } from "next/navigation";

import { NudgeModal } from "./NudgeModal";
import styles from "./page.module.css";

type CollabState = "CREATIVE" | "TECHNICAL" | "DONE" | "ERROR";
type CollabActor = "chatgpt" | "claude" | "user";

type TranscriptEntry = {
  actor: CollabActor;
  iteration: number;
  content: string;
  ts: string;
};

type PollReason = "timeout" | "network" | "background" | "too_many_failures" | null;

type CollabTask = {
  id: string;
  title: string;
  brief: string | null;
  state: CollabState;
  lastActor: CollabActor | null;
  iteration: number;
  maxIterations: number;
  transcript: TranscriptEntry[];
  context: Record<string, unknown>;
  errorMessage: string | null;
  updatedAt: string;
};

type PlanCriterion = {
  id: string;
  text: string;
  weight: number;
};

type EvaluationCriterion = {
  criterion_id: string;
  status: "pass" | "fail" | "partial";
  rationale: string;
};

type EvaluationEntry = {
  iteration: number;
  actor: "chatgpt" | "claude";
  ts: string;
  criterion_evaluations: EvaluationCriterion[];
  should_mark_done: boolean;
  remaining_work: string;
};

const POLL_CONFIG = {
  successIntervalMs: 2_000,
  hiddenIntervalMs: 30_000,
  requestTimeoutMs: 10_000,
  maxErrorBackoffMs: 15_000,
  maxActiveWindowMs: 10 * 60_000,
  maxConsecutiveFailures: 6,
} as const;

const PLATFORM_COLOR: Record<CollabActor, string> = {
  chatgpt: "#10a37f",
  claude: "#D97757",
  user: "#6b7280",
};

const ACTOR_LABEL: Record<CollabActor, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  user: "User",
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("network") || msg.includes("failed to fetch") || msg.includes("timed out");
}

function getErrorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function nextErrorDelayMs(failures: number): number {
  const exp = Math.max(0, failures - 1);
  const delay = POLL_CONFIG.successIntervalMs * Math.pow(2, exp);
  return Math.min(POLL_CONFIG.maxErrorBackoffMs, delay);
}

function describePollReason(reason: PollReason, failures: number): string {
  if (reason === "timeout") return "Live updates paused after 10 minutes. Click retry to continue.";
  if (reason === "network") return "Live updates paused while offline. Reconnect and retry.";
  if (reason === "background") return "Live updates are reduced while this tab is in the background.";
  if (reason === "too_many_failures") return `Live updates paused after repeated failures (${failures}).`;
  return "";
}

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.floor(delta / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function waitingActorForState(state: CollabState): "chatgpt" | "claude" | null {
  if (state === "CREATIVE") return "chatgpt";
  if (state === "TECHNICAL") return "claude";
  return null;
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readPlanCriteria(context: Record<string, unknown>): PlanCriterion[] {
  const artifacts = readObject(context["artifacts"]);
  const plan = readObject(artifacts["plan"]);
  const source = Array.isArray(artifacts["success_criteria"])
    ? artifacts["success_criteria"]
    : Array.isArray(plan["success_criteria"])
      ? plan["success_criteria"]
      : [];

  return source
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      id: typeof item["id"] === "string" ? item["id"] : "",
      text: typeof item["text"] === "string" ? item["text"] : "",
      weight: typeof item["weight"] === "number" ? Math.max(1, Math.min(3, Math.trunc(item["weight"]))) : 1,
    }))
    .filter((item) => item.id && item.text);
}

function readPlanSummary(context: Record<string, unknown>): string | null {
  const artifacts = readObject(context["artifacts"]);
  const plan = readObject(artifacts["plan"]);
  const summary = plan["summary"];
  return typeof summary === "string" && summary.trim() ? summary.trim() : null;
}

function readEvaluations(context: Record<string, unknown>): EvaluationEntry[] {
  const artifacts = readObject(context["artifacts"]);
  const evaluationsRaw = artifacts["evaluations"];
  if (!Array.isArray(evaluationsRaw)) return [];
  return evaluationsRaw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const criteriaRaw = Array.isArray(item["criterion_evaluations"]) ? item["criterion_evaluations"] : [];
      const criteria = criteriaRaw
        .filter((criterion): criterion is Record<string, unknown> => Boolean(criterion && typeof criterion === "object" && !Array.isArray(criterion)))
        .map((criterion) => {
          const status = criterion["status"];
          if (status !== "pass" && status !== "fail" && status !== "partial") return null;
          return {
            criterion_id: typeof criterion["criterion_id"] === "string" ? criterion["criterion_id"] : "",
            status,
            rationale: typeof criterion["rationale"] === "string" ? criterion["rationale"] : "",
          };
        })
        .filter((criterion): criterion is EvaluationCriterion => Boolean(criterion && criterion.criterion_id));
      const actor = item["actor"];
      return {
        iteration: typeof item["iteration"] === "number" ? item["iteration"] : 0,
        actor: (actor === "claude" ? "claude" : "chatgpt") as "claude" | "chatgpt",
        ts: typeof item["ts"] === "string" ? item["ts"] : "",
        criterion_evaluations: criteria,
        should_mark_done: item["should_mark_done"] === true,
        remaining_work: typeof item["remaining_work"] === "string" ? item["remaining_work"] : "",
      };
    })
    .filter((entry) => entry.ts);
}

function toMarkdown(task: CollabTask): string {
  const lines: string[] = [`# ${task.title}`, "", `State: ${task.state}`, `Iteration: ${task.iteration}/${task.maxIterations}`, "", "## Transcript", ""];
  for (const entry of task.transcript) {
    lines.push(`### ${ACTOR_LABEL[entry.actor]} · iter ${entry.iteration} · ${entry.ts}`);
    lines.push("");
    lines.push(entry.content);
    lines.push("");
  }
  return lines.join("\n");
}

function SlidingTranscriptCard({
  entry,
  isNew,
}: {
  entry: TranscriptEntry;
  isNew: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className={`${styles.transcriptCard} ${isNew ? styles.newEntry : ""}`} style={{ borderLeftColor: PLATFORM_COLOR[entry.actor] }}>
      <header className={styles.transcriptHeader}>
        <span className={styles.actorBadge} style={{ backgroundColor: PLATFORM_COLOR[entry.actor] }}>
          {ACTOR_LABEL[entry.actor]}
        </span>
        <span className={styles.metaText}>iter {entry.iteration}</span>
        <span className={styles.metaText}>{relativeTime(entry.ts)}</span>
      </header>
      <p className={`${styles.transcriptBody} ${expanded ? styles.expanded : ""}`}>{entry.content}</p>
      {entry.content.length > 240 && (
        <button type="button" className={styles.showMore} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </article>
  );
}

export default function CollabBoardPage() {
  const router = useRouter();
  const routeParams = useParams<{ id: string }>();
  const [taskId, setTaskId] = useState<string>("");
  const [task, setTask] = useState<CollabTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [latestEntryKey, setLatestEntryKey] = useState<string | null>(null);
  const [latestExpanded, setLatestExpanded] = useState(false);
  const [copiedLatest, setCopiedLatest] = useState(false);
  const [pollReason, setPollReason] = useState<PollReason>(null);
  const [pollPaused, setPollPaused] = useState(false);
  const [pollFailures, setPollFailures] = useState(0);
  const [isDocumentHidden, setIsDocumentHidden] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollInFlightRef = useRef(false);
  const activePollingStartedAtRef = useRef<number | null>(null);
  const failureCountRef = useRef(0);
  const pollPausedRef = useRef(false);
  const pollReasonRef = useRef<PollReason>(null);

  useEffect(() => {
    if (routeParams?.id) {
      setTaskId(routeParams.id);
    }
  }, [routeParams]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsOnline(navigator.onLine);
    setIsDocumentHidden(document.hidden);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onVisibilityChange = () => {
      const hidden = document.hidden;
      setIsDocumentHidden(hidden);
      if (hidden) {
        setPollReason((prev) => (prev ?? "background"));
      } else {
        setPollReason((prev) => (prev === "background" ? null : prev));
      }
    };

    const onOnline = () => {
      setIsOnline(true);
    };

    const onOffline = () => {
      setIsOnline(false);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    pollPausedRef.current = pollPaused;
  }, [pollPaused]);

  useEffect(() => {
    pollReasonRef.current = pollReason;
  }, [pollReason]);

  const clearPollTimer = useCallback(() => {
    if (!pollTimerRef.current) return;
    clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const pausePolling = useCallback((reason: Exclude<PollReason, null>) => {
    clearPollTimer();
    setPollPaused(true);
    setPollReason(reason);
    pollPausedRef.current = true;
    pollReasonRef.current = reason;
    if (process.env.NODE_ENV !== "production") {
      console.debug("[collab-poll] paused", {
        reason,
        failures: failureCountRef.current,
      });
    }
  }, [clearPollTimer]);

  const resetPollingState = useCallback((reason: PollReason = null) => {
    failureCountRef.current = 0;
    activePollingStartedAtRef.current = Date.now();
    setPollFailures(0);
    setPollPaused(false);
    setPollReason(reason);
    pollPausedRef.current = false;
    pollReasonRef.current = reason;
    if (process.env.NODE_ENV !== "production") {
      console.debug("[collab-poll] resumed", { reason });
    }
  }, []);

  const fetchTask = useCallback(async () => {
    if (!taskId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POLL_CONFIG.requestTimeoutMs);
    try {
      const res = await fetch(`/api/collab/tasks/${taskId}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await res.json();
      if (!res.ok) {
        const message = typeof body?.error === "string" ? body.error : "Failed to load task";
        const error = new Error(message) as Error & { status?: number };
        error.status = res.status;
        throw error;
      }
      const nextTask = body as CollabTask;
      setTask((currentTask) => {
        const currentLast = currentTask?.transcript[currentTask.transcript.length - 1];
        const nextLast = nextTask.transcript[nextTask.transcript.length - 1];
        if (nextLast && (!currentLast || currentLast.ts !== nextLast.ts || currentLast.content !== nextLast.content)) {
          setLatestEntryKey(`${nextLast.ts}:${nextLast.iteration}:${nextLast.actor}`);
        }
        return nextTask;
      });
      return nextTask;
    } finally {
      clearTimeout(timeout);
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId || pollPaused) return;

    let cancelled = false;

    const scheduleNext = (delayMs: number) => {
      clearPollTimer();
      pollTimerRef.current = setTimeout(() => {
        void runCycle();
      }, delayMs);
    };

    const runCycle = async () => {
      if (cancelled || pollPausedRef.current || pollInFlightRef.current) return;
      if (task?.state === "DONE" || task?.state === "ERROR") return;

      if (!isOnline) {
        pausePolling("network");
        return;
      }

      const startedAt = activePollingStartedAtRef.current ?? Date.now();
      activePollingStartedAtRef.current = startedAt;

      if (Date.now() - startedAt >= POLL_CONFIG.maxActiveWindowMs) {
        pausePolling("timeout");
        return;
      }

      pollInFlightRef.current = true;
      try {
        await fetchTask();
        failureCountRef.current = 0;
        setPollFailures(0);
        setPollReason((prev) => {
          if (isDocumentHidden) return "background";
          if (prev === "background") return null;
          return prev;
        });
        setLoading(false);

        const nextDelay = isDocumentHidden
          ? POLL_CONFIG.hiddenIntervalMs
          : POLL_CONFIG.successIntervalMs;
        scheduleNext(nextDelay);
      } catch (error) {
        const status = getErrorStatusCode(error);
        if (status === 404) {
          setTask(null);
          setLoading(false);
          pausePolling("timeout");
          return;
        }

        if (isAbortError(error) || !isOnline || isLikelyNetworkError(error)) {
          setLoading(false);
          pausePolling("network");
          return;
        }

        failureCountRef.current += 1;
        setPollFailures(failureCountRef.current);
        setLoading(false);

        if (failureCountRef.current >= POLL_CONFIG.maxConsecutiveFailures) {
          pausePolling("too_many_failures");
          return;
        }

        const backoff = nextErrorDelayMs(failureCountRef.current);
        scheduleNext(backoff);
      } finally {
        pollInFlightRef.current = false;
      }
    };

    void runCycle();

    return () => {
      cancelled = true;
      clearPollTimer();
    };
  }, [taskId, pollPaused, task?.state, isOnline, isDocumentHidden, fetchTask, pausePolling, clearPollTimer]);

  useEffect(() => {
    if (task?.state === "DONE" || task?.state === "ERROR") {
      clearPollTimer();
      setPollPaused(true);
    }
  }, [task?.state, clearPollTimer]);

  useEffect(() => {
    if (!isOnline) {
      pausePolling("network");
      return;
    }
    if (pollPausedRef.current && pollReasonRef.current === "network") {
      resetPollingState(isDocumentHidden ? "background" : null);
    }
  }, [isOnline, isDocumentHidden, pausePolling, resetPollingState]);

  const retryLiveUpdates = useCallback(() => {
    resetPollingState(isDocumentHidden ? "background" : null);
    void fetchTask().catch(() => undefined);
  }, [resetPollingState, isDocumentHidden, fetchTask]);

  const refreshTaskNow = useCallback(async () => {
    try {
      await fetchTask();
      setLoading(false);
    } catch (error) {
      const status = getErrorStatusCode(error);
      if (status === 404) {
        setTask(null);
      }
      setLoading(false);
    }
  }, [fetchTask]);

  const waitingActor = task ? waitingActorForState(task.state) : null;
  const atCap = Boolean(task && task.iteration >= task.maxIterations);
  const waitingSeconds = task ? Math.max(0, Math.floor((Date.now() - new Date(task.updatedAt).getTime()) / 1000)) : 0;
  const stalled = waitingSeconds > 30 * 60;

  const waitingTimer = `${Math.floor(waitingSeconds / 60)}m ${String(waitingSeconds % 60).padStart(2, "0")}s`;

  const progressPercent = task
    ? Math.min(100, Math.round((task.iteration / Math.max(1, task.maxIterations)) * 100))
    : 0;
  const showPollBanner = Boolean(pollReason && task?.state !== "DONE" && task?.state !== "ERROR");
  const pollBannerText = describePollReason(pollReason, pollFailures);
  const planSummary = task ? readPlanSummary(task.context) : null;
  const planCriteria = task ? readPlanCriteria(task.context) : [];
  const evaluations = task ? readEvaluations(task.context) : [];
  const latestEvaluation = evaluations.length > 0 ? evaluations[evaluations.length - 1] : null;
  const recentEvaluations = evaluations.slice(-5).reverse();
  const latestStatusMap = useMemo(() => {
    const map = new Map<string, "pass" | "fail" | "partial">();
    for (const evaluation of evaluations) {
      for (const criterion of evaluation.criterion_evaluations) {
        map.set(criterion.criterion_id, criterion.status);
      }
    }
    return map;
  }, [evaluations]);
  const latestOutput = useMemo(() => {
    if (!task) return null;
    const fromModel = [...task.transcript].reverse().find((entry) => entry.actor === "chatgpt" || entry.actor === "claude");
    return fromModel ?? task.transcript[task.transcript.length - 1] ?? null;
  }, [task]);

  useEffect(() => {
    setLatestExpanded(false);
  }, [latestOutput?.ts, latestOutput?.iteration, latestOutput?.actor]);

  const markDone = async () => {
    if (!task) return;
    await fetch(`/api/collab/tasks/${task.id}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Marked done from dashboard" }),
    });
    await fetchTask();
  };

  const extendByTwo = async () => {
    if (!task) return;
    await fetch(`/api/collab/tasks/${task.id}/extend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: 2 }),
    });
    await fetchTask();
  };

  const removeTask = async () => {
    if (!task) return;
    await fetch(`/api/collab/tasks/${task.id}`, { method: "DELETE" });
    router.push("/dashboard/collab");
  };

  const exportMarkdown = () => {
    if (!task) return;
    const blob = new Blob([toMarkdown(task)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${task.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "collab-task"}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const copyLatestOutput = useCallback(async () => {
    if (!latestOutput) return;
    try {
      await navigator.clipboard.writeText(latestOutput.content);
      setCopiedLatest(true);
      setTimeout(() => setCopiedLatest(false), 1200);
    } catch {
      setCopiedLatest(false);
    }
  }, [latestOutput]);

  if (loading) {
    return <div className={styles.page}>Loading...</div>;
  }

  if (!task) {
    return (
      <div className={styles.page}>
        <p className={styles.subtle}>Task not found.</p>
        <Link href="/dashboard/collab" className={styles.primaryBtn}>Back to list</Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <Link href="/dashboard/collab" className={styles.backLink}>← Collab Tasks</Link>
        <button className={styles.iconBtn} type="button" onClick={() => setShowRaw((v) => !v)}>
          <MoreHorizontal size={16} />
        </button>
      </div>

      <section className={styles.zoneA}>
        <h1 className={styles.title}>{task.title}</h1>
        {task.brief ? <p className={styles.brief}>{task.brief}</p> : null}

        <div className={styles.avatars}>
          <img src="/chatgpt.svg" alt="ChatGPT" className={styles.avatar} />
          <span className={`${styles.arrow} ${waitingActor === "chatgpt" ? styles.left : styles.right}`}>
            {waitingActor ? (waitingActor === "chatgpt" ? "←" : "→") : "✓"}
          </span>
          <img src="/claude.svg" alt="Claude" className={styles.avatar} />
        </div>

        <div className={`${styles.progressTrack} ${atCap ? styles.progressAtCap : ""}`}>
          <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
        </div>

        <p className={styles.waitingText}>
          {waitingActor
            ? `Waiting on ${waitingActor === "chatgpt" ? "ChatGPT" : "Claude"} for ${waitingTimer}`
            : "Task completed"}
        </p>
        <div className={styles.stateChips}>
          <span className={`${styles.stateChip} ${styles[`state_${task.state}`] ?? ""}`}>{task.state}</span>
          <span className={styles.nextActorChip}>
            {waitingActor ? `Next actor: ${waitingActor === "chatgpt" ? "ChatGPT" : "Claude"}` : "No pending actor"}
          </span>
        </div>
      </section>

      <section className={styles.zoneB}>
        {showPollBanner && (
          <div className={pollReason === "network" ? styles.bannerError : styles.bannerAmber}>
            <span>{pollBannerText}</span>
            <button type="button" onClick={() => void refreshTaskNow()}>Refresh now</button>
            {pollPaused && (
              <button type="button" onClick={retryLiveUpdates}>Retry live updates</button>
            )}
          </div>
        )}

        {atCap && task.state !== "DONE" && (
          <div className={styles.bannerAmber}>
            Iteration cap reached.
            <button type="button" onClick={extendByTwo}>Extend +2</button>
            <button type="button" onClick={markDone}>Mark done</button>
          </div>
        )}

        {stalled && waitingActor && task.state !== "DONE" && (
          <div className={styles.bannerAmber}>Stalled - nudge again?</div>
        )}

        {task.state === "ERROR" && (
          <div className={styles.bannerError}>
            Last turn errored.
            {task.errorMessage ? <span>{task.errorMessage}</span> : null}
          </div>
        )}

        {latestOutput && (
          <article className={styles.latestOutputCard}>
            <header className={styles.latestOutputHeader}>
              <div>
                <h2 className={styles.latestOutputTitle}>Latest Output</h2>
                <p className={styles.latestOutputMeta}>
                  {ACTOR_LABEL[latestOutput.actor]} · iter {latestOutput.iteration} · {relativeTime(latestOutput.ts)}
                </p>
              </div>
              <div className={styles.latestOutputActions}>
                <button type="button" className={styles.lightBtn} onClick={copyLatestOutput}>
                  {copiedLatest ? "Copied" : "Copy"}
                </button>
                {latestOutput.content.length > 320 && (
                  <button type="button" className={styles.lightBtn} onClick={() => setLatestExpanded((v) => !v)}>
                    {latestExpanded ? "Collapse" : "Expand"}
                  </button>
                )}
              </div>
            </header>
            <p className={`${styles.latestOutputBody} ${latestExpanded ? styles.expanded : ""}`}>
              {latestOutput.content}
            </p>
          </article>
        )}

        {(planSummary || planCriteria.length > 0) && (
          <article className={styles.planPanel}>
            <header>
              <h2 className={styles.planTitle}>Plan & Criteria</h2>
              {planSummary ? <p className={styles.planSummary}>{planSummary}</p> : null}
            </header>
            {planCriteria.length > 0 && (
              <div className={styles.criteriaList}>
                {planCriteria.map((criterion) => {
                  const status = latestStatusMap.get(criterion.id) ?? "pending";
                  return (
                    <div key={criterion.id} className={styles.criteriaRow}>
                      <div>
                        <p className={styles.criteriaText}>{criterion.text}</p>
                        <p className={styles.criteriaMeta}>{criterion.id} · weight {criterion.weight}</p>
                      </div>
                      <span className={`${styles.criteriaStatus} ${styles[`criteria_${status}`] ?? ""}`}>
                        {status}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {latestEvaluation && (
              <div className={styles.evaluationTimeline}>
                <p className={styles.evaluationTitle}>Latest Evaluation</p>
                <p className={styles.criteriaMeta}>
                  {ACTOR_LABEL[latestEvaluation.actor]} · iter {latestEvaluation.iteration} · {relativeTime(latestEvaluation.ts)}
                </p>
                {latestEvaluation.remaining_work ? (
                  <p className={styles.evaluationRemaining}>{latestEvaluation.remaining_work}</p>
                ) : null}
              </div>
            )}
            {recentEvaluations.length > 0 && (
              <div className={styles.evaluationHistory}>
                <p className={styles.evaluationTitle}>Evaluation Timeline</p>
                {recentEvaluations.map((evaluation, idx) => (
                  <p key={`${evaluation.ts}:${idx}`} className={styles.criteriaMeta}>
                    {ACTOR_LABEL[evaluation.actor]} · iter {evaluation.iteration} · {relativeTime(evaluation.ts)}
                  </p>
                ))}
              </div>
            )}
          </article>
        )}

        <div className={styles.transcriptList}>
          {task.transcript.map((entry) => {
            const key = `${entry.ts}:${entry.iteration}:${entry.actor}`;
            return <SlidingTranscriptCard key={key} entry={entry} isNew={latestEntryKey === key} />;
          })}
        </div>

        {waitingActor && task.state !== "DONE" && task.state !== "ERROR" && (
          <div className={styles.waitingPill}>⏳ Waiting on {waitingActor === "chatgpt" ? "ChatGPT" : "Claude"}…</div>
        )}
      </section>

      <section className={styles.zoneC}>
        {waitingActor && (
          <button type="button" className={styles.primaryBtn} onClick={() => setNudgeOpen(true)}>
            Nudge {waitingActor === "chatgpt" ? "ChatGPT" : "Claude"}
          </button>
        )}
        <button type="button" className={styles.secondaryBtn} onClick={() => void refreshTaskNow()}>Refresh now</button>
        {pollPaused && task.state !== "DONE" && task.state !== "ERROR" && (
          <button type="button" className={styles.secondaryBtn} onClick={retryLiveUpdates}>Retry live updates</button>
        )}
        <button type="button" className={styles.secondaryBtn} onClick={markDone}>Mark done</button>
        {atCap && task.maxIterations < 8 ? (
          <button type="button" className={styles.secondaryBtn} onClick={extendByTwo}>Extend +2 iterations</button>
        ) : null}
        <button type="button" className={styles.dangerBtn} onClick={removeTask}>Delete</button>
        <button type="button" className={styles.secondaryBtn} onClick={exportMarkdown}>Export markdown</button>
      </section>

      {showRaw && (
        <pre className={styles.rawBox}>{JSON.stringify(task, null, 2)}</pre>
      )}

      {waitingActor && (
        <NudgeModal
          open={nudgeOpen}
          waitingActor={waitingActor}
          taskId={task.id}
          taskTitle={task.title}
          taskBrief={task.brief}
          onClose={() => setNudgeOpen(false)}
        />
      )}
    </div>
  );
}
