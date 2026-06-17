"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isReasoningUIPart } from "ai";
import { ArrowLeft, Loader2, RefreshCw, Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Streamdown } from "streamdown";

type SpecRunProjection = {
  id: string;
  workflow_id: string;
  workflow_title: string;
  status: string;
  context?: Record<string, unknown>;
  error_json?: { message?: string };
};

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

export function SpecRunPage({
  workflowId,
  runId,
  run,
  onRefresh,
}: {
  workflowId: string;
  runId: string;
  run: SpecRunProjection;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { messages, sendMessage, status: chatStatus, setMessages } = useChat({
    id: runId,
    transport: new DefaultChatTransport({
      api: `/api/workflows/loops/${workflowId}/run/chat`,
      prepareSendMessagesRequest: ({ messages: chatMessages, id }) => ({
        body: {
          runId: id,
          messages: chatMessages,
        },
      }),
    }),
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/workflows/runs/${runId}/messages`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || cancelled) return;
        if (Array.isArray(payload.messages)) {
          setMessages(payload.messages);
        }
      } catch {
        // Messages load is best-effort; chat can still start fresh.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, setMessages]);

  const post = useCallback(async (path: string) => {
    setBusy(path);
    setError(null);
    try {
      const response = await fetch(path, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Command failed");
      await onRefresh();
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : "Command failed");
    } finally {
      setBusy(null);
    }
  }, [onRefresh]);

  const terminal = ["succeeded", "failed", "cancelled"].includes(run.status);
  const canSend = !terminal && chatStatus !== "streaming" && chatStatus !== "submitted";

  return (
    <main className="mx-auto flex h-[calc(100vh-72px)] max-w-4xl flex-col px-6 py-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-light)] pb-4">
        <div>
          <Link href={`/dashboard/loops/${workflowId}`} className="mb-2 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
            <ArrowLeft size={12} />
            Back to loop
          </Link>
          <h1 className="text-xl font-bold text-[var(--text)]">{run.workflow_title}</h1>
          <p className="mt-1 text-sm text-[var(--text-2)]">
            Run {runId.slice(0, 8)} · <span className="capitalize">{statusLabel(run.status)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void onRefresh()} disabled={Boolean(busy)}>
            <RefreshCw size={14} />
            Refresh
          </Button>
          {terminal ? (
            <Button type="button" size="sm" onClick={() => void post(`/api/workflows/runs/${runId}/retry`)} disabled={Boolean(busy)}>
              Retry
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => void post(`/api/workflows/runs/${runId}/cancel`)} disabled={Boolean(busy)}>
              Cancel
            </Button>
          )}
        </div>
      </header>

      {error ? (
        <div className="mb-4 border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : null}
      {run.error_json?.message ? (
        <div className="mb-4 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{run.error_json.message}</div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-2xl border border-[var(--border-light)] bg-white p-4">
        {messages.length === 0 ? (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center text-sm text-[var(--text-muted)]">
            <Workflow size={28} className="text-[var(--text-muted)]" />
            <p>The loop runner will stream progress here while the run executes.</p>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={message.role === "user" ? "text-right" : "text-left"}>
              <div
                className={
                  message.role === "user"
                    ? "inline-block max-w-[90%] rounded-2xl bg-[var(--accent-light)] px-4 py-2 text-sm text-[var(--text)]"
                    : "max-w-none text-sm text-[var(--text)]"
                }
              >
                {message.parts.map((part, index) => {
                  if (part.type === "text") {
                    return <Streamdown key={`${message.id}-${index}`}>{part.text}</Streamdown>;
                  }
                  if (isReasoningUIPart(part)) {
                    const reasoningText = part.text?.trim() ?? "";
                    if (!reasoningText && part.state !== "streaming") return null;
                    return (
                      <Reasoning
                        isStreaming={part.state === "streaming"}
                        defaultOpen={part.state === "streaming"}
                        key={`${message.id}-reasoning-${index}`}
                      >
                        <ReasoningTrigger />
                        <ReasoningContent>{part.text}</ReasoningContent>
                      </Reasoning>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          ))
        )}
        {(chatStatus === "streaming" || chatStatus === "submitted" || run.status === "running" || run.status === "queued") && (
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Loader2 size={14} className="animate-spin" />
            Running loop...
          </div>
        )}
      </div>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const input = form.elements.namedItem("prompt") as HTMLInputElement;
          const value = input.value.trim();
          if (!value || !canSend) return;
          void sendMessage({ text: value });
          input.value = "";
        }}
      >
        <input
          name="prompt"
          className="flex-1 rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm"
          placeholder={canSend ? "Send a follow-up to the loop runner..." : "Run finished"}
          disabled={!canSend}
        />
        <Button type="submit" disabled={!canSend}>
          Send
        </Button>
      </form>
    </main>
  );
}
