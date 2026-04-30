"use client";

import { useState, useCallback } from "react";
import { Copy, Check, Maximize2, Minimize2 } from "lucide-react";
import { Streamdown } from "streamdown";
import styles from "./LatestOutput.module.css";

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

interface LatestOutputProps {
  actor: CollabActor;
  iteration: number;
  content: string;
  ts: string;
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

export default function LatestOutput({ actor, iteration, content, ts }: LatestOutputProps) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const copyContent = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }, [content]);

  return (
    <article
      className={styles.card}
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
          <span className={styles.meta}>Turn {iteration} · {relativeTime(ts)}</span>
        </div>
        <div className={styles.headerRight}>
          <button type="button" className={styles.iconBtn} onClick={copyContent} title="Copy">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </header>
      <div className={`${styles.body} ${expanded ? styles.expanded : ""}`}>
        <Streamdown>{content}</Streamdown>
      </div>
    </article>
  );
}
