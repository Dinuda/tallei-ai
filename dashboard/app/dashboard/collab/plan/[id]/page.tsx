"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { ChainOfThought } from "@/components/ai-elements/chain-of-thought";
import { Confirmation } from "@/components/ai-elements/confirmation";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Plan, PlanTitle } from "@/components/ai-elements/plan";
import { Queue, QueueItem, QueueList, QueueTitle } from "@/components/ai-elements/queue";
import { Reasoning, ReasoningToggle } from "@/components/ai-elements/reasoning";
import { SourceItem, Sources, SourcesContent, SourcesTitle } from "@/components/ai-elements/sources";
import { Tool, ToolHeader } from "@/components/ai-elements/tool";

import styles from "./page.module.css";

type OrchestrationStatus = "DRAFT" | "INTERVIEWING" | "PLAN_READY" | "RUNNING" | "DONE" | "ABORTED";

type ArticleItem = {
  query: string;
  url: string;
  snippet: string;
};

type PlannerTurn = {
  role: "planner" | "user" | "system";
  content: string;
  ts: string;
  web_searches?: ArticleItem[];
};

type OrchestrationPlan = {
  title: string;
  summary: string;
  phases: Array<{ id: string; name: string; outputs: string[] }>;
  success_criteria: Array<{ id: string; text: string; weight: number }>;
  open_questions: string[];
};

type OrchestrationSession = {
  id: string;
  goal: string;
  status: OrchestrationStatus;
  transcript: PlannerTurn[];
  plan: OrchestrationPlan | null;
  collabTaskId: string | null;
  updatedAt: string;
  errorMessage: string | null;
};

type UploadSummary = {
  saved: Array<{ ref: string; title: string | null; filename: string | null }>;
  failed: Array<{ filename: string | null; error: string; status: number }>;
};

type OrchestrateChatDataParts = {
  question: {
    sessionId: string;
    question: string;
    status: OrchestrationStatus;
  };
  articles: {
    items: ArticleItem[];
  };
  "upload-summary": UploadSummary;
  "plan-ready": {
    title: string;
    summary: string;
    successCriteriaCount: number;
  };
};

