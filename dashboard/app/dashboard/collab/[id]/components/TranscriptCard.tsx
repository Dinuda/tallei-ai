"use client";

import { useState } from "react";
import { Streamdown } from "streamdown";
import styles from "./TranscriptCard.module.css";

type CollabActor = "chatgpt" | "claude" | "user";

const ACTOR_LABEL: Record<CollabActor, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  user: "User",
};

const ACTOR_BG: Record<CollabActor, string> = {
  chatgpt: "var(--actor-chatgpt-bg)",
  claude: "var(--actor-claude-bg)",
  user: "var(--actor-user-bg)",
};

const ACTOR_BORDER: Record<CollabActor, string> = {
  chatgpt: "var(--actor-chatgpt-border)",
  claude: "var(--actor-claude-border)",
  user: "var(--actor-user-border)",
};

const ACTOR_TEXT: Record<CollabActor, string> = {
  chatgpt: "var(--actor-chatgpt-text)",
  claude: "var(--actor-claude-text)",
  user: "var(--actor-user-text)",
};

interface TranscriptCardProps {
  actor: CollabActor;
  iteration: number;
  content: string;
  ts: string;
  isNew?: boolean;
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

export default function TranscriptCard({ actor, iteration, content, ts, isNew }: TranscriptCardProps) {
  const [expanded, setExpanded] = useState(false);
  const shouldTruncate = content.length > 240;

  return (
    <article
      className={`${styles.card} ${isNew ? styles.newEntry : ""}`}
      style={{
        background: ACTOR_BG[actor],
        borderColor: ACTOR_BORDER[actor],
      }}
    >
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span
            className={styles.actorBadge}
            style={{
              backgroundColor: ACTOR_TEXT[actor],
              color: "#fff",
            }}
          >
            {ACTOR_LABEL[actor]}
          </span>
          <span className={styles.meta}>Turn {iteration}</span>
          <span className={styles.meta}>{relativeTime(ts)}</span>
        </div>
      </header>
      <div className={`${styles.body} ${expanded ? styles.expanded : ""}`}>
        <Streamdown>{content}</Streamdown>
      </div>
      {shouldTruncate && (
        <button
          type="button"
          className={styles.showMore}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </article>
  );
}
