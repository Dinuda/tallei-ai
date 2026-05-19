"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Code2,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  Play,
  Save,
  Settings2,
  Sparkles,
  Terminal as TerminalIcon,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageToolbar,
  MessageAction,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
} from "@/components/ai-elements/prompt-input";
import { Plan, PlanHeader, PlanTitle, PlanDescription, PlanContent, PlanTrigger } from "@/components/ai-elements/plan";
import {
  Queue,
  QueueItem,
  QueueItemIndicator,
  QueueItemContent,
  QueueItemDescription,
  QueueSection,
  QueueSectionTrigger,
  QueueSectionLabel,
  QueueSectionContent,
} from "@/components/ai-elements/queue";
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/components/ai-elements/checkpoint";

type AgentRole = "builder" | "critic" | "assistant";

interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  reasoning?: string;
  timestamp: Date;
}

interface QueueTask {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "completed";
  agent?: AgentRole;
}

interface PlanStep {
  title: string;
  description: string;
  status: "pending" | "in-progress" | "completed";
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

const AGENT_CONFIG: Record<AgentRole, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  builder: {
    label: "Builder",
    color: "text-indigo-700",
    bg: "bg-indigo-50",
    icon: <Wrench className="h-3.5 w-3.5" />,
  },
  critic: {
    label: "Critic",
    color: "text-amber-700",
    bg: "bg-amber-50",
    icon: <Settings2 className="h-3.5 w-3.5" />,
  },
  assistant: {
    label: "Assistant",
    color: "text-emerald-700",
    bg: "bg-emerald-50",
    icon: <Sparkles className="h-3.5 w-3.5" />,
  },
};

const MOCK_PLAN: PlanStep[] = [
  { title: "Define trigger & schedule", description: "Set up the workflow trigger conditions", status: "completed" },
  { title: "Gather data sources", description: "Connect to required data sources", status: "in-progress" },
  { title: "Generate output template", description: "Create the output format and structure", status: "pending" },
  { title: "Configure approval flow", description: "Set up human-in-the-loop approval", status: "pending" },
];

const MOCK_QUEUE: QueueTask[] = [
  { id: "1", title: "Parse email templates", description: "Extract variables from source emails", status: "completed", agent: "builder" },
  { id: "2", title: "Validate data schema", description: "Check source data matches expected format", status: "completed", agent: "critic" },
  { id: "3", title: "Build output formatter", description: "Create markdown to HTML converter", status: "pending", agent: "builder" },
  { id: "4", title: "Test edge cases", description: "Verify behavior with missing data", status: "pending", agent: "critic" },
];

const MOCK_AGENT_MESSAGES: AgentMessage[] = [
  {
    id: "1",
    role: "builder",
    content: "I'll start by setting up the trigger. Based on the requirements, we need a weekly cron job that runs every Monday at 9am. I'm pulling the email templates from the connected Gmail account.",
    timestamp: new Date(Date.now() - 300000),
  },
  {
    id: "2",
    role: "critic",
    content: "Wait — we should handle timezone properly. The user is in PST, so 9am PST means we need to account for DST changes. Also, what happens if the Gmail API returns rate limits?",
    reasoning: "Checking timezone handling and API rate limit scenarios. The current plan doesn't account for daylight saving time transitions which could shift the execution time by an hour.",
    timestamp: new Date(Date.now() - 240000),
  },
  {
    id: "3",
    role: "builder",
    content: "Good catch. I'll use `cron-tz` for timezone-aware scheduling and add exponential backoff for rate limits. Let me update the config...",
    timestamp: new Date(Date.now() - 180000),
  },
  {
    id: "4",
    role: "assistant",
    content: "I found a similar workflow pattern in the user's history — the \"Friday Newsletter\" loop uses the same Gmail + template pattern. We could reuse that data source configuration.",
    timestamp: new Date(Date.now() - 120000),
  },
];

