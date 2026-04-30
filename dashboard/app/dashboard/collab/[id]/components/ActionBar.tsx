"use client";

import { useState } from "react";
import { RefreshCw, CheckCircle, Trash2 } from "lucide-react";
import styles from "./ActionBar.module.css";

type CollabActor = "chatgpt" | "claude" | "user";
type CollabState = "CREATIVE" | "TECHNICAL" | "DONE" | "ERROR";

interface ActionBarProps {
  waitingActor: CollabActor | null;
  state: CollabState;
  pollPaused: boolean;
  onNudge: () => void;
  onRetryLiveUpdates: () => void;
  onMarkDone: () => void;
  onDelete: () => void;
}

export default function ActionBar({
  state,
  pollPaused,
  onRetryLiveUpdates,
  onMarkDone,
  onDelete,
}: ActionBarProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDone = state === "DONE";
  const isError = state === "ERROR";
  const isActive = !isDone && !isError;

  return (
    <div className={styles.bar}>
      {pollPaused && isActive && (
        <button type="button" className={styles.secondaryBtn} onClick={onRetryLiveUpdates}>
          <RefreshCw size={14} />
          Retry live updates
        </button>
      )}

      {!confirmDelete ? (
        <div className={styles.row}>
          {isActive && (
            <button type="button" className={styles.primaryBtn} onClick={onMarkDone}>
              <CheckCircle size={14} />
              Finish task
            </button>
          )}
          <button type="button" className={styles.dangerBtn} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      ) : (
        <div className={styles.confirmRow}>
          <span className={styles.confirmText}>Delete this task permanently?</span>
          <div className={styles.row}>
            <button type="button" className={styles.secondaryBtn} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={() => {
                setConfirmDelete(false);
                onDelete();
              }}
            >
              <Trash2 size={14} />
              Confirm delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
