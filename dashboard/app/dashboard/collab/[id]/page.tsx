"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useParams, useRouter } from "next/navigation";

import { NudgeModal } from "./NudgeModal";
import CollabLayout from "./components/CollabLayout";
import StatusHeader from "./components/StatusHeader";
import LatestOutput from "./components/LatestOutput";
import IterationTimeline from "./components/IterationTimeline";
import TranscriptCard from "./components/TranscriptCard";
import DocumentCard from "./components/DocumentCard";
import CriteriaPanel from "./components/CriteriaPanel";
import ActionBar from "./components/ActionBar";
import DraftingLoader from "./components/DraftingLoader";
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

type TaskDocument = {
  ref: string;
  title: string;
  filename: string | null;
  status: "pending" | "ready" | "failed";
  preview: string;
};

type TaskDocumentsContext = {
  lotRef: string | null;
  lotTitle: string | null;
  conversationId: string | null;
  documents: TaskDocument[];
  upload: {
    countSaved: number;
    countFailed: number;
  } | null;
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
  successIntervalMs: 20_000,
  hiddenIntervalMs: 60_000,
  requestTimeoutMs: 10_000,
  maxErrorBackoffMs: 15_000,
  maxActiveWindowMs: 10 * 60_000,
  maxConsecutiveFailures: 6,
} as const;

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

function readTaskDocumentsContext(context: Record<string, unknown>): TaskDocumentsContext | null {
  const documentsContext = readObject(context["documents"]);
  if (Object.keys(documentsContext).length === 0) return null;

  const rawDocuments = Array.isArray(documentsContext["documents"]) ? documentsContext["documents"] : [];
  const documents = rawDocuments
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const status = item["status"];
      if (status !== "pending" && status !== "ready" && status !== "failed") return null;
      if (typeof item["ref"] !== "string" || typeof item["title"] !== "string" || typeof item["preview"] !== "string") return null;
      return {
        ref: item["ref"],
        title: item["title"],
        filename: typeof item["filename"] === "string" ? item["filename"] : null,
        status,
        preview: item["preview"],
      };
    })
    .filter((item): item is TaskDocument => Boolean(item));

  const upload = readObject(documentsContext["upload"]);
  const countSaved = typeof upload["count_saved"] === "number" ? upload["count_saved"] : null;
  const countFailed = typeof upload["count_failed"] === "number" ? upload["count_failed"] : null;

  return {
    lotRef: typeof documentsContext["lot_ref"] === "string" ? documentsContext["lot_ref"] : null,
    lotTitle: typeof documentsContext["lot_title"] === "string" ? documentsContext["lot_title"] : null,
    conversationId: typeof documentsContext["conversation_id"] === "string" ? documentsContext["conversation_id"] : null,
    documents,
    upload: countSaved !== null && countFailed !== null ? { countSaved, countFailed } : null,
  };
}