export default function WorkflowConversationPage() {
  const params = useParams();
  const router = useRouter();
  const workflowId = params.id as string;
  const isNew = workflowId === "new";

  const [activeTab, setActiveTab] = useState("plan");
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentMessages] = useState<AgentMessage[]>(MOCK_AGENT_MESSAGES);
  const [planSteps] = useState<PlanStep[]>(MOCK_PLAN);
  const [queueTasks] = useState<QueueTask[]>(MOCK_QUEUE);
  const [showPlan, setShowPlan] = useState(true);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "init",
      role: "user",
      content: "Create a weekly digest workflow that pulls from my Gmail and sends a summary every Monday",
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);

  const completedTasks = queueTasks.filter((t) => t.status === "completed").length;
  const pendingTasks = queueTasks.filter((t) => t.status === "pending").length;

  const handleSend = async (message: { text: string; files: unknown[] }) => {
    if (!message.text.trim()) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message.text,
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const res = await fetch(`/api/workflows/builder/sessions/${workflowId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message.text }),
      });
      const data = await res.json();
      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: data.content || "Got it, working on that now.",
      };
      setChatMessages((prev) => [...prev, assistantMsg]);
    } catch {
      const errorMsg: ChatMessage = {
        id: `error-${Date.now()}`,
        role: "assistant",
        content: "Sorry, I ran into an error. Please try again.",
      };
      setChatMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <TooltipProvider>
      <div className="flex h-[calc(100vh-3.5rem)] flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon-sm" onClick={() => router.push("/dashboard/workflows")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-sm font-medium text-slate-900">
                {isNew ? "New Workflow" : "Weekly Digest Builder"}
              </h1>
              <p className="text-xs text-slate-500">
                {agentMessages.length} messages · 3 agents collaborating
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="rounded-none border-slate-200 text-slate-600 hover:bg-slate-50">
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  Save
                </Button>
              </TooltipTrigger>
              <TooltipContent>Save workflow draft</TooltipContent>
            </Tooltip>
            <Button size="sm" className="rounded-none bg-indigo-600 text-white hover:bg-indigo-700">
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Deploy
            </Button>
          </div>
        </div>

        {/* Main content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Chat panel */}
          <div className="flex flex-1 flex-col overflow-hidden lg:w-[55%]">
            <Conversation className="flex-1">
              <ConversationContent>
                {chatMessages.length === 0 && (
                  <ConversationEmptyState
                    icon={<MessageSquare className="h-8 w-8 text-slate-300" />}
                    title="Start building a workflow"
                    description="Describe what you want to automate. The AI team will collaborate to build it."
                  />
                )}

                {chatMessages.map((msg) => (
                  <Message key={msg.id} from={msg.role}>
                    <MessageContent>
                      {msg.role === "assistant" && msg.reasoning ? (
                        <>
                          <Reasoning isStreaming={isLoading}>
                            <ReasoningTrigger />
                            <ReasoningContent>{msg.reasoning}</ReasoningContent>
                          </Reasoning>
                          <MessageResponse>{msg.content}</MessageResponse>
                        </>
                      ) : (
                        <MessageResponse>{msg.content}</MessageResponse>
                      )}
                    </MessageContent>
                    {msg.role === "assistant" && (
                      <MessageToolbar>
                        <MessageAction tooltip="Copy">
                          <FileText className="h-3.5 w-3.5" />
                        </MessageAction>
                      </MessageToolbar>
                    )}
                  </Message>
                ))}

                {isLoading && (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Agents are working...</span>
                  </div>
                )}
              </ConversationContent>
            </Conversation>

            {/* Input */}
            <div className="border-t border-slate-200 bg-white p-4">
              <PromptInput onSubmit={handleSend}>
                <PromptInputTextarea
                  placeholder="Describe what you want to build or refine..."
                  className="rounded-none border-slate-200 focus-visible:ring-indigo-500"
                />
                <PromptInputFooter>
                  <PromptInputTools>
                    <PromptInputButton tooltip="Add context">
                      <Globe className="h-4 w-4" />
                    </PromptInputButton>
                    <PromptInputButton tooltip="Add code">
                      <Code2 className="h-4 w-4" />
                    </PromptInputButton>
                  </PromptInputTools>
                  <PromptInputSubmit
                    status={isLoading ? "submitted" : "ready"}
                    className="rounded-none bg-indigo-600 text-white hover:bg-indigo-700"
                  />
                </PromptInputFooter>
              </PromptInput>
            </div>
          </div>

          {/* Right: IDE panel */}
          <div className="flex flex-col overflow-hidden border-l border-slate-200 bg-slate-50 lg:w-[45%]">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col">
              {/* Tab bar */}
              <div className="flex items-center gap-1 border-b border-slate-200 bg-white px-3 py-1.5">
                <TabsList className="h-7 rounded-none bg-transparent p-0">
                  <TabsTrigger
                    value="plan"
                    className="rounded-none data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-indigo-600 data-[state=active]:text-indigo-700 text-xs text-slate-500"
                  >
                    <FileText className="mr-1.5 h-3.5 w-3.5" />
                    Plan
                  </TabsTrigger>
                  <TabsTrigger
                    value="agents"
                    className="rounded-none data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-indigo-600 data-[state=active]:text-indigo-700 text-xs text-slate-500"
                  >
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    Agents
                  </TabsTrigger>
                  <TabsTrigger
                    value="queue"
                    className="rounded-none data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-indigo-600 data-[state=active]:text-indigo-700 text-xs text-slate-500"
                  >
                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                    Queue
                  </TabsTrigger>
                  <TabsTrigger
                    value="terminal"
                    className="rounded-none data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-indigo-600 data-[state=active]:text-indigo-700 text-xs text-slate-500"
                  >
                    <TerminalIcon className="mr-1.5 h-3.5 w-3.5" />
                    Terminal
                  </TabsTrigger>
                </TabsList>
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-auto p-4">
                <TabsContent value="plan" className="mt-0">
                  <div className="space-y-4">
                    <Plan isStreaming={isStreaming} defaultOpen={showPlan} onOpenChange={setShowPlan}>
                      <PlanHeader>
                        <div>
                          <PlanTitle>Weekly Digest Workflow</PlanTitle>
                          <PlanDescription>
                            Automated email digest from Gmail, delivered every Monday at 9am PST
                          </PlanDescription>
                        </div>
                        <PlanTrigger />
                      </PlanHeader>
                      <PlanContent>
                        <div className="space-y-3 pt-2">
                          {planSteps.map((step, i) => (
                            <div key={i} className="flex items-start gap-3">
                              <div
                                className={cn(
                                  "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs",
                                  step.status === "completed"
                                    ? "bg-emerald-100 text-emerald-700"
                                    : step.status === "in-progress"
                                      ? "bg-indigo-100 text-indigo-700"
                                      : "bg-slate-100 text-slate-400"
                                )}
                              >
                                {step.status === "completed" ? (
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                ) : (
                                  i + 1
                                )}
                              </div>
                              <div>
                                <p
                                  className={cn(
                                    "text-sm font-medium",
                                    step.status === "completed"
                                      ? "text-slate-900"
                                      : step.status === "in-progress"
                                        ? "text-indigo-700"
                                        : "text-slate-500"
                                  )}
                                >
                                  {step.title}
                                </p>
                                <p className="text-xs text-slate-500">{step.description}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </PlanContent>
                    </Plan>

                    <Separator />

                    <Checkpoint>
                      <CheckpointIcon />
                      <span className="text-xs">Checkpoint saved · 2 min ago</span>
                      <CheckpointTrigger tooltip="Restore" className="ml-auto">
                        Restore
                      </CheckpointTrigger>
                    </Checkpoint>
                  </div>
                </TabsContent>

                <TabsContent value="agents" className="mt-0">
                  <div className="space-y-3">
                    {agentMessages.map((msg) => {
                      const config = AGENT_CONFIG[msg.role];
                      return (
                        <div key={msg.id} className="rounded-lg border border-slate-200 bg-white p-3">
                          <div className="mb-2 flex items-center gap-2">
                            <span className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium", config.bg, config.color)}>
                              {config.icon}
                              {config.label}
                            </span>
                            <span className="text-xs text-slate-400">
                              {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          </div>
                          <p className="text-sm text-slate-700">{msg.content}</p>
                          {msg.reasoning && (
                            <details className="mt-2 rounded bg-slate-50 p-2 text-xs text-slate-500">
                              <summary className="cursor-pointer font-medium text-slate-600">Reasoning</summary>
                              <p className="mt-1">{msg.reasoning}</p>
                            </details>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </TabsContent>

                <TabsContent value="queue" className="mt-0">
                  <Queue>
                    <QueueSection defaultOpen>
                      <QueueSectionTrigger>
                        <QueueSectionLabel
                          count={completedTasks}
                          label="completed"
                          icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
                        />
                      </QueueSectionTrigger>
                      <QueueSectionContent>
                        <div className="mt-2 space-y-1">
                          {queueTasks
                            .filter((t) => t.status === "completed")
                            .map((task) => (
                              <QueueItem key={task.id}>
                                <div className="flex items-center gap-2">
                                  <QueueItemIndicator completed />
                                  <QueueItemContent completed>{task.title}</QueueItemContent>
                                  {task.agent && (
                                    <span className={cn("rounded px-1 py-0.5 text-[10px] font-medium", AGENT_CONFIG[task.agent].bg, AGENT_CONFIG[task.agent].color)}>
                                      {AGENT_CONFIG[task.agent].label}
                                    </span>
                                  )}
                                </div>
                                {task.description && (
                                  <QueueItemDescription completed>{task.description}</QueueItemDescription>
                                )}
                              </QueueItem>
                            ))}
                        </div>
                      </QueueSectionContent>
                    </QueueSection>

                    <QueueSection defaultOpen>
                      <QueueSectionTrigger>
                        <QueueSectionLabel
                          count={pendingTasks}
                          label="pending"
                          icon={<Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600" />}
                        />
                      </QueueSectionTrigger>
                      <QueueSectionContent>
                        <div className="mt-2 space-y-1">
                          {queueTasks
                            .filter((t) => t.status === "pending")
                            .map((task) => (
                              <QueueItem key={task.id}>
                                <div className="flex items-center gap-2">
                                  <QueueItemIndicator />
                                  <QueueItemContent>{task.title}</QueueItemContent>
                                  {task.agent && (
                                    <span className={cn("rounded px-1 py-0.5 text-[10px] font-medium", AGENT_CONFIG[task.agent].bg, AGENT_CONFIG[task.agent].color)}>
                                      {AGENT_CONFIG[task.agent].label}
                                    </span>
                                  )}
                                </div>
                                {task.description && (
                                  <QueueItemDescription>{task.description}</QueueItemDescription>
                                )}
                              </QueueItem>
                            ))}
                        </div>
                      </QueueSectionContent>
                    </QueueSection>
                  </Queue>
                </TabsContent>

                <TabsContent value="terminal" className="mt-0">
                  <div className="rounded-lg border border-slate-800 bg-zinc-950 font-mono text-sm text-zinc-100">
                    <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
                      <div className="flex items-center gap-2 text-zinc-400">
                        <TerminalIcon className="h-4 w-4" />
                        <span>Build Output</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                        <span className="text-xs text-zinc-500">Running</span>
                      </div>
                    </div>
                    <div className="max-h-80 overflow-auto p-4">
                      <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed">
{`$ tallei workflow build --id weekly-digest

[builder] Parsing email templates...
[builder] Found 3 templates in Gmail
[builder] Extracted variables: {name, date, summary}

[critic] Validating data schema...
[critic] Schema matches expected format ✓
[critic] Warning: timezone not specified, defaulting to UTC

[builder] Applying timezone fix: PST with DST handling
[builder] Adding exponential backoff for rate limits

[assistant] Found similar pattern: "Friday Newsletter" loop
[assistant] Reusing data source configuration

[builder] Building output formatter...
[builder] Markdown → HTML converter ready

[critic] Testing edge cases...
[critic] Missing data handling: ✓
[critic] Empty inbox handling: ✓

✓ Workflow build complete
  Trigger: cron(0 9 * * 1) PST
  Sources: Gmail (connected)
  Output: HTML email digest
  Approval: enabled`}
                      </pre>
                    </div>
                  </div>
                </TabsContent>
              </div>
            </Tabs>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
