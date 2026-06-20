"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Loader2, Users, XCircle } from "lucide-react";

import type { ToolPart } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import { AgentPersonaCard } from "./agent-persona-card";
import type { AgentPersonaUi } from "./agent-persona";
import { toolRefsToLabels } from "./agent-persona";

type SpawnAgentDetails = {
  agentIndex?: number;
  persona?: AgentPersonaUi;
  inferredActions?: string[];
};

type BuilderCommand = {
  toolName?: string;
  status?: string;
  error?: string;
  events?: Array<{
    stage?: string;
    message?: string;
    status?: string;
    details?: SpawnAgentDetails;
  }>;
};

type SpecAgent = {
  name?: string;
  goal?: string;
  tools?: string[];
  persona?: AgentPersonaUi;
};

type SaveLoopOutput = {
  spec?: {
    specJson?: {
      purpose?: string;
      agents?: SpecAgent[];
    };
  };
  preview?: boolean;
};

function readLatestSpawnCommand(commands: BuilderCommand[]): BuilderCommand | null {
  const relevantTools = new Set(["saveLoop", "refineSpec", "draftSpec"]);
  return [...commands]
    .reverse()
    .find((command) => relevantTools.has(command.toolName ?? "") && ["running", "failed", "rejected"].includes(command.status ?? ""))
    ?? null;
}

function readSpawnEvents(commands: BuilderCommand[]): SpawnAgentDetails[] {
  const command = readLatestSpawnCommand(commands);
  if (!command?.events) return [];

  const byIndex = new Map<number, SpawnAgentDetails>();
  for (const event of command.events) {
    if (event.stage !== "agent_spawn" || event.status !== "completed") continue;
    const index = event.details?.agentIndex;
    if (typeof index !== "number" || !event.details?.persona) continue;
    byIndex.set(index, event.details);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, details]) => details);
}

function readOutputAgents(output: unknown): { purpose: string; agents: Array<{ goal: string; persona: AgentPersonaUi; actions: string[] }> } {
  const payload = output as SaveLoopOutput;
  const purpose = payload.spec?.specJson?.purpose ?? "";
  const agents = (payload.spec?.specJson?.agents ?? [])
    .filter((agent): agent is SpecAgent & { persona: AgentPersonaUi } => Boolean(agent.persona?.displayName))
    .map((agent) => ({
      goal: agent.goal ?? "",
      persona: agent.persona,
      actions: toolRefsToLabels(agent.tools ?? []),
    }));
  return { purpose, agents };
}

type BuilderAgentSpawnPanelProps = {
  part: ToolPart;
  commands: BuilderCommand[];
};

function readToolRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Spec draft only — not save/verify (saveLoop without preview). */
export function isSpecDraftSpawnTool(toolName: string, part: ToolPart): boolean {
  if (toolName === "refineSpec" || toolName === "draftSpec") return true;
  if (toolName !== "saveLoop") return false;

  const input = readToolRecord(part.input);
  if (input.preview === true) return true;

  const output = readToolRecord(part.output);
  if (output.preview === true && output.spec) return true;

  return false;
}

export function BuilderAgentSpawnPanel({ part, commands }: BuilderAgentSpawnPanelProps) {
  const isComplete = part.state === "output-available";
  const outputData = isComplete ? readOutputAgents(part.output) : null;
  const liveSpawnEvents = useMemo(() => readSpawnEvents(commands), [commands]);
  const latestCommand = useMemo(() => readLatestSpawnCommand(commands), [commands]);
  const isFailed = !isComplete && (
    part.state === "output-error" || latestCommand?.status === "failed" || latestCommand?.status === "rejected"
  );
  const errorText = part.errorText ?? latestCommand?.error ?? "The spec draft did not complete. Please try again.";
  const latestProgressMessage = latestCommand?.events?.at(-1)?.message;
  const [revealedCount, setRevealedCount] = useState(0);

  const agentsToShow = isComplete
    ? outputData?.agents ?? []
    : liveSpawnEvents
      .filter((event) => event.persona)
      .map((event) => ({
        goal: "",
        persona: event.persona!,
        actions: event.inferredActions ?? [],
      }));

  useEffect(() => {
    if (isComplete || agentsToShow.length === 0) return;
    const timer = window.setInterval(() => {
      setRevealedCount((current) => {
        if (current >= agentsToShow.length) return current;
        return current + 1;
      });
    }, 400);
    return () => window.clearInterval(timer);
  }, [agentsToShow.length, isComplete]);

  const visibleAgents = isComplete
    ? agentsToShow
    : agentsToShow.slice(0, Math.min(revealedCount, agentsToShow.length));

  return (
    <div className="my-2 overflow-hidden rounded-md border border-[#d1d5db] bg-[#fafafa]">
      <div className="flex items-center gap-2 border-b border-[#e5e7eb] bg-white px-3 py-2">
        {isFailed ? <XCircle size={14} className="text-[#dc2626]" /> : <Users size={14} className="text-[#7eb71b]" />}
        <span className="text-sm font-medium text-[#111827]">
          {isFailed ? "Specialist agents did not finish" : isComplete ? "Specialist agents ready" : "Spawning specialist agents"}
        </span>
        {!isComplete && !isFailed ? <Loader2 size={14} className="ml-auto animate-spin text-[#9ca3af]" /> : null}
      </div>

      <div className="space-y-2 p-3">
        {outputData?.purpose ? (
          <p className="text-sm text-[#3d5c18]">{outputData.purpose}</p>
        ) : null}

        {isFailed ? (
          <div className="rounded border border-[#fecaca] bg-[#fef2f2] p-2 text-sm text-[#991b1b]">
            {errorText}
          </div>
        ) : null}

        {visibleAgents.length === 0 && !isComplete && !isFailed ? (
          <p className="text-sm text-[#6b7280]">{latestProgressMessage ?? "Drafting agent roster…"}</p>
        ) : null}

        {visibleAgents.map((agent, index) => (
          <motion.div
            key={`${agent.persona.avatarSeed}-${index}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          >
            <AgentPersonaCard
              persona={agent.persona}
              goal={agent.goal || undefined}
              actions={agent.actions}
              index={index}
              phase={isComplete ? "queued" : "working"}
            />
          </motion.div>
        ))}

        {isComplete && part.output ? (
          <details className="pt-1">
            <summary className="cursor-pointer text-xs font-medium text-[#6b7280] hover:text-[#374151]">
              View technical spec
            </summary>
            <pre className={cn(
              "mt-2 max-h-64 overflow-auto rounded border border-[#e5e7eb] bg-white p-2 text-[11px] text-[#374151]",
            )}
            >
              {JSON.stringify((part.output as SaveLoopOutput).spec?.specJson ?? part.output, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
