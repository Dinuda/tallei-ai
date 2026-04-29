"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Check, ArrowRight, ArrowLeft, ClipboardCheck } from "lucide-react";

import styles from "./page.module.css";

type CollabTask = {
  id: string;
  title: string;
  brief: string | null;
  context: Record<string, unknown>;
};

type SetupSnapshot = {
  comments: string | null;
  providerRoles: {
    chatgpt: string | null;
    claude: string | null;
  };
};

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readSetupSnapshot(context: Record<string, unknown>): SetupSnapshot {
  const artifacts = readObject(context["artifacts"]);
  const setup = readObject(artifacts["setup"]);
  const roles = readObject(setup["provider_roles"]);
  return {
    comments: readText(setup["comments"]),
    providerRoles: {
      chatgpt: readText(roles["chatgpt"]),
      claude: readText(roles["claude"]),
    },
  };
}

function buildKickoffPrompt(params: {
  provider: "chatgpt" | "claude";
  task: CollabTask;
  setup: SetupSnapshot;
}): string {
  const providerLabel = params.provider === "chatgpt" ? "ChatGPT" : "Claude";
  const role = params.provider === "chatgpt" ? params.setup.providerRoles.chatgpt : params.setup.providerRoles.claude;

  const lines = [
    `Continue collab task ${params.task.id}.`,
    `First call MCP tool collab_check_turn with {"task_id":"${params.task.id}"} and use fallback_context.`,
    `Target actor: ${providerLabel}.`,
    `Task title: ${params.task.title}`,
  ];

  if (params.task.brief?.trim()) {
    lines.push(`Task brief: ${params.task.brief.trim()}`);
  }
  if (params.setup.comments) {
    lines.push(`User comments: ${params.setup.comments}`);
  }
  if (role) {
    lines.push(`Provider role guidance: ${role}`);
  }

  lines.push("Submit your turn with collab_take_turn after generating the response.");
  return lines.join("\n");
}

