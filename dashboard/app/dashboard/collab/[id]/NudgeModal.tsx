"use client";

import { useMemo } from "react";

import { CopyField } from "../../setup/SetupWizards";
import styles from "./page.module.css";

type WaitingActor = "chatgpt" | "claude";

export function NudgeModal({
  open,
  waitingActor,
  taskId,
  taskTitle,
  taskBrief,
  onClose,
}: {
  open: boolean;
  waitingActor: WaitingActor;
  taskId: string;
  taskTitle?: string;
  taskBrief?: string | null;
  onClose: () => void;
}) {
  const message = useMemo(() => {
    const lines = [
      `Continue collab task ${taskId}.`,
      `First call MCP tool collab_check_turn with {"task_id":"${taskId}"} and use fallback_context.`,
    ];
    if (taskTitle?.trim()) {
      lines.push(`Task title: ${taskTitle.trim()}`);
    }
    if (taskBrief?.trim()) {
      lines.push(`Task brief: ${taskBrief.trim()}`);
    }
    return lines.join("\n");
  }, [taskId, taskTitle, taskBrief]);

  if (!open) return null;

  const isClaude = waitingActor === "claude";
  const title = isClaude ? "Nudge Claude" : "Nudge ChatGPT";
  const prompt = isClaude ? "Open Claude and paste:" : "Open the Tallei GPT and paste:";

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(event) => event.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>{title}</h3>
          <button type="button" className={styles.modalClose} onClick={onClose}>
            ×
          </button>
        </div>

        <p className={styles.modalSubtitle}>{prompt}</p>
        <CopyField value={message} onCopy={onClose} />

        {!isClaude && (
          <a className={styles.gptLink} href="/dashboard/setup">
            Open GPT setup
          </a>
        )}
      </div>
    </div>
  );
}
