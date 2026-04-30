"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import styles from "./IterationTimeline.module.css";

type CollabActor = "chatgpt" | "claude" | "user";

type TimelineEntry = {
  actor: CollabActor;
  iteration: number;
  ts: string;
};

const ACTOR_LABEL: Record<CollabActor, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  user: "User",
};

const ACTOR_COLOR: Record<CollabActor, string> = {
  chatgpt: "var(--actor-chatgpt)",
  claude: "var(--actor-claude)",
  user: "var(--actor-user)",
};

const ACTOR_BG: Record<CollabActor, string> = {
  chatgpt: "var(--actor-chatgpt-bg)",
  claude: "var(--actor-claude-bg)",
  user: "var(--actor-user-bg)",
};

interface IterationTimelineProps {
  entries: TimelineEntry[];
  currentIteration: number;
}

export default function IterationTimeline({ entries, currentIteration }: IterationTimelineProps) {
  const [expanded, setExpanded] = useState(entries.length <= 6);

  const steps: Array<{ actor: CollabActor; iteration: number; ts: string | null }> = [];
  for (let i = 1; i <= Math.max(1, currentIteration); i++) {
    const entry = entries.find((e) => e.iteration === i);
    if (entry) {
      steps.push({ actor: entry.actor, iteration: i, ts: entry.ts });
    } else if (i <= currentIteration) {
      steps.push({ actor: "user", iteration: i, ts: null });
    } else {
      steps.push({ actor: "user", iteration: i, ts: null });
    }
  }

  const visibleSteps = expanded ? steps : steps.slice(-6);

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={styles.toggleLabel}>Conversation Timeline</span>
        <span className={styles.toggleMeta}>
          {steps.length} turns
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {expanded && (
        <div className={styles.timeline}>
          {visibleSteps.map((step, idx) => {
            const isCurrent = step.iteration === currentIteration;
            const isCompleted = step.iteration < currentIteration;
            const isFuture = step.iteration > currentIteration;

            return (
              <div key={step.iteration} className={styles.step}>
                {idx > 0 && <div className={`${styles.connector} ${isCompleted ? styles.connectorDone : ""}`} />}
                <div
                  className={`${styles.node} ${isCurrent ? styles.nodeCurrent : ""} ${isCompleted ? styles.nodeDone : ""} ${isFuture ? styles.nodeFuture : ""}`}
                  style={{
                    background: isCompleted || isCurrent ? ACTOR_BG[step.actor] : undefined,
                    borderColor: isCompleted || isCurrent ? ACTOR_COLOR[step.actor] : undefined,
                  }}
                  title={step.ts ? new Date(step.ts).toLocaleString() : undefined}
                >
                  {isCompleted ? (
                    <svg width="12" height="12" viewBox="0 0 15 15" fill="none">
                      <path d="M3 7.5L6 10.5L12 4.5" stroke={ACTOR_COLOR[step.actor]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <span style={{ color: ACTOR_COLOR[step.actor], fontSize: "0.65rem", fontWeight: 700 }}>
                      {step.iteration}
                    </span>
                  )}
                </div>
                <span className={`${styles.label} ${isFuture ? styles.labelFuture : ""}`}>
                  {ACTOR_LABEL[step.actor]}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