type OrchestrateChatMessage = UIMessage<unknown, OrchestrateChatDataParts>;

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.floor(delta / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function dedupeTranscript(transcript: PlannerTurn[]): PlannerTurn[] {
  const seen = new Set<string>();
  const unique: PlannerTurn[] = [];

  for (const turn of transcript) {
    const key = `${turn.role}::${turn.ts}::${turn.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(turn);
  }

  return unique;
}

function toTranscriptMessages(session: OrchestrationSession): OrchestrateChatMessage[] {
  const uniqueTranscript = dedupeTranscript(session.transcript);
  let latestPlannerIndex = -1;

  for (let i = uniqueTranscript.length - 1; i >= 0; i -= 1) {
    if (uniqueTranscript[i].role === "planner") {
      latestPlannerIndex = i;
      break;
    }
  }

  return uniqueTranscript.map((entry, index) => {
    const role: OrchestrateChatMessage["role"] =
      entry.role === "planner" ? "assistant" : entry.role === "user" ? "user" : "system";

    const isLatestInterviewQuestion =
      entry.role === "planner" && index === latestPlannerIndex && session.status === "INTERVIEWING";

    const parts: OrchestrateChatMessage["parts"] = [];
    if (entry.content.trim().length > 0 && !isLatestInterviewQuestion) {
      parts.push({ type: "text", text: entry.content });
    }

    if (entry.role === "planner" && Array.isArray(entry.web_searches) && entry.web_searches.length > 0) {
      parts.push({ type: "data-articles", data: { items: entry.web_searches } });
    }

    if (isLatestInterviewQuestion) {
      parts.push({
        type: "data-question",
        data: {
          sessionId: session.id,
          question: entry.content,
          status: session.status,
        },
      });
    }

    if (entry.role === "planner" && index === latestPlannerIndex && session.status === "PLAN_READY" && session.plan) {
      parts.push({
        type: "data-plan-ready",
        data: {
          title: session.plan.title,
          summary: session.plan.summary,
          successCriteriaCount: session.plan.success_criteria.length,
        },
      });
    }

    return {
      id: `${entry.role}:${entry.ts}:${index}`,
      role,
      parts,
    };
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to encode attachment."));
    };
    reader.onerror = () => reject(new Error("Failed to read attachment."));
    reader.readAsDataURL(file);
  });
}

function ArticleCards({ items }: { items: ArticleItem[] }) {
  return (
    <Sources className={styles.toolBlock}>
      <SourcesTitle className={styles.toolLabel}>Sources</SourcesTitle>
      <SourcesContent className={styles.researchList}>
        {items.map((item, index) => (
          <SourceItem key={`${item.url}:${index}`} href={item.url} target="_blank" rel="noreferrer" className={styles.researchItem}>
            <span>{item.query || "Reference"}</span>
            <small>{item.snippet}</small>
          </SourceItem>
        ))}
      </SourcesContent>
    </Sources>
  );
}

function UploadSummaryCard({ summary }: { summary: UploadSummary }) {
  const hasSaved = summary.saved.length > 0;
  const hasFailed = summary.failed.length > 0;

  if (!hasSaved && !hasFailed) return null;

  return (
    <Tool className={styles.toolBlock}>
      <ToolHeader className={styles.toolLabel}>Tool: Upload Summary</ToolHeader>
      <p className={styles.toolMeta}>
        {summary.saved.length} saved · {summary.failed.length} failed
      </p>
      {hasSaved ? (
        <div className={styles.chips}>
          {summary.saved.map((item) => (
            <span key={item.ref} className={styles.chipSuccess}>
              {item.title ?? item.filename ?? item.ref}
            </span>
          ))}
        </div>
      ) : null}
      {hasFailed ? (
        <div className={styles.chips}>
          {summary.failed.map((item, index) => (
            <span key={`${item.filename ?? "file"}:${index}`} className={styles.chipError}>
              {(item.filename ?? "file") + ": " + item.error}
            </span>
          ))}
        </div>
      ) : null}
    </Tool>
  );
}

function roleLabel(role: OrchestrateChatMessage["role"]): string {
  if (role === "user") return "you";
  return "planner";
}

function questionOptions(question: string): string[] {
  const options: string[] = [];
  const source = question.trim();
  if (!source) return options;

  const egMatch = source.match(/\((?:e\.g\.|eg\.?)\s*([^)]{3,220})\)/i);
  if (egMatch?.[1]) {
    const parsed = egMatch[1]
      .split(/,|\/|\bor\b/gi)
      .map((item) => item.replace(/[.]/g, "").trim())
      .filter(Boolean)
      .slice(0, 6);
    options.push(...parsed);
  }

  if (options.length === 0) {
    options.push("Yes, continue", "Need examples", "Refine the question");
  }

  return Array.from(new Set(options));
}

function latestPlannerQuestionFromMessages(messages: OrchestrateChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    for (const part of message.parts) {
      if (part.type === "data-question" && typeof part.data?.question === "string") {
        return part.data.question;
      }
    }
  }
  return "";
}

function transcriptKey(session: OrchestrationSession): string {
  const turns = session.transcript;
  const last = turns.length > 0 ? turns[turns.length - 1] : null;
  return [
    session.id,
    session.status,
    turns.length,
    last?.role ?? "",
    last?.ts ?? "",
    last?.content ?? "",
    session.plan?.title ?? "",
    session.plan?.summary ?? "",
  ].join("::");
}

export default function OrchestrationSessionPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const lastAppliedTranscriptKeyRef = useRef<string>("");
  const previousMessageCountRef = useRef<number>(0);

  const [session, setSession] = useState<OrchestrationSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [approving, setApproving] = useState(false);

  const sessionId = params?.id ?? "";

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    error: chatError,
  } = useChat<OrchestrateChatMessage>({
    id: sessionId ? `collab-plan-${sessionId}` : "collab-plan",
    transport: new DefaultChatTransport({
      api: sessionId ? `/api/orchestrate/sessions/${sessionId}/chat` : "/api/orchestrate/sessions/unknown/chat",
    }),
  });

  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/orchestrate/sessions/${sessionId}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || !body?.session) {
        setSession(null);
        setSessionError(typeof body?.error === "string" ? body.error : "Session not found.");
        return;
      }
      setSession(body.session as OrchestrationSession);
      setSessionError(null);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Failed to load session.");
      setSession(null);
    } finally {
      setSessionLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setSessionLoading(true);
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => {
      void loadSession();
    }, 2_000);
    return () => clearInterval(timer);
  }, [sessionId, loadSession]);

  useEffect(() => {
    if (!session) return;
    if (status === "streaming" || status === "submitted") return;

    const nextKey = transcriptKey(session);
    if (lastAppliedTranscriptKeyRef.current === nextKey) return;

    setMessages(toTranscriptMessages(session));
    lastAppliedTranscriptKeyRef.current = nextKey;
  }, [session, setMessages, status]);

  useEffect(() => {
    const nextCount = messages.length;
    const hadNewMessage = nextCount > previousMessageCountRef.current;
    previousMessageCountRef.current = nextCount;

    if (!hadNewMessage && status !== "streaming" && status !== "submitted") return;
    chatEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages, status]);

  const approvePlan = useCallback(async () => {
    if (!session || session.status !== "PLAN_READY" || approving) return;

    setApproving(true);
    try {
      const res = await fetch(`/api/orchestrate/sessions/${session.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      await loadSession();
      if (typeof body?.task_id === "string") {
        router.push(`/dashboard/collab/kickoff/${body.task_id}`);
      }
    } finally {
      setApproving(false);
    }
  }, [approving, loadSession, router, session]);

  const onPickFiles = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(event.target.files ?? []);
    if (list.length === 0) return;

    setPendingFiles((current) => {
      const next = [...current];
      const seen = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      for (const file of list) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (!seen.has(key)) {
          next.push(file);
          seen.add(key);
        }
      }
      return next;
    });

    event.target.value = "";
  }, []);

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles((current) => current.filter((_, idx) => idx !== index));
  }, []);

  const sendQuickOption = useCallback(async (option: string) => {
    if (!session || session.status !== "INTERVIEWING") return;
    if (status === "streaming" || status === "submitted") return;

    await sendMessage({ text: option });
    setInput("");
    setPendingFiles([]);
    await loadSession();
  }, [loadSession, sendMessage, session, status]);

  const latestQuestion = latestPlannerQuestionFromMessages(messages);
  const followUpSuggestions = questionOptions(latestQuestion).slice(0, 4);
  const displayMessages = messages.filter((message) => message.role !== "system");

  const handleSend = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!session || session.status !== "INTERVIEWING") return;

    const trimmed = input.trim();
    if (!trimmed && pendingFiles.length === 0) return;

    const filesAsParts: FileUIPart[] = await Promise.all(
      pendingFiles.map(async (file) => ({
        type: "file",
        mediaType: file.type || "application/octet-stream",
        filename: file.name,
        url: await fileToDataUrl(file),
      }))
    );

    if (trimmed) {
      await sendMessage({ text: trimmed, files: filesAsParts });
    } else {
      await sendMessage({ files: filesAsParts });
    }

    setInput("");
    setPendingFiles([]);
    await loadSession();
  }, [input, loadSession, pendingFiles, sendMessage, session]);

  const pageTitle = session?.plan?.title ?? session?.goal ?? "Collab Planning";

  if (sessionLoading) {
    return (
      <div className={styles.page}>
        <p className={styles.subtle}>Loading session...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={styles.page}>
        <p className={styles.errorText}>{sessionError ?? "Session not found."}</p>
        <Link href="/dashboard/collab/new" className={styles.secondaryBtn}>Back</Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <Link href="/dashboard/collab/new" className={styles.backLink}>← Collab Planning</Link>
        <span className={`${styles.status} ${styles[`status_${session.status}`] ?? ""}`}>{session.status}</span>
      </div>

      <section className={styles.sessionCard}>
        <h1 className={styles.title}>{pageTitle}</h1>
        <div className={styles.sessionMetaRow}>
          <span className={styles.metaPill}>Updated {relativeTime(session.updatedAt)}</span>
          <span className={styles.metaPill}>{displayMessages.length} messages</span>
          <span className={styles.metaPill}>{session.status === "INTERVIEWING" ? "Active interview" : "Planning checkpoint"}</span>
        </div>
        {session.plan?.summary ? <p className={styles.summary}>{session.plan.summary}</p> : null}
        <div className={styles.sessionActions}>
          {session.collabTaskId ? (
            <Link href={`/dashboard/collab/${session.collabTaskId}`} className={styles.secondaryBtn}>Open Linked Collab Task</Link>
          ) : null}
        </div>
      </section>

      {session.status === "INTERVIEWING" && latestQuestion ? (
        <section className={styles.questionPanel}>
          <div className={styles.questionHeader}>
            <h2 className={styles.sectionTitle}>Current Planning Question</h2>
            <span className={styles.metaPill}>Action needed</span>
          </div>
          <p className={styles.questionText}>{latestQuestion}</p>
          {followUpSuggestions.length > 0 ? (
            <div className={styles.quickOptions}>
              {followUpSuggestions.map((option) => (
                <button
                  key={`planner-option:${option}`}
                  type="button"
                  className={styles.quickOptionBtn}
                  onClick={() => void sendQuickOption(option)}
                  disabled={status === "streaming" || status === "submitted" || session.status !== "INTERVIEWING"}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {session.status === "PLAN_READY" && session.plan ? (
        <section className={styles.questionPanel}>
          <div className={styles.questionHeader}>
            <h2 className={styles.sectionTitle}>Plan Ready</h2>
            <span className={styles.metaPill}>{session.plan.success_criteria.length} criteria</span>
          </div>
          <p className={styles.questionText}>{session.plan.summary}</p>
          <Confirmation>
            <button type="button" className={styles.primaryBtn} onClick={() => void approvePlan()} disabled={approving}>
              {approving ? "Approving..." : "Approve Plan"}
            </button>
          </Confirmation>
        </section>
      ) : null}

      <section className={styles.chatShell}>
        <div className={styles.chatHeader}>
          <h2 className={styles.sectionTitle}>Planning Log</h2>
          <p className={styles.subtle}>Trace of planner prompts, your answers, and evidence</p>
        </div>

        <Conversation className={styles.chatListWrap}>
        <ConversationContent ref={chatListRef} className={styles.chatList}>
          {displayMessages.map((message) => (
            <article
              key={message.id}
              className={`${styles.message} ${
                message.role === "user"
                  ? styles.userMessage
                  : message.role === "assistant"
                    ? styles.assistantMessage
                    : styles.systemMessage
              }`}
            >
              <p className={styles.turnMeta}>{roleLabel(message.role)}</p>

              {message.parts.map((part, index) => {
                if (part.type === "text") {
                  return (
                    <p key={`${message.id}:text:${index}`} className={styles.turnBody}>
                      {part.text}
                    </p>
                  );
                }

                if (part.type === "file") {
                  return (
                    <div key={`${message.id}:file:${index}`} className={styles.filePart}>
                      <span>{part.filename ?? "attachment"}</span>
                      <small>{part.mediaType}</small>
                    </div>
                  );
                }

                if (part.type === "data-question") {
                  return null;
                }

                if (part.type === "data-articles") {
                  return <ArticleCards key={`${message.id}:articles:${index}`} items={part.data.items} />;
                }

                if (part.type === "data-upload-summary") {
                  return <UploadSummaryCard key={`${message.id}:uploads:${index}`} summary={part.data} />;
                }

                if (part.type === "data-plan-ready") {
                  return (
                    <Plan key={`${message.id}:plan:${index}`} className={styles.toolBlock}>
                      <PlanTitle>{part.data.title}</PlanTitle>
                      <p className={styles.toolMeta}>{part.data.summary}</p>
                      <p className={styles.toolMeta}>{part.data.successCriteriaCount} success criteria</p>
                    </Plan>
                  );
                }

                return null;
              })}
            </article>
          ))}

          {(status === "streaming" || status === "submitted") ? (
            <Reasoning className={styles.loader}>
              <ReasoningToggle title="reasoning">
                <ChainOfThought>tallei is processing your latest answer and context.</ChainOfThought>
              </ReasoningToggle>
            </Reasoning>
          ) : null}
          <div ref={chatEndRef} />
        </ConversationContent>
        <ConversationScrollButton targetRef={chatListRef}>Latest</ConversationScrollButton>
        </Conversation>

        <form className={styles.composer} onSubmit={(event) => void handleSend(event)}>
          <div className={styles.composerHead}>
            <p className={styles.composerTitle}>Planner Response</p>
            <p className={styles.subtle}>
              {session.status === "INTERVIEWING" ? "Capture your decision, constraints, or examples" : "Read-only while not interviewing"}
            </p>
          </div>

          {pendingFiles.length > 0 ? (
            <Queue className={styles.pendingFiles}>
              <QueueTitle>Queue</QueueTitle>
              <QueueList>
              {pendingFiles.map((file, index) => (
                <QueueItem key={`${file.name}:${file.size}:${file.lastModified}`} className={styles.pendingFileChip}>
                  {file.name}
                  <button type="button" onClick={() => removePendingFile(index)} aria-label="Remove attachment">×</button>
                </QueueItem>
              ))}
              </QueueList>
            </Queue>
          ) : null}

          <div className={styles.composerInputWrap}>
            <textarea
              className={styles.input}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Write your planning answer (decision, tradeoffs, constraints, examples)"
              disabled={status === "streaming" || status === "submitted" || session.status !== "INTERVIEWING"}
            />
            <input
              ref={fileInputRef}
              className={styles.hiddenInput}
              type="file"
              accept="application/pdf,.docx,.docm"
              multiple
              onChange={onPickFiles}
            />

            <div className={styles.actions}>
              <div className={styles.toolActions}>
                <button
                  type="button"
                  className={styles.iconToolBtn}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={status === "streaming" || status === "submitted" || session.status !== "INTERVIEWING"}
                  aria-label="Add document"
                >
                  +
                </button>
                <span className={styles.toolTag}>Attach PDF/DOCX context</span>
              </div>

              <button
                type="submit"
                className={styles.sendBtn}
                disabled={(input.trim().length === 0 && pendingFiles.length === 0) || status === "streaming" || status === "submitted" || session.status !== "INTERVIEWING"}
                aria-label={status === "streaming" || status === "submitted" ? "Sending" : "Send"}
              >
                ↵
              </button>
            </div>
          </div>
        </form>
      </section>

      {session.errorMessage ? <p className={styles.errorText}>{session.errorMessage}</p> : null}
      {chatError ? <p className={styles.errorText}>{chatError.message}</p> : null}
      {sessionError ? <p className={styles.errorText}>{sessionError}</p> : null}
    </div>
  );
}
