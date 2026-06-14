"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isReasoningUIPart,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { AnimatePresence, motion } from "motion/react";
import gsap from "gsap";
import { ChevronRight, Wand2, Info, Newspaper, Users, LineChart, GitPullRequest, Zap, ArrowRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from "@/components/ai-elements/tool";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";

const TEMPLATES = [
  {
    title: "Weekly Newsletter",
    description: "Compile industry news, summarize top stories, and draft a formatted email digest.",
    icon: Newspaper,
    prompt: "Create a weekly newsletter digest loop that compiles the latest industry news, summarizes it, and drafts a newsletter email draft.",
    accentColor: "#3d7a5a",
    bgFrom: "#d4ede0",
    bgTo: "#eaf5ee",
    iconBg: "#3d7a5a",
    borderColor: "#a8d4b8",
  },
  {
    title: "Lead Follow-up",
    description: "Monitor new sign-ups and draft personalized welcome emails three days after joining.",
    icon: Users,
    prompt: "Create a lead nurturing loop that monitors new sign-ups, checks if they've been contacted, and drafts a personalized email after 3 days.",
    accentColor: "#2a5ca8",
    bgFrom: "#cdddf5",
    bgTo: "#e8f0fc",
    iconBg: "#2a5ca8",
    borderColor: "#9ab8e8",
  },
  {
    title: "Competitor Monitor",
    description: "Scrape competitor pricing pages daily, extract changes, and post Slack alerts.",
    icon: LineChart,
    prompt: "Create a competitor monitor loop that scrapes competitor pricing pages daily, summaries changes, and alerts our Slack channel.",
    accentColor: "#7a4a1a",
    bgFrom: "#f0dfc4",
    bgTo: "#f8f0e5",
    iconBg: "#9a5a1a",
    borderColor: "#dfc090",
  },
  {
    title: "GitHub Issue Triager",
    description: "Watch new repo issues, AI-categorize them, and notify the development team.",
    icon: GitPullRequest,
    prompt: "Create a GitHub issue triager loop that watches for new repository issues, analyzes the issue text, categorizes it, and notifies Slack.",
    accentColor: "#7a2a38",
    bgFrom: "#f5d0d8",
    bgTo: "#fce8ec",
    iconBg: "#9a2a38",
    borderColor: "#e8a0b0",
  },
];

const SUGGESTIONS = [
  { label: "HN Weekly Digest", prompt: "Create a loop that fetches top Hacker News posts weekly, summarizes them, and emails me the report." },
  { label: "Support Email Translation", prompt: "Create a loop that reads incoming support emails in other languages, translates them to English, and alerts our Slack channel." },
  { label: "SQL Daily Summary", prompt: "Create a loop that runs a SQL query on our database daily, summarizes new signups, and sends a Slack update." },
  { label: "Competitor SEO Checker", prompt: "Create a loop that monitors competitor blog posts via RSS feeds and summaries their keywords." },
];

type BuilderSession = {
  id: string;
  phase: string;
  composioSessionId: string;
  intentAnalysis: unknown;
  discoveredToolContracts: Array<{ name?: string; toolRef?: string }>;
  currentProposal: { title?: string; summary?: string } | null;
  specId: string | null;
  workflowId: string | null;
  error: { message: string } | null;
};

export default function NewLoopBuilderPage() {
  const sessionIdRef = useRef<string | null>(null);
  const [session, setSession] = useState<BuilderSession | null>(null);
  const [progress, setProgress] = useState<Array<{ id: number; message: string; status: string }>>([]);
  const [dismissedPromptId, setDismissedPromptId] = useState<string | null>(null);
  const [commands, setCommands] = useState<any[]>([]);
  const [logsDialogOpen, setLogsDialogOpen] = useState(false);

  const transport = useMemo(() => new DefaultChatTransport({
    api: "/api/loop-builder/chat",
    body: () => ({ sessionId: sessionIdRef.current ?? undefined }),
  }), []);

  const refreshSession = useCallback(async (sessionId: string) => {
    const response = await fetch(`/api/loop-builder/sessions/${sessionId}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Failed to load builder session");
    sessionIdRef.current = sessionId;
    setSession(payload.session);
    setCommands(payload.commands ?? []);
    return payload.messages as UIMessage[];
  }, []);

  const totalUsage = useMemo(() => {
    const usage = {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
    for (const cmd of commands) {
      if (cmd.usage) {
        usage.calls += cmd.usage.calls ?? 0;
        usage.promptTokens += cmd.usage.promptTokens ?? 0;
        usage.completionTokens += cmd.usage.completionTokens ?? 0;
        usage.totalTokens += cmd.usage.totalTokens ?? 0;
        usage.estimatedCostUsd += cmd.usage.estimatedCostUsd ?? 0;
      }
    }
    return usage;
  }, [commands]);

  const { messages, sendMessage, setMessages, status, error, stop, addToolApprovalResponse, addToolOutput } = useChat({
    transport,
    sendAutomaticallyWhen: ({ messages: currentMessages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages: currentMessages })
      || lastAssistantMessageIsCompleteWithToolCalls({ messages: currentMessages }),
    onData: (part) => {
      if (part.type === "data-progress") {
        const events = (part.data as { events?: Array<{ id: number; message: string; status: string }> }).events;
        if (events) setProgress(events);
        return;
      }
      if (part.type !== "data-session") return;
      const nextId = (part.data as { sessionId?: string }).sessionId;
      if (!nextId || nextId === sessionIdRef.current) return;
      sessionIdRef.current = nextId;
      window.history.replaceState(null, "", `/dashboard/loops/new?session=${encodeURIComponent(nextId)}`);
    },
    onFinish: () => {
      if (sessionIdRef.current) void refreshSession(sessionIdRef.current).then(setMessages);
    },
  });

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session");
    if (sessionId) void refreshSession(sessionId).then(setMessages);
  }, [refreshSession, setMessages]);

  const activeInteractivePrompt = findActiveInteractivePrompt(messages);
  const activePromptId = activeInteractivePrompt?.toolCallId ?? null;
  const showInteractivePrompt = activePromptId !== null && activePromptId !== dismissedPromptId;

  useEffect(() => {
    setDismissedPromptId(null);
  }, [activePromptId]);

  const phaseLabel = session?.phase
    ? session.phase.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : null;

  return (
    <main
      className="flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden bg-[#f7f8fb] text-[#121a31]"
      style={{ fontFamily: "var(--font-fustat)" }}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-[1100px] flex-1 flex-col px-7 py-5">
        {/* Header */}
        <header className="mb-4 shrink-0 flex items-center justify-between gap-4">
          <div>
            <nav className="mb-2 flex items-center gap-2 text-[13px] font-medium text-[#9ca3af]">
              <Link href="/dashboard/loops" className="hover:text-[#111827] transition-colors">Loops</Link>
              <ChevronRight className="size-3.5" />
              <span className="text-[#111827]">New loop</span>
            </nav>
            <div className="flex items-center gap-3">
              <h1
                className="text-[25px] font-bold leading-tight tracking-[-0.02em] text-[#111827]"
                style={{ fontFamily: "var(--font-title)" }}
              >
                Loop Builder
              </h1>
              {phaseLabel && (
                <span
                  className="inline-flex items-center border border-[#b8c9dc] bg-[#f0f4f9] px-2.5 py-1 text-[11px] font-semibold tracking-wide uppercase text-[#334155]"
                >
                  {phaseLabel}
                </span>
              )}
              {session && (
                <button
                  onClick={() => setLogsDialogOpen(true)}
                  className="inline-flex items-center justify-center rounded-full text-[#9ca3af] hover:text-[#111827] hover:bg-black/5 p-1.5 transition-colors"
                  title="View logs and token costs"
                >
                  <Info className="size-5" />
                </button>
              )}
            </div>
          </div>
          {session?.workflowId && (
            <Link
              href={`/dashboard/loops/${session.workflowId}`}
              className="btn-secondary rounded-none h-8 text-[13px] inline-flex items-center gap-1.5"
            >
              View workflow
            </Link>
          )}
        </header>

        {/* Main workspace */}
        <div className="min-h-0 flex-1 flex flex-col overflow-hidden border border-[#d1d5db] bg-white">
          {/* Conversation area */}
          <Conversation>
            <ConversationContent>
              {messages.length === 0 && (
                <LoopBuilderEmptyState status={status} onSend={(text) => sendMessage({ text })} />
              )}
              {messages.map((message) => (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    {message.parts.map((part, index) => {
                      if (part.type === "text") return <MessageResponse key={index}>{part.text}</MessageResponse>;
                      if (isReasoningUIPart(part)) {
                        return (
                          <Reasoning isStreaming={part.state === "streaming"} key={index}>
                            <ReasoningTrigger />
                            <ReasoningContent>{part.text}</ReasoningContent>
                          </Reasoning>
                        );
                      }
                      if (isToolUIPart(part)) {
                        const toolName = getToolName(part);
                        if (toolName === "interactivePrompt") {
                          if (part.state === "input-streaming" || part.state === "input-available") return null;
                          return (
                            <InteractivePromptTool
                              disabled
                              key={index}
                              onSubmit={() => undefined}
                              part={part}
                            />
                          );
                        }
                        if (part.state === "approval-requested" || part.state === "approval-responded" || part.state === "output-denied") {
                          return (
                            <Confirmation approval={part.approval} key={index} state={part.state}>
                              <ConfirmationTitle>Approve <strong>{toolName}</strong>?</ConfirmationTitle>
                              <ConfirmationRequest>
                                <p className="text-sm text-muted-foreground">This operation changes a persisted artifact or workflow.</p>
                              </ConfirmationRequest>
                              <ConfirmationAccepted>Approved.</ConfirmationAccepted>
                              <ConfirmationRejected>Rejected.</ConfirmationRejected>
                              <ConfirmationActions>
                                <ConfirmationAction onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: false })} className="rounded-none border border-[#d1d5db] bg-white text-[#374151] hover:bg-[#fafafa] shadow-none font-medium h-8 px-3">Reject</ConfirmationAction>
                                <ConfirmationAction onClick={() => addToolApprovalResponse({ id: part.approval!.id, approved: true })} className="rounded-none border border-[#1e4070] bg-[#1e4070] text-white hover:bg-[#17355e] font-semibold h-8 px-3">Approve</ConfirmationAction>
                              </ConfirmationActions>
                            </Confirmation>
                          );
                        }
                        if (toolName === "getAvailableTools" && part.state === "output-available") {
                          return <AvailableTools key={index} part={part} />;
                        }
                        return (
                          <Tool defaultOpen key={index}>
                            {part.type === "dynamic-tool"
                              ? <ToolHeader type={part.type} state={part.state} toolName={part.toolName} />
                              : <ToolHeader type={part.type} state={part.state} />}
                            <ToolContent>
                              <ToolInput input={part.input} />
                              <ToolOutput output={part.output} errorText={part.errorText} />
                            </ToolContent>
                          </Tool>
                        );
                      }
                      return null;
                    })}
                  </MessageContent>
                </Message>
              ))}
              {error && <p className="text-sm text-destructive px-4 py-2">{error.message}</p>}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          {/* Composer area */}
          <div className="shrink-0 border-t border-[#e5e7eb] bg-[#fafafa] px-4 py-3">
            <div className="relative overflow-hidden">
              <AnimatePresence initial={false} mode="wait">
                {showInteractivePrompt ? (
                  <motion.div
                    key="interactive-prompt"
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: 8 }}
                    initial={{ opacity: 0, scale: 0.98, y: 16 }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <InteractivePromptTool
                      disabled={status !== "ready"}
                      onDismiss={() => setDismissedPromptId(activeInteractivePrompt!.toolCallId)}
                      onSubmit={(answer) => addToolOutput({
                        tool: "interactivePrompt",
                        toolCallId: activeInteractivePrompt!.toolCallId,
                        output: answer,
                      })}
                      part={activeInteractivePrompt!}
                      placement="composer"
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="prompt-input"
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: 12 }}
                    initial={{ opacity: 0, y: 8 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <PromptInput
                      onSubmit={({ text }) => {
                        if (text.trim()) return sendMessage({ text });
                      }}
                      className="[&>[data-slot=input-group]]:rounded-none [&>[data-slot=input-group]]:border-[#d1d5db] [&>[data-slot=input-group]]:bg-white [&>[data-slot=input-group]]:shadow-none"
                    >
                      <PromptInputTextarea placeholder="Describe the loop, answer a clarification, or request a refinement..." />
                      <PromptInputFooter>
                        <span className="text-xs text-[#9ca3af]">
                          {progress.length > 0
                            ? progress.at(-1)?.message
                            : session
                              ? `Phase: ${session.phase}`
                              : "A new session starts with your first message"}
                        </span>
                        <PromptInputSubmit
                          onStop={stop}
                          status={status}
                          className="rounded-none border border-[#d1d5db] bg-white text-[#374151] hover:bg-[#fafafa] shadow-none transition-colors"
                        />
                      </PromptInputFooter>
                    </PromptInput>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Session error */}
        {session?.error && (
          <div className="mt-3 shrink-0 border border-[#d9a3a3] bg-[#fdf2f2] px-4 py-3 text-[13px] text-[#991b1b]">
            {session.error.message}
          </div>
        )}
      </div>

      <Dialog open={logsDialogOpen} onOpenChange={setLogsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden bg-white text-[#121a31] border border-[#d1d5db] rounded-lg">
          <DialogHeader className="p-6 border-b border-[#e5e7eb] shrink-0">
            <DialogTitle className="text-xl font-bold text-[#111827]">
              Session Logs & Cost Tracker
            </DialogTitle>
            <DialogDescription className="text-sm text-[#6b7280]">
              Real-time execution logs and API token metrics for loop builder session.
            </DialogDescription>
          </DialogHeader>

          {/* Modal body */}
          <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
            {/* Cost section */}
            <div className="bg-[#f8fafc] border border-[#e2e8f0] p-4 rounded-lg">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-[#475569] mb-3">
                Token Cost Summary
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
                <div className="bg-white p-3 border border-[#e2e8f0] rounded">
                  <div className="text-xs text-[#64748b]">Total Calls</div>
                  <div className="text-lg font-bold text-[#0f172a]">{totalUsage.calls}</div>
                </div>
                <div className="bg-white p-3 border border-[#e2e8f0] rounded">
                  <div className="text-xs text-[#64748b]">Prompt Tokens</div>
                  <div className="text-lg font-bold text-[#0f172a]">{totalUsage.promptTokens.toLocaleString()}</div>
                </div>
                <div className="bg-white p-3 border border-[#e2e8f0] rounded">
                  <div className="text-xs text-[#64748b]">Completion Tokens</div>
                  <div className="text-lg font-bold text-[#0f172a]">{totalUsage.completionTokens.toLocaleString()}</div>
                </div>
                <div className="bg-white p-3 border border-[#e2e8f0] rounded">
                  <div className="text-xs text-[#64748b]">Total Tokens</div>
                  <div className="text-lg font-bold text-[#0f172a]">{totalUsage.totalTokens.toLocaleString()}</div>
                </div>
                <div className="bg-white p-3 border border-[#e2e8f0] rounded col-span-2 sm:col-span-1">
                  <div className="text-xs text-[#64748b]">Total Cost (USD)</div>
                  <div className="text-lg font-bold text-[#0f172a]">${totalUsage.estimatedCostUsd.toFixed(6)}</div>
                </div>
              </div>
            </div>

            {/* Execution logs section */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-[#475569]">
                Execution Command History
              </h3>
              {commands.length === 0 ? (
                <p className="text-sm text-[#94a3b8] italic">No commands executed in this session yet.</p>
              ) : (
                <div className="space-y-4">
                  {commands.map((cmd) => {
                    const statusColors = ({
                      pending: "bg-gray-100 text-gray-700 border-gray-200",
                      running: "bg-blue-50 text-blue-700 border-blue-200 animate-pulse",
                      completed: "bg-green-50 text-green-700 border-green-200",
                      failed: "bg-red-50 text-red-700 border-red-200",
                      rejected: "bg-amber-50 text-amber-700 border-amber-200",
                    } as Record<string, string>)[cmd.status] || "bg-gray-50 text-gray-600";

                    return (
                      <div key={cmd.id} className="border border-[#e2e8f0] rounded-lg overflow-hidden bg-white">
                        {/* Command header */}
                        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#f8fafc] px-4 py-3 border-b border-[#e2e8f0] text-sm">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold font-mono text-[#0f172a]">{cmd.toolName}</span>
                            <span className={`px-2 py-0.5 text-xs font-semibold border rounded-full ${statusColors}`}>
                              {cmd.status}
                            </span>
                          </div>
                          <div className="text-xs text-[#64748b]">
                            {new Date(cmd.createdAt).toLocaleTimeString()}
                          </div>
                        </div>

                        {/* Command body */}
                        <div className="p-4 space-y-3">
                          {/* Cost info */}
                          {cmd.usage && (cmd.usage.totalTokens > 0 || cmd.usage.calls > 0) && (
                            <div className="text-xs text-[#64748b] bg-[#f8fafc] p-2 rounded flex flex-wrap gap-x-4 gap-y-1">
                              <span><strong>Calls:</strong> {cmd.usage.calls}</span>
                              <span><strong>Tokens:</strong> {cmd.usage.totalTokens?.toLocaleString()}</span>
                              <span><strong>Cost:</strong> ${cmd.usage.estimatedCostUsd?.toFixed(6)}</span>
                            </div>
                          )}

                          {/* Error text if failed */}
                          {cmd.error && (
                            <div className="text-xs border border-red-100 bg-red-50/50 p-2.5 rounded text-red-700 font-mono whitespace-pre-wrap">
                              <strong>Error:</strong> {cmd.error}
                            </div>
                          )}

                          {/* Events/logs list */}
                          <div className="space-y-1.5">
                            <div className="text-xs font-semibold text-[#475569]">Steps Logs:</div>
                            {(!cmd.events || cmd.events.length === 0) ? (
                              <div className="text-xs text-[#94a3b8] italic">No logs recorded for this command.</div>
                            ) : (
                              <div className="max-h-48 overflow-y-auto space-y-1 bg-gray-50 p-3 rounded font-mono text-xs border border-gray-100">
                                {cmd.events.map((evt: any, i: number) => (
                                  <div key={i} className="flex gap-2 text-[#334155]">
                                    <span className="text-[#94a3b8] shrink-0">
                                      {evt.at ? new Date(evt.at).toLocaleTimeString() : `[Step ${evt.id || i + 1}]`}
                                    </span>
                                    <span className={evt.status === "failed" ? "text-red-600" : ""}>
                                      {evt.message}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function InteractivePromptTool({
  part,
  disabled,
  onSubmit,
  onDismiss,
  placement,
}: {
  part: ToolPart;
  disabled: boolean;
  onSubmit: (answer: InteractivePromptAnswer) => void;
  onDismiss?: () => void;
  placement?: "transcript" | "composer";
}) {
  if (part.state === "input-streaming") {
    return <p className="my-3 text-sm text-muted-foreground">Preparing choices...</p>;
  }
  const input = part.input && typeof part.input === "object" ? part.input as {
    question?: string;
    options?: InteractivePromptOption[];
    recommendedOptionIds?: string[];
    allowMultiple?: boolean;
    allowOther?: boolean;
  } : {};
  const output = part.state === "output-available" && part.output && typeof part.output === "object"
    ? part.output as InteractivePromptAnswer
    : undefined;
  return (
    <InteractivePromptMenu
      allowMultiple={input.allowMultiple}
      allowOther={input.allowOther}
      disabled={disabled || part.state !== "input-available"}
      onDismiss={onDismiss}
      onSubmit={onSubmit}
      options={input.options ?? []}
      placement={placement}
      question={input.question ?? "Choose an option"}
      recommendedOptionIds={input.recommendedOptionIds}
      submittedAnswer={output}
    />
  );
}

function findActiveInteractivePrompt(messages: UIMessage[]): ToolPart | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part && isToolUIPart(part) && getToolName(part) === "interactivePrompt"
        && (part.state === "input-streaming" || part.state === "input-available")) {
        return part;
      }
    }
  }
  return null;
}

function AvailableTools({ part }: { part: ToolPart }) {
  const output = part.output && typeof part.output === "object" ? part.output as { tools?: Array<{
    name?: string;
    description?: string;
    connected?: boolean;
    risk?: string | null;
  }> } : {};
  return (
    <Tool defaultOpen>
      {part.type === "dynamic-tool"
        ? <ToolHeader type={part.type} state={part.state} toolName={part.toolName} />
        : <ToolHeader type={part.type} state={part.state} />}
      <ToolContent>
        <div className="space-y-2 p-3">
          {(output.tools ?? []).length === 0 && <p className="text-sm text-muted-foreground">No external connector actions are required.</p>}
          {(output.tools ?? []).map((item, index) => (
            <div className="border border-[#e5e7eb] bg-[#fafafa] p-3 text-sm" key={`${item.name}-${index}`}>
              <div className="font-semibold text-[#111827]">{item.name ?? "Available tool"}</div>
              <div className="mt-0.5 text-[#6b7280]">{item.description}</div>
              <div className="mt-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">
                {item.connected ? "Connected" : "Connection required"} · Risk: {item.risk ?? "unknown"}
              </div>
            </div>
          ))}
        </div>
      </ToolContent>
    </Tool>
  );
}

function LoopBuilderEmptyState({
  status,
  onSend,
}: {
  status: string;
  onSend: (text: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ctx = gsap.context(() => {
      // Stagger the hero elements in
      gsap.fromTo(
        ".es-hero",
        { opacity: 0, y: 18 },
        { opacity: 1, y: 0, duration: 0.55, ease: "power3.out" },
      );

      // Stagger composer in
      gsap.fromTo(
        ".es-composer",
        { opacity: 0, y: 14 },
        { opacity: 1, y: 0, duration: 0.5, ease: "power3.out", delay: 0.12 },
      );

      // Section label
      gsap.fromTo(
        ".es-section-label",
        { opacity: 0 },
        { opacity: 1, duration: 0.4, ease: "power2.out", delay: 0.25 },
      );

      // Cards stagger in with y + opacity
      gsap.fromTo(
        ".es-card",
        { opacity: 0, y: 22, scale: 0.97 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: 0.48,
          ease: "power3.out",
          stagger: 0.075,
          delay: 0.28,
        },
      );

      // Suggestion chips stagger
      gsap.fromTo(
        ".es-chip",
        { opacity: 0, x: -8 },
        {
          opacity: 1,
          x: 0,
          duration: 0.35,
          ease: "power2.out",
          stagger: 0.06,
          delay: 0.55,
        },
      );
    }, el);

    return () => ctx.revert();
  }, []);

  const handleSubmit = () => {
    if (inputValue.trim() && status === "ready") {
      onSend(inputValue.trim());
      setInputValue("");
    }
  };

  return (
    <div ref={containerRef} className="flex flex-col w-full max-w-3xl mx-auto px-4 pt-8 pb-4 gap-7" style={{ fontFamily: "var(--font-fustat)" }}>

      {/* Hero */}
      <div className="es-hero text-center space-y-2">
        <div
          className="inline-flex items-center justify-center size-11 mb-3 text-white"
          style={{ background: "#111827" }}
        >
          <Wand2 className="size-5" />
        </div>
        <h2
          className="text-[24px] font-bold tracking-[-0.025em] text-[#111827]"
          style={{ fontFamily: "var(--font-title)" }}
        >
          What loop do you want to build?
        </h2>
        <p className="text-[13px] text-[#6b7280] max-w-md mx-auto leading-relaxed">
          Describe it in plain language. The AI analyses intent, discovers the right tools, and builds the workflow.
        </p>
      </div>

      {/* Standalone composer */}
      <div className="es-composer">
        <div className="border border-[#d1d5db] bg-white shadow-sm">
          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="e.g. Send me a weekly digest of Hacker News top stories..."
            rows={3}
            disabled={status !== "ready"}
            className="w-full resize-none bg-transparent px-4 pt-4 pb-2 text-[14px] text-[#111827] placeholder:text-[#9ca3af] outline-none border-none disabled:opacity-60"
            style={{ fontFamily: "var(--font-fustat)" }}
          />
          <div className="flex items-center justify-between px-3 pb-3">
            <span className="text-[11px] text-[#9ca3af]">
              Press <kbd className="border border-[#e5e7eb] bg-[#fafafa] px-1 py-0.5 text-[10px] font-mono">⏎</kbd> to send · <kbd className="border border-[#e5e7eb] bg-[#fafafa] px-1 py-0.5 text-[10px] font-mono">Shift ⏎</kbd> for newline
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!inputValue.trim() || status !== "ready"}
              className="inline-flex items-center gap-1.5 border border-[#111827] bg-[#111827] px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-[#1f2937] transition-colors disabled:opacity-40"
            >
              Build loop <ArrowRight className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Discover loops */}
      <div>
        <div className="es-section-label flex items-center justify-between pb-2.5 border-b border-[#e5e7eb] mb-4">
          <h3
            className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#6b7280]"
            style={{ fontFamily: "var(--font-title)" }}
          >
            Discover Loops
          </h3>
          <div className="flex items-center gap-1 text-[11px] text-[#9ca3af]">
            <Zap className="size-3" />
            <span>Templates</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {TEMPLATES.map((tpl) => {
            const Icon = tpl.icon;
            return (
              <button
                key={tpl.title}
                disabled={status !== "ready"}
                onClick={() => onSend(tpl.prompt)}
                className="es-card group flex flex-col text-left p-4 border transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 disabled:opacity-40"
                style={{
                  background: `linear-gradient(135deg, ${tpl.bgFrom} 0%, ${tpl.bgTo} 100%)`,
                  borderColor: tpl.borderColor,
                }}
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div
                    className="inline-flex items-center justify-center size-8 flex-shrink-0"
                    style={{ background: tpl.iconBg }}
                  >
                    <Icon className="size-4 text-white" />
                  </div>
                  <ArrowRight
                    className="size-3.5 mt-0.5 opacity-0 group-hover:opacity-60 transition-opacity flex-shrink-0"
                    style={{ color: tpl.accentColor }}
                  />
                </div>
                <span
                  className="text-[13px] font-bold tracking-[-0.01em] leading-snug"
                  style={{ fontFamily: "var(--font-title)", color: tpl.accentColor }}
                >
                  {tpl.title}
                </span>
                <p
                  className="mt-1.5 text-[11.5px] leading-relaxed font-medium opacity-80"
                  style={{ color: tpl.accentColor }}
                >
                  {tpl.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Quick suggestions */}
      <div className="flex flex-wrap gap-2 pb-2">
        {SUGGESTIONS.map((sug) => (
          <button
            key={sug.label}
            disabled={status !== "ready"}
            onClick={() => onSend(sug.prompt)}
            className="es-chip border border-[#d1d5db] bg-white px-3 py-1.5 text-[12px] font-medium text-[#374151] hover:bg-[#f3f4f6] hover:border-[#9ca3af] transition-all disabled:opacity-40"
          >
            {sug.label}
          </button>
        ))}
      </div>

    </div>
  );
}
