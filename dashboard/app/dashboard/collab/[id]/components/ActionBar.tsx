"use client";

import { RefreshCw, CheckCircle, PlusCircle, Trash2, FileDown } from "lucide-react";
import styles from "./ActionBar.module.css";

type CollabActor = "chatgpt" | "claude" | "user";
type CollabState = "CREATIVE" | "TECHNICAL" | "DONE" | "ERROR";

interface ActionBarProps {
  waitingActor: CollabActor | null;
  state: CollabState;
  atCap: boolean;
  maxIterations: number;
  pollPaused: boolean;
  onNudge: () => void;
  onRefresh: () => void;
  onRetryLiveUpdates: () => void;
  onMarkDone: () => void;
  onExtend: () => void;
  onDelete: () => void;
  onExport: () => void;
}

export default function ActionBar({
  waitingActor,
  state,
  atCap,
  maxIterations,
  pollPaused,
  onNudge,
  onRefresh,
  onRetryLiveUpdates,
  onMarkDone,
  onExtend,
  onDelete,
  onExport,
}: ActionBarProps) {
  const isDone = state === "DONE";
  const isError = state === "ERROR";
  const isActive = !isDone && !isError;

  return (
    <div className={styles.bar}>
      {waitingActor && isActive && (
        <button type="button" className={styles.primaryBtn} onClick={onNudge}>
          Remind {waitingActor === "chatgpt" ? "ChatGPT" : "Claude"}
        </button>
      )}

      <button type="button" className={styles.secondaryBtn} onClick={onRefresh}>
        <RefreshCw size={14} />
        Refresh now
      </button>

      {pollPaused && isActive && (
        <button type="button" className={styles.secondaryBtn} onClick={onRetryLiveUpdates}>
          <RefreshCw size={14} />
          Retry live updates
        </button>
      )}

      {isActive && (
        <button type="button" className={styles.secondaryBtn} onClick={onMarkDone}>
          <CheckCircle size={14} />
          Finish task
        </button>
      )}

      {atCap && maxIterations < 8 && isActive && (
        <button type="button" className={styles.secondaryBtn} onClick={onExtend}>
          <PlusCircle size={14} />
          Add 2 more turns
        </button>
      )}

      <button type="button" className={styles.secondaryBtn} onClick={onExport}>
        <FileDown size={14} />
        Export markdown
      </button>

      <button type="button" className={styles.dangerBtn} onClick={onDelete}>
        <Trash2 size={14} />
        Delete
      </button>
    </div>
  );
}