export default function CollabKickoffPage() {
  const routeParams = useParams<{ taskId: string }>();
  const taskId = routeParams?.taskId ?? "";

  const [task, setTask] = useState<CollabTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatgptPrompt, setChatgptPrompt] = useState("");
  const [claudePrompt, setClaudePrompt] = useState("");
  const [copied, setCopied] = useState<"chatgpt" | "claude" | null>(null);

  useEffect(() => {
    if (!taskId) return;

    let cancelled = false;
    async function loadTask() {
      setLoading(true);
      try {
        const res = await fetch(`/api/collab/tasks/${taskId}`, { cache: "no-store" });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(typeof body?.error === "string" ? body.error : "Task not found");
        }
        if (!cancelled) {
          const loadedTask = body as CollabTask;
          const setup = readSetupSnapshot(loadedTask.context ?? {});
          setTask(loadedTask);
          setChatgptPrompt(buildKickoffPrompt({ provider: "chatgpt", task: loadedTask, setup }));
          setClaudePrompt(buildKickoffPrompt({ provider: "claude", task: loadedTask, setup }));
        }
      } catch {
        if (!cancelled) setTask(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadTask();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const setupSnapshot = useMemo(() => (task ? readSetupSnapshot(task.context ?? {}) : null), [task]);

  const copyPrompt = useCallback(async (provider: "chatgpt" | "claude") => {
    const value = provider === "chatgpt" ? chatgptPrompt : claudePrompt;
    if (!value.trim()) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(provider);
      setTimeout(() => setCopied((current) => (current === provider ? null : current)), 1500);
    } catch {
      setCopied(null);
    }
  }, [chatgptPrompt, claudePrompt]);

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading kickoff prompts…</div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <h2 className={styles.emptyTitle}>Task not found</h2>
          <p className={styles.emptyText}>The task you are looking for does not exist or has been deleted.</p>
          <Link href="/dashboard/collab" className={styles.primaryBtn}>
            <ArrowLeft size={14} />
            Back to tasks
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Step indicator */}
      <nav className={styles.steps} aria-label="Setup progress">
        <div className={styles.stepDone}>
          <span className={styles.stepNumber}>1</span>
          <span className={styles.stepLabel}>Create</span>
        </div>
        <div className={styles.stepConnector} />
        <div className={styles.stepActive}>
          <span className={styles.stepNumber}>2</span>
          <span className={styles.stepLabel}>Kickoff</span>
        </div>
        <div className={styles.stepConnector} />
        <div className={styles.stepPending}>
          <span className={styles.stepNumber}>3</span>
          <span className={styles.stepLabel}>Active</span>
        </div>
      </nav>

      <header className={styles.header}>
        <h1 className={styles.title}>Kickoff Prompts</h1>
        <p className={styles.subtle}>
          Copy these prompts into ChatGPT and Claude to start the collaboration. Then open the task to watch live updates.
        </p>
      </header>

      {/* Task summary */}
      <section className={styles.summaryCard}>
        <div className={styles.summaryHeader}>
          <span className={styles.summaryLabel}>Task</span>
          <span className={styles.summaryId}>{task.id.slice(0, 8)}…</span>
        </div>
        <h2 className={styles.summaryTitle}>{task.title}</h2>
        {task.brief && <p className={styles.summaryBrief}>{task.brief}</p>}
        {setupSnapshot?.comments && (
          <div className={styles.summaryComment}>
            <span className={styles.summaryCommentLabel}>Your notes</span>
            <p>{setupSnapshot.comments}</p>
          </div>
        )}
        {(setupSnapshot?.providerRoles.chatgpt || setupSnapshot?.providerRoles.claude) && (
          <div className={styles.summaryRoles}>
            {setupSnapshot.providerRoles.chatgpt && (
              <div className={styles.summaryRole}>
                <span className={styles.summaryRoleBadge} style={{ background: "var(--actor-chatgpt)", color: "#fff" }}>ChatGPT</span>
                <span className={styles.summaryRoleText}>{setupSnapshot.providerRoles.chatgpt}</span>
              </div>
            )}
            {setupSnapshot.providerRoles.claude && (
              <div className={styles.summaryRole}>
                <span className={styles.summaryRoleBadge} style={{ background: "var(--actor-claude)", color: "#fff" }}>Claude</span>
                <span className={styles.summaryRoleText}>{setupSnapshot.providerRoles.claude}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Prompt cards */}
      <section className={styles.promptGrid}>
        <article className={`${styles.promptCard} ${styles.promptCardChatgpt}`}>
          <div className={styles.promptCardHead}>
            <div className={styles.promptCardTitleRow}>
              <img src="/chatgpt.svg" alt="" className={styles.promptCardIcon} />
              <h2 className={styles.promptCardTitle}>ChatGPT</h2>
            </div>
            <button
              type="button"
              className={`${styles.copyBtn} ${copied === "chatgpt" ? styles.copyBtnCopied : ""}`}
              onClick={() => void copyPrompt("chatgpt")}
            >
              {copied === "chatgpt" ? (
                <>
                  <Check size={14} />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={14} />
                  Copy
                </>
              )}
            </button>
          </div>
          <textarea
            className={styles.promptTextarea}
            value={chatgptPrompt}
            onChange={(e) => setChatgptPrompt(e.target.value)}
            spellCheck={false}
          />
        </article>

        <article className={`${styles.promptCard} ${styles.promptCardClaude}`}>
          <div className={styles.promptCardHead}>
            <div className={styles.promptCardTitleRow}>
              <img src="/claude.svg" alt="" className={styles.promptCardIcon} />
              <h2 className={styles.promptCardTitle}>Claude</h2>
            </div>
            <button
              type="button"
              className={`${styles.copyBtn} ${copied === "claude" ? styles.copyBtnCopied : ""}`}
              onClick={() => void copyPrompt("claude")}
            >
              {copied === "claude" ? (
                <>
                  <Check size={14} />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={14} />
                  Copy
                </>
              )}
            </button>
          </div>
          <textarea
            className={styles.promptTextarea}
            value={claudePrompt}
            onChange={(e) => setClaudePrompt(e.target.value)}
            spellCheck={false}
          />
        </article>
      </section>

      {/* Actions */}
      <div className={styles.actions}>
        <Link href={`/dashboard/collab/${task.id}`} className={styles.primaryBtn}>
          <ClipboardCheck size={16} />
          I pasted both — open task
        </Link>
        <Link href="/dashboard/collab" className={styles.secondaryBtn}>
          <ArrowLeft size={14} />
          Back to tasks
        </Link>
      </div>
    </div>
  );
}