function toMarkdown(task: CollabTask): string {
  const lines: string[] = [`# ${task.title}`, "", `State: ${task.state}`, `Turn: ${task.iteration}/${task.maxIterations}`, "", "## Transcript", ""];
  for (const entry of task.transcript) {
    lines.push(`### ${entry.actor === "chatgpt" ? "ChatGPT" : entry.actor === "claude" ? "Claude" : "User"} · Turn ${entry.iteration} · ${entry.ts}`);
    lines.push("");
    lines.push(entry.content);
    lines.push("");
  }
  return lines.join("\n");
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

    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);

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
      console.debug("[collab-poll] paused", { reason, failures: failureCountRef.current });
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

  const redirectIfOrchestrationSession = useCallback(async (): Promise<boolean> => {
    if (!taskId) return false;
    try {
      const res = await fetch(`/api/tasks/orchestrations/${taskId}`, { cache: "no-store" });
      const body = await res.json();
      if (res.ok && typeof body?.id === "string") {
        if (typeof body?.collabTaskId === "string" && body.collabTaskId) {
          router.replace(`/dashboard/tasks/${body.collabTaskId}`);
        } else {
          router.replace("/dashboard/tasks");
        }
        return true;
      }
    } catch {
      // Keep the normal "Task not found" state if this is not an orchestration session.
    }
    return false;
  }, [router, taskId]);

  const fetchTask = useCallback(async () => {
    if (!taskId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POLL_CONFIG.requestTimeoutMs);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
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
          if (await redirectIfOrchestrationSession()) return;
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
  }, [taskId, pollPaused, task?.state, isOnline, isDocumentHidden, fetchTask, pausePolling, clearPollTimer, redirectIfOrchestrationSession]);

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
        if (await redirectIfOrchestrationSession()) return;
        setTask(null);
      }
      setLoading(false);
    }
  }, [fetchTask, redirectIfOrchestrationSession]);

  const waitingActor = task ? waitingActorForState(task.state) : null;
  const atCap = Boolean(task && task.iteration >= task.maxIterations);

  const planSummary = task ? readPlanSummary(task.context) : null;
  const planCriteria = task ? readPlanCriteria(task.context) : [];
  const evaluations = task ? readEvaluations(task.context) : [];
  const taskDocuments = task ? readTaskDocumentsContext(task.context) : null;

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

  const markDone = async () => {
    if (!task) return;
    await fetch(`/api/tasks/${task.id}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Marked done from dashboard" }),
    });
    await fetchTask();
  };

  const extendByTwo = async () => {
    if (!task) return;
    await fetch(`/api/tasks/${task.id}/extend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ by: 2 }),
    });
    await fetchTask();
  };

  const removeTask = async () => {
    if (!task) return;
    await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
    router.push("/dashboard/tasks");
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

  const pollBannerText = describePollReason(pollReason, pollFailures);
  const showPollBanner = Boolean(pollReason && task?.state !== "DONE" && task?.state !== "ERROR");

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading…</div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className={styles.page}>
        <p className={styles.subtle}>Task not found.</p>
        <Link href="/dashboard/tasks" className={styles.primaryBtn}>Back to list</Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <Link href="/dashboard/tasks" className={styles.backLink}>← Collab Tasks</Link>
        <button className={styles.iconBtn} type="button" onClick={() => setShowRaw((v) => !v)}>
          <MoreHorizontal size={16} />
        </button>
      </div>

      <CollabLayout
        content={
          <>
            <StatusHeader
              title={task.title}
              brief={task.brief}
              state={task.state}
              iteration={task.iteration}
              maxIterations={task.maxIterations}
              updatedAt={task.updatedAt}
            />

            <IterationTimeline
              entries={task.transcript}
              currentIteration={task.iteration}
              maxIterations={task.maxIterations}
            />

            {showPollBanner && (
              <div className={pollReason === "network" ? styles.bannerError : styles.bannerAmber}>
                <span>{pollBannerText}</span>
                <button type="button" onClick={() => void refreshTaskNow()}>Refresh now</button>
                {pollPaused && <button type="button" onClick={retryLiveUpdates}>Retry live updates</button>}
              </div>
            )}

            {atCap && task.state !== "DONE" && (
              <div className={styles.bannerAmber}>
                Turn cap reached.
                <button type="button" onClick={extendByTwo}>Add 2 more</button>
                <button type="button" onClick={markDone}>Finish task</button>
              </div>
            )}

            {task.state === "ERROR" && (
              <div className={styles.bannerError}>
                Last turn errored.
                {task.errorMessage ? <span>{task.errorMessage}</span> : null}
              </div>
            )}

            {latestOutput && (
              <LatestOutput
                actor={latestOutput.actor}
                iteration={latestOutput.iteration}
                content={latestOutput.content}
                ts={latestOutput.ts}
              />
            )}

            <div className={styles.transcriptSection}>
              <h2 className={styles.sectionTitle}>Transcript</h2>
              <div className={styles.transcriptList}>
                {task.transcript.map((entry) => {
                  const key = `${entry.ts}:${entry.iteration}:${entry.actor}`;
                  return (
                    <TranscriptCard
                      key={key}
                      actor={entry.actor}
                      iteration={entry.iteration}
                      content={entry.content}
                      ts={entry.ts}
                      isNew={latestEntryKey === key}
                    />
                  );
                })}
              </div>
            </div>

            {waitingActor && task.state !== "DONE" && task.state !== "ERROR" && (
              <DraftingLoader
                actor={waitingActor}
                className={styles.waitingPill}
              />
            )}
          </>
        }
        sidebar={
          <>
            {(planSummary || planCriteria.length > 0 || evaluations.length > 0) && (
              <CriteriaPanel
                planSummary={planSummary}
                criteria={planCriteria}
                evaluations={evaluations}
                latestStatusMap={latestStatusMap}
              />
            )}

            {taskDocuments && (
              <DocumentCard
                documents={taskDocuments.documents}
                lotTitle={taskDocuments.lotTitle}
                countSaved={taskDocuments.upload?.countSaved ?? taskDocuments.documents.length}
                countFailed={taskDocuments.upload?.countFailed ?? 0}
              />
            )}

            <ActionBar
              waitingActor={waitingActor}
              state={task.state}
              atCap={atCap}
              maxIterations={task.maxIterations}
              pollPaused={pollPaused}
              onNudge={() => setNudgeOpen(true)}
              onRefresh={refreshTaskNow}
              onRetryLiveUpdates={retryLiveUpdates}
              onMarkDone={markDone}
              onExtend={extendByTwo}
              onDelete={removeTask}
              onExport={exportMarkdown}
            />
          </>
        }
      />

      {showRaw && <pre className={styles.rawBox}>{JSON.stringify(task, null, 2)}</pre>}

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
