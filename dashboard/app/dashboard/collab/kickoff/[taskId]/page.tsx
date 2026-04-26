"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

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
    `First call MCP tool collab_check_turn with {\"task_id\":\"${params.task.id}\"} and use fallback_context.`,
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
      setTimeout(() => setCopied((current) => (current === provider ? null : current)), 1200);
    } catch {
      setCopied(null);
    }
  }, [chatgptPrompt, claudePrompt]);

  if (loading) {
    return <div className={styles.page}>Loading kickoff prompts...</div>;
  }

  if (!task) {
    return (
      <div className={styles.page}>
        <p className={styles.errorText}>Task not found.</p>
        <Link href="/dashboard/collab" className={styles.secondaryBtn}>Back to tasks</Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Kickoff Prompts</h1>
        <p className={styles.subtle}>Copy, edit if needed, paste into ChatGPT and Claude, then open live task tracking.</p>
      </header>

      <section className={styles.summaryCard}>
        <p><strong>Task:</strong> {task.title}</p>
        {task.brief ? <p><strong>Brief:</strong> {task.brief}</p> : null}
        {setupSnapshot?.comments ? <p><strong>Comments:</strong> {setupSnapshot.comments}</p> : null}
      </section>

      <section className={styles.grid}>
        <article className={styles.card}>
          <div className={styles.cardHead}>
            <h2>ChatGPT prompt</h2>
            <button type="button" className={styles.secondaryBtn} onClick={() => void copyPrompt("chatgpt")}>
              {copied === "chatgpt" ? "Copied" : "Copy"}
            </button>
          </div>
          <textarea className={styles.input} value={chatgptPrompt} onChange={(event) => setChatgptPrompt(event.target.value)} />
        </article>

        <article className={styles.card}>
          <div className={styles.cardHead}>
            <h2>Claude prompt</h2>
            <button type="button" className={styles.secondaryBtn} onClick={() => void copyPrompt("claude")}>
              {copied === "claude" ? "Copied" : "Copy"}
            </button>
          </div>
          <textarea className={styles.input} value={claudePrompt} onChange={(event) => setClaudePrompt(event.target.value)} />
        </article>
      </section>

      <div className={styles.actions}>
        <Link href={`/dashboard/collab/${task.id}`} className={styles.primaryBtn}>I pasted both</Link>
        <Link href="/dashboard/collab" className={styles.secondaryBtn}>Back to tasks</Link>
      </div>
    </div>
  );
}
