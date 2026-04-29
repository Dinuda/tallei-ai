"use client";

import { useMemo } from "react";
import DraftingLoader from "./DraftingLoader";
import styles from "./StatusHeader.module.css";

type CollabState = "CREATIVE" | "TECHNICAL" | "DONE" | "ERROR";
type CollabActor = "chatgpt" | "claude" | "user";

const ACTOR_LABEL: Record<CollabActor, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  user: "User",
};

const PLATFORM_COLOR: Record<CollabActor, string> = {
  chatgpt: "var(--actor-chatgpt)",
  claude: "var(--actor-claude)",
  user: "var(--actor-user)",
};

function waitingActorForState(state: CollabState): "chatgpt" | "claude" | null {
  if (state === "CREATIVE") return "chatgpt";
  if (state === "TECHNICAL") return "claude";
  return null;
}

interface StatusHeaderProps {
  title: string;
  brief: string | null;
  state: CollabState;
  iteration: number;
  updatedAt: string;
}

export default function StatusHeader({
  title,
  brief,
  state,
  iteration,
  updatedAt,
}: StatusHeaderProps) {
  const waitingActor = waitingActorForState(state);

  const waitingSeconds = useMemo(() => {
    return Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000));
  }, [updatedAt]);

  const waitingTimer = `${Math.floor(waitingSeconds / 60)}m ${String(waitingSeconds % 60).padStart(2, "0")}s`;
  const stalled = waitingSeconds > 30 * 60;

  return (
    <header className={styles.header}>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{title}</h1>
        {brief ? <p className={styles.brief}>{brief}</p> : null}
      </div>

      <div className={styles.metaRow}>
        <div className={styles.avatars}>
          <div className={`${styles.avatarWrap} ${waitingActor === "chatgpt" ? styles.avatarActive : ""}`}>
            <img src="/chatgpt.svg" alt="ChatGPT" className={styles.avatar} />
          </div>
          <span className={`${styles.arrow} ${waitingActor === "chatgpt" ? styles.arrowLeft : waitingActor === "claude" ? styles.arrowRight : styles.arrowDone}`}>
            {waitingActor ? (waitingActor === "chatgpt" ? "←" : "→") : "✓"}
          </span>
          <div className={`${styles.avatarWrap} ${waitingActor === "claude" ? styles.avatarActive : ""}`}>
            <img src="/claude.svg" alt="Claude" className={styles.avatar} />
          </div>
        </div>

        <div className={styles.statusPill}>
          {waitingActor ? (
            <>
              <DraftingLoader actor={waitingActor} />
              <span className={styles.pillText} style={{ marginLeft: 8 }}>
                · {waitingTimer}
              </span>
              {stalled && <span className={styles.pillWarning}>Stalled</span>}
            </>
          ) : (
            <>
              <span className={styles.pillDot} style={{ backgroundColor: "var(--status-success-text)" }} />
              <span className={styles.pillText}>Task completed</span>
            </>
          )}
        </div>
      </div>

      <div className={styles.progressTrack}>
        <div
          className={styles.progressFill}
          style={{ width: waitingActor ? "58%" : "100%" }}
        />
      </div>

      <div className={styles.stateRow}>
        <span className={`${styles.stateChip} ${styles[`state_${state}`] ?? ""}`}>{state}</span>
        <span className={styles.iterationChip}>
          Turn {iteration}
        </span>
      </div>
    </header>
  );
}
