"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { CalendarClock, Loader2, Send, Users, XCircle } from "lucide-react";

import type { ToolPart } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import { AgentPersonaCard } from "./agent-persona-card";
import type { AgentPersonaUi } from "./agent-persona";
import { personaFromSpecAgent, toolRefsToLabels } from "./agent-persona";

type SpawnAgentDetails = {
  agentIndex?: number;
  persona?: AgentPersonaUi;
  inferredActions?: string[];
};

type BuilderCommand = {
  toolName?: string;
  status?: string;
  error?: string;
  result?: Record<string, unknown>;
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

type SpecJson = {
  purpose?: string;
  schedule?: { description?: string; cron?: string; timezone?: string };
  delivery?: { provider?: string; description?: string };
  agents?: SpecAgent[];
};

type SaveLoopOutput = {
  spec?: {
    title?: string;
    specJson?: SpecJson;
  };
  preview?: boolean;
};

function readLatestSaveLoopCommand(commands: BuilderCommand[]): BuilderCommand | null {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    if (command?.toolName === "saveLoop") return command;
  }
  return null;
}

function readSpawnEvents(commands: BuilderCommand[]): SpawnAgentDetails[] {
  const command = readLatestSaveLoopCommand(commands);
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

function readSaveLoopPayload(part: ToolPart, commands: BuilderCommand[]): SaveLoopOutput | null {
  const output = part.output as SaveLoopOutput | undefined;
  if (output?.spec?.specJson) return output;

  const command = readLatestSaveLoopCommand(commands);
  const result = command?.result as SaveLoopOutput | undefined;
  if (result?.spec?.specJson) return result;
  return output ?? null;
}

function readOutputAgents(payload: SaveLoopOutput | null): {
  title: string;
  purpose: string;
  scheduleLabel: string | null;
  deliveryLabel: string | null;
  agents: Array<{ goal: string; persona: AgentPersonaUi; actions: string[] }>;
} {
  const specJson = payload?.spec?.specJson;
  const purpose = specJson?.purpose?.trim() ?? "";
  const title = payload?.spec?.title?.trim() || "Your loop";
  const scheduleLabel = specJson?.schedule?.description?.trim()
    ?? (specJson?.schedule?.cron && specJson.schedule.timezone
      ? `${specJson.schedule.cron} (${specJson.schedule.timezone})`
      : null);
  const deliveryLabel = specJson?.delivery?.description?.trim()
    ?? (specJson?.delivery?.provider && specJson.delivery.provider !== "none"
      ? `Delivery via ${specJson.delivery.provider}`
      : null);

  const agents = (specJson?.agents ?? []).map((agent, index) => ({
    goal: agent.goal?.trim() ?? "",
    persona: personaFromSpecAgent(agent, index),
    actions: toolRefsToLabels(agent.tools ?? []),
  }));

  return { title, purpose, scheduleLabel, deliveryLabel, agents };
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

/** Runtime agent compilation for save/test. */
export function isSpecDraftSpawnTool(toolName: string, part: ToolPart): boolean {
  if (toolName !== "saveLoop") return false;

  const input = readToolRecord(part.input);
  if (input.preview === true) return false;

  const output = readToolRecord(part.output);
  if (output.spec) return true;

  return part.state !== "output-available";
}

export function BuilderAgentSpawnPanel({ part, commands }: BuilderAgentSpawnPanelProps) {
  const isComplete = part.state === "output-available";
  const saveLoopPayload = useMemo(
    () => (isComplete ? readSaveLoopPayload(part, commands) : null),
    [commands, isComplete, part],
  );
  const outputData = useMemo(
    () => (saveLoopPayload ? readOutputAgents(saveLoopPayload) : null),
    [saveLoopPayload],
  );
  const liveSpawnEvents = useMemo(() => readSpawnEvents(commands), [commands]);
  const latestCommand = useMemo(() => readLatestSaveLoopCommand(commands), [commands]);
  const isFailed = !isComplete && (
    part.state === "output-error" || latestCommand?.status === "failed" || latestCommand?.status === "rejected"
  );
  const errorText = part.errorText ?? latestCommand?.error ?? "The runtime agent contract did not complete. Please try again.";
  const latestProgressMessage = latestCommand?.events?.at(-1)?.message;
  const [revealedCount, setRevealedCount] = useState(0);

  const agentsToShow = isComplete
    ? outputData?.agents ?? []
    : liveSpawnEvents
      .filter((event) => event.persona)
      .map((event, index) => ({
        goal: "",
        persona: event.persona!,
        actions: event.inferredActions ?? [],
        index,
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
    <div className="my-2 overflow-hidden rounded-lg border border-[#cce89e] bg-[#f8fdf2] shadow-sm">
      <div className="flex items-center gap-2 border-b border-[#e4f5c6] bg-white px-4 py-3">
        {isFailed ? <XCircle size={16} className="text-[#dc2626]" /> : <Users size={16} className="text-[#7eb71b]" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[#182506]" style={{ fontFamily: "var(--font-title)" }}>
            {isFailed ? "Specialist agents did not finish" : isComplete ? "Specialist agents ready" : "Finalizing specialist agents"}
          </div>
          {isComplete && outputData?.title ? (
            <div className="truncate text-xs text-[#7a9a4a]">{outputData.title}</div>
          ) : null}
        </div>
        {!isComplete && !isFailed ? <Loader2 size={16} className="animate-spin text-[#7a9a4a]" /> : null}
      </div>

      <div className="space-y-3 p-4">
        {isComplete && (outputData?.scheduleLabel || outputData?.deliveryLabel) ? (
          <div className="flex flex-wrap gap-2">
            {outputData.scheduleLabel ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e4f5c6] bg-white px-2.5 py-1 text-[11px] font-medium text-[#3d5c18]">
                <CalendarClock size={12} className="text-[#7eb71b]" />
                {outputData.scheduleLabel}
              </span>
            ) : null}
            {outputData.deliveryLabel ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e4f5c6] bg-white px-2.5 py-1 text-[11px] font-medium text-[#3d5c18]">
                <Send size={12} className="text-[#7eb71b]" />
                {outputData.deliveryLabel}
              </span>
            ) : null}
          </div>
        ) : null}

        {outputData?.purpose ? (
          <p className="text-sm leading-relaxed text-[#3d5c18]">{outputData.purpose}</p>
        ) : null}

        {isFailed ? (
          <div className="rounded-md border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
            {errorText}
          </div>
        ) : null}

        {visibleAgents.length === 0 && !isComplete && !isFailed ? (
          <p className="text-sm text-[#7a9a4a]">{latestProgressMessage ?? "Assigning agent personas…"}</p>
        ) : null}

        {visibleAgents.length > 0 ? (
          <div className={cn("grid gap-3", visibleAgents.length > 1 && "sm:grid-cols-1")}>
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
          </div>
        ) : null}

        {isComplete && visibleAgents.length === 0 ? (
          <p className="text-sm text-[#7a9a4a]">No specialist agents were compiled for this loop.</p>
        ) : null}
      </div>
    </div>
  );
}
