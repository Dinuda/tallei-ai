"use client";

import type { ComponentType, ReactNode } from "react";
import {
  Bot,
  Brain,
  CheckCircle2,
  FileCheck,
  GitBranch,
  DoorClosed,
  Info,
  PenLine,
  RefreshCw,
  Search,
  Sparkles,
  UserPlus,
  XCircle,
  type LucideProps,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { EditorialMetaTag } from "./editorial-run-ui";

type AgentSnapshot = {
  id?: string;
  name?: string;
  task?: string;
  tools?: Array<{ ref: string }>;
};

type StepLike = {
  id: string;
  step_index: number;
  agent_id: string;
  agent_snapshot: AgentSnapshot;
  attempt: number;
  status: string;
  output_json?: { data?: Record<string, unknown> };
};

type RunDefinition = {
  agentGraph?: {
    children?: Array<{ id: string; name?: string; task?: string; tools?: Array<{ ref: string }> }>;
  };
};

export type StepRowPhase =
  | "current_gate"
  | "current_running"
  | "running"
  | "done"
  | "queued"
  | "failed"
  | "idle";

export type ParentRunPhase = "paused" | "running" | "blocked" | "done" | "idle";

type AgentIconSpec = {
  Icon: ComponentType<LucideProps>;
  boxClass: string;
};

export function formatWorkerDisplayName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "Agent";

  if (/\bworker\b/i.test(trimmed)) {
    return trimmed.replace(/\bworkers?\b/gi, (match) => (
      match.toLowerCase() === "workers" ? "Agents" : "Agent"
    ));
  }
  if (/\bagent\b/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} Agent`;
}

/** @deprecated Use formatWorkerDisplayName */
export const formatAgentDisplayName = formatWorkerDisplayName;

export function formatSupervisorDisplayName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || /^parent\s*agent$/i.test(trimmed)) return "Tallei Agent";
  if (/\borchestrator\b/i.test(trimmed)) return trimmed;
  if (/\bsupervisor\b/i.test(trimmed)) return trimmed.replace(/\bsupervisor\b/gi, "Orchestrator");
  if (/\bagent\b/i.test(trimmed)) {
    return trimmed.replace(/\bagents?\b/gi, "Orchestrator");
  }
  return `${trimmed} Orchestrator`;
}

export function workerSlotLabel(stepIndex: number, rawName: string) {
  return `Agent ${stepIndex + 1} · ${formatWorkerDisplayName(rawName)}`;
}

export function resolveStepToolRefs(step: StepLike, definition?: RunDefinition | null): string[] {
  const snapshotTools = step.agent_snapshot.tools?.map((tool) => tool.ref).filter(Boolean) ?? [];
  if (snapshotTools.length > 0) return snapshotTools;

  const child = definition?.agentGraph?.children?.find((entry) => entry.id === step.agent_id);
  const childTools = child?.tools?.map((tool) => tool.ref).filter(Boolean) ?? [];
  if (childTools.length > 0) return childTools;

  const mode = String(step.output_json?.data?.mode ?? "").toLowerCase();
  if (mode.includes("memory")) return ["internal.memory_search"];

  const source = `${step.agent_snapshot.name ?? ""} ${step.agent_snapshot.task ?? ""}`.toLowerCase();
  if (source.includes("memory") || source.includes("search") || source.includes("recall")) {
    return ["internal.memory_search"];
  }

  return ["internal.llm_only"];
}

export function resolveChildAgentIcon(step: StepLike, phase?: StepRowPhase): AgentIconSpec {
  const source = `${step.agent_snapshot.name ?? ""} ${step.agent_snapshot.task ?? ""}`.toLowerCase();

  if (step.status === "failed" || step.status === "cancelled" || phase === "failed") {
    return { Icon: XCircle, boxClass: "border-[#fca5a5] bg-[#fef2f2] text-[#b91c1c]" };
  }
  // if (step.status === "waiting_for_gate") {
  //   return { Icon: DoorClosed, boxClass: "border-[#f59e0b] bg-[#fffbeb] text-[#b45309]" };
  // }
  if (source.includes("memory") || source.includes("search") || source.includes("recall")) {
    return { Icon: Search, boxClass: iconBoxForPhase(phase, "search") };
  }
  if (source.includes("input") || source.includes("validat") || source.includes("checker")) {
    return { Icon: FileCheck, boxClass: iconBoxForPhase(phase, "default") };
  }
  if (source.includes("draft") || source.includes("write") || source.includes("content")) {
    return { Icon: PenLine, boxClass: iconBoxForPhase(phase, "default") };
  }
  if (step.status === "succeeded" || phase === "done") {
    return { Icon: CheckCircle2, boxClass: "border-[#86c8a8] bg-[#edf8f2] text-[#166534]" };
  }
  if (step.status === "running" || phase === "current_running" || phase === "running") {
    return { Icon: Bot, boxClass: "border-[#93c5fd] bg-[#eff6ff] text-[#1d4ed8]" };
  }
  return { Icon: Bot, boxClass: iconBoxForPhase(phase, "default") };
}

function iconBoxForPhase(phase: StepRowPhase | undefined, kind: "search" | "default") {
  if (phase === "current_gate") return "border-[#f59e0b] bg-[#fffbeb] text-[#b45309]";
  if (phase === "current_running" || phase === "running") {
    return kind === "search"
      ? "border-[#93c5fd] bg-[#eff6ff] text-[#1d4ed8]"
      : "border-[#93c5fd] bg-[#eff6ff] text-[#1d4ed8]";
  }
  if (phase === "done") return "border-[#86c8a8] bg-[#edf8f2] text-[#166534]";
  if (phase === "queued") return "border-[#e5e7eb] bg-[#fafafa] text-[#9ca3af]";
  return "border-[#d1d5db] bg-white text-[#4b5563]";
}

export function AgentIconBox({ Icon, boxClass }: AgentIconSpec) {
  return (
    <div className={cn("grid size-14 shrink-0 place-items-center border-none", boxClass)}>
      <Icon className="size-5" strokeWidth={2} />
    </div>
  );
}

export function LegendaryToolBadge({ toolRef }: { toolRef: string }) {
  if (toolRef === "internal.llm_only") {
    return (
      <span
        className="inline-flex items-center gap-1.5  border border-[#c4b5fd] bg-[#f5f3ff] px-2 py-1 text-[#5b21b6]"
        title="LLM"
      >
        <span className="grid size-4 place-items-center rounded-sm border border-[#ddd6fe] bg-white">
          <Sparkles className="size-3" strokeWidth={2} />
        </span>
        <span className="text-[10px] font-bold tracking-[0.08em] uppercase" style={{ fontFamily: "var(--font-title)" }}>
          LLM
        </span>
      </span>
    );
  }

  if (toolRef === "internal.memory_search") {
    return (
      <span
        className="inline-flex items-center gap-1.5  border border-[#9bb8d9] bg-[#edf3fb] px-2 py-1 text-[#1e4070]"
        title="Memory"
      >
        <span className="grid size-4 place-items-center rounded-sm border border-[#bfdbfe] bg-white">
          <Brain className="size-3" strokeWidth={2} />
        </span>
        <span className="text-[10px] font-bold tracking-[0.08em] uppercase" style={{ fontFamily: "var(--font-title)" }}>
          Memory
        </span>
      </span>
    );
  }

  const label = toolRef.split(".").pop()?.replace(/_/g, " ") ?? "tool";
  return (
    <span className="inline-flex items-center gap-1  border border-[#e5e7eb] bg-[#fafafa] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#6b7280]">
      {label}
    </span>
  );
}

export function AttemptChip({ attempt }: { attempt: number }) {
  return (
    <span className="inline-flex items-center gap-1  border border-[#e5e7eb] bg-white px-2 py-1">
      <span className="font-mono text-[9px] font-bold tracking-wider text-[#9ca3af]">RUN</span>
      <span className="font-mono text-[11px] font-bold text-[#374151]">{attempt}</span>
    </span>
  );
}

function StepPhaseTag({ phase }: { phase: StepRowPhase }) {
  if (phase === "current_gate") return <EditorialMetaTag tone="amber">Paused · Needs approval</EditorialMetaTag>;
  if (phase === "current_running") return <EditorialMetaTag tone="blue">Current · running</EditorialMetaTag>;
  if (phase === "running") return <EditorialMetaTag tone="blue">Running</EditorialMetaTag>;
  if (phase === "done") return <EditorialMetaTag>Done</EditorialMetaTag>;
  if (phase === "queued") return <EditorialMetaTag>Up next</EditorialMetaTag>;
  if (phase === "failed") return <EditorialMetaTag tone="red">Failed</EditorialMetaTag>;
  return <EditorialMetaTag>Waiting</EditorialMetaTag>;
}

function RunningIndicator() {
  return (
    <span className="inline-flex items-center" aria-label="Running">
      <span
        className="agent-running-underscore text-[16px] font-semibold leading-none text-[#8ca0ff]"
        style={{ fontFamily: "var(--font-title)" }}
      >
        _
      </span>
    </span>
  );
}

function AgentPanelAnimationStyles() {
  return (
    <style jsx global>{`
      @keyframes agent-running-underscore {
        0%, 100% {
          opacity: 0.2;
          filter: drop-shadow(0 0 0 rgba(140, 160, 255, 0));
          transform: translateY(0);
        }
        50% {
          opacity: 1;
          filter: drop-shadow(0 0 6px rgba(140, 160, 255, 0.8));
          transform: translateY(-1px);
        }
      }

      @keyframes agent-name-shimmer {
        0% { background-position: 140% 50%; }
        100% { background-position: -40% 50%; }
      }

      .agent-name-shimmer {
        background-image: linear-gradient(90deg, #111827 0%, #8ca0ff 42%, #c7d2fe 50%, #8ca0ff 58%, #111827 100%);
        background-size: 220% 100%;
        color: transparent;
        -webkit-background-clip: text;
        background-clip: text;
        animation: agent-name-shimmer 2.4s ease-in-out infinite;
      }

      .agent-running-underscore {
        animation: agent-running-underscore 1.1s ease-in-out infinite;
      }
    `}</style>
  );
}

function ParentRunBadge({ phase }: { phase: ParentRunPhase }) {
  if (phase === "paused") {
    return (
      <span className="border border-[#f59e0b] bg-[#fef3c7] px-2 py-0.5 text-[10px] font-bold tracking-[0.08em] text-[#92400e] uppercase">
        Paused · Needs approval
      </span>
    );
  }
  if (phase === "running") return <EditorialMetaTag tone="blue">Coordinating</EditorialMetaTag>;
  if (phase === "blocked") return <EditorialMetaTag tone="red">Blocked</EditorialMetaTag>;
  if (phase === "done") return <EditorialMetaTag>Complete</EditorialMetaTag>;
  return null;
}

export function ParentAgentRow({
  parentName,
  roster,
  statusLine,
  parentRunPhase,
  onSelect,
  onInfo,
  onHire,
}: {
  parentName: string;
  roster: string;
  statusLine: string;
  parentRunPhase: ParentRunPhase;
  onSelect: () => void;
  onInfo: () => void;
  onHire: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="relative flex w-full items-start gap-3 border-b border-[#e5e7eb] bg-white px-5 py-4 pr-10 text-left transition-colors hover:bg-[#fafafa]"
    >
      <AgentIconBox
        Icon={GitBranch}
        boxClass="border-[#d1d5db] bg-[#fafafa] text-[#4b5563]"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-semibold tracking-[0.14em] text-[#9ca3af] uppercase">
              Orchestrator
            </p>
            <p
              className="truncate text-[15px] font-bold text-[#111827]"
              style={{ fontFamily: "var(--font-title)" }}
            >
              {parentName}
            </p>
          </div>
          <ParentRunBadge phase={parentRunPhase} />
        </div>
        <p className="mt-0.5 text-[11px] text-[#6b7280]">{roster}</p>
        <p className="mt-1.5 text-[12px] leading-5 text-[#6b7280]">{statusLine}</p>
      </div>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onHire();
        }}
        className="absolute right-3 top-3 grid size-7 place-items-center text-[#2563eb] transition-colors hover:text-[#1d4ed8]"
        title="Hire this orchestrator"
      >
        <UserPlus className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onInfo();
        }}
        className="absolute right-3 top-10 shrink-0 p-1 text-[#9ca3af] transition-colors hover:text-[#6b7280]"
      >
        <Info className="size-3.5" />
      </button>
    </button>
  );
}

export function ChildAgentsHeader({ count }: { count: number }) {
  return (
    <div className="flex items-center justify-between border-b border-[#e5e7eb] bg-[#f4f4f5] px-5 py-2">
      <p className="font-mono text-[10px] font-semibold tracking-[0.12em] text-[#6b7280] uppercase">
        Agents
      </p>
      <p className="font-mono text-[10px] text-[#9ca3af]">{count}</p>
    </div>
  );
}

export function ChildAgentRow({
  step,
  phase,
  selected,
  isCurrent,
  canRetry: canRetryProp,
  toolRefs,
  onSelect,
  onInfo,
  onHire,
  onRerun,
}: {
  step: StepLike;
  phase: StepRowPhase;
  selected: boolean;
  isCurrent: boolean;
  canRetry?: boolean;
  toolRefs: string[];
  onSelect: () => void;
  onInfo: () => void;
  onHire: () => void;
  onRerun: () => void;
}) {
  const canRetry = canRetryProp ?? (step.status === "failed" || step.status === "cancelled");
  const displayName = formatWorkerDisplayName(step.agent_snapshot.name ?? step.agent_id);
  const icon = resolveChildAgentIcon(step, phase);
  const isRunning = phase === "current_running" || phase === "running";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative flex w-full items-start gap-3 border-b border-[#e5e7eb] px-5 py-3.5 pr-10 text-left transition-colors last:border-b-0",
        isCurrent && phase === "current_gate" && "bg-[#fffbeb] ring-2 ring-inset ring-[#f9a8d4]",
        isCurrent && phase === "current_running" && "bg-[#eff6ff] ring-2 ring-inset ring-[#f9a8d4]",
        isCurrent && phase !== "current_gate" && phase !== "current_running" && "bg-[#f8fbff] ring-2 ring-inset ring-[#f9a8d4]",
        !isCurrent && "bg-white hover:bg-[#fafafa]",
        selected && !isCurrent && "ring-2 ring-inset ring-[#f9a8d4]",
      )}
    >
      <AgentPanelAnimationStyles />
      <AgentIconBox {...icon} />

      <div className="min-w-0 flex-1">
        <div className="pr-20">
          <div className="flex min-w-0 items-center gap-2">
            <p
              className={cn(
                "truncate text-[14px] font-semibold text-[#111827]",
                isRunning && "agent-name-shimmer",
              )}
              style={{ fontFamily: "var(--font-title)" }}
            >
              {displayName}
            </p>
            {isRunning ? <RunningIndicator /> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <AttemptChip attempt={step.attempt} />
            {toolRefs.map((toolRef) => (
              <LegendaryToolBadge key={`${step.id}-${toolRef}`} toolRef={toolRef} />
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onHire();
          }}
          className="absolute right-2 top-2 grid size-7 place-items-center text-[#2563eb] transition-colors hover:text-[#1d4ed8]"
          title={`Hire ${displayName}`}
        >
          <UserPlus className="size-3.5" />
        </button>
        <div className="absolute right-2 top-10 flex shrink-0 items-start gap-1.5">
          <div className="mt-0.5 flex items-center gap-2">
            {canRetry ? (
              <button
                type="button"
                title="Retry agent"
                onClick={(event) => {
                  event.stopPropagation();
                  onRerun();
                }}
                className="p-1 text-[#6b7280] transition-colors hover:text-[#111827]"
              >
                <RefreshCw className="size-3.5" strokeWidth={2} />
              </button>
            ) : null}
            <StepPhaseTag phase={phase} />
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onInfo();
            }}
            className="shrink-0 p-1.5 text-[#9ca3af] transition-colors hover:text-[#6b7280]"
          >
            <Info className="size-3.5" />
          </button>
        </div>
      </div>
    </button>
  );
}

export function ChildAgentsShell({ children }: { children: ReactNode }) {
  return (
    <div className="border-t border-[#e5e7eb] bg-[#fafafa]">
      {children}
    </div>
  );
}
