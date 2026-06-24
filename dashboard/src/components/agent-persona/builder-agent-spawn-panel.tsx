"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { CalendarClock, Loader2, Send, Users } from "lucide-react";

import type { ToolPart } from "@/components/ai-elements/tool";
import { getToolName } from "ai";
import { IssueNotice } from "@/components/ai-elements/tool";
import { maskBuilderIssueText } from "@/lib/builder-issue-text";
import { cn } from "@/lib/utils";
import { AgentPersonaCard } from "./agent-persona-card";
import type { AgentPersonaUi } from "./agent-persona";
import { personaFromSpecAgent, toolRefsToLabels } from "./agent-persona";

type SpawnAgentDetails = {
  agentIndex?: number;
  agentId?: string;
  agentName?: string;
  goal?: string;
  persona?: AgentPersonaUi;
  inferredActions?: string[];
  status?: string;
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

function readLatestPlanCommand(commands: BuilderCommand[]): BuilderCommand | null {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    if (command?.toolName === "previewAgentPlan" || command?.toolName === "saveLoop") return command;
  }
  return null;
}

function readSpawnEvents(commands: BuilderCommand[]): SpawnAgentDetails[] {
  const command = readLatestPlanCommand(commands);
  if (!command?.events) return [];

  const byIndex = new Map<number, SpawnAgentDetails>();
  for (const event of command.events) {
    if (event.stage !== "agent_spawn") continue;
    const details = event.details;
    const index = details?.agentIndex;
    if (typeof index !== "number") continue;

    const existing = byIndex.get(index);
    if (existing?.status === "completed" && event.status !== "completed") continue;

    byIndex.set(index, {
      ...details,
      status: event.status ?? details?.status,
    });
  }

  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, details]) => details);
}

function readSaveLoopPayload(part: ToolPart, commands: BuilderCommand[]): SaveLoopOutput | null {
  const output = part.output as SaveLoopOutput | undefined;
  if (output?.spec?.specJson) return output;

  const command = readLatestPlanCommand(commands);
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

/** Agent plan preview or post-save compile. */
export function isPreviewAgentPlanTool(toolName: string, _part: ToolPart): boolean {
  return toolName === "previewAgentPlan" || toolName === "saveLoop";
}

export function BuilderAgentSpawnPanel({ part, commands }: BuilderAgentSpawnPanelProps) {
  const toolName = getToolName(part);
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
  const latestCommand = useMemo(() => readLatestPlanCommand(commands), [commands]);
  const isPreview = toolName === "previewAgentPlan" || saveLoopPayload?.preview === true;
  const isFailed = !isComplete && (
    part.state === "output-error" || latestCommand?.status === "failed" || latestCommand?.status === "rejected"
  );
  const issueSummary = maskBuilderIssueText(
    part.errorText ?? latestCommand?.error,
    "save-loop",
  );
  const latestProgressMessage = latestCommand?.events?.at(-1)?.message;
  const [revealedCount, setRevealedCount] = useState(0);

  const agentsToShow = useMemo(() => {
    if (isComplete) {
      return (outputData?.agents ?? []).map((agent) => ({
        ...agent,
        phase: "queued" as const,
      }));
    }
    return liveSpawnEvents.map((event, index) => ({
      goal: event.goal?.trim() ?? "",
      persona: event.persona ?? personaFromSpecAgent(
        { name: event.agentName, goal: event.goal },
        event.agentIndex ?? index,
      ),
      actions: event.inferredActions ?? [],
      phase: event.status === "completed" ? "queued" as const : "working" as const,
    }));
  }, [isComplete, liveSpawnEvents, outputData?.agents]);

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

  if (isFailed) {
    return <IssueNotice summary={issueSummary} />;
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-[#cce89e] bg-[#f8fdf2] shadow-sm">
      <div className="flex items-center gap-2 border-b border-[#e4f5c6] bg-white px-4 py-3">
        <Users size={16} className="text-[#7eb71b]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[#182506]" style={{ fontFamily: "var(--font-title)" }}>
            {isComplete
              ? (isPreview ? "Proposed specialist agents" : "Specialist agents ready")
              : "Designing specialist agents"}
          </div>
          {isComplete && outputData?.title ? (
            <div className="truncate text-xs text-[#7a9a4a]">{outputData.title}</div>
          ) : null}
        </div>
        {!isComplete ? <Loader2 size={16} className="animate-spin text-[#7a9a4a]" /> : null}
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

        {visibleAgents.length === 0 && !isComplete ? (
          <p className="text-sm text-[#7a9a4a]">{latestProgressMessage ?? "Running the conductor to split read and write work…"}</p>
        ) : null}

        {visibleAgents.length > 0 ? (
          <div className={cn(
            "grid gap-3",
            visibleAgents.length > 1 && "md:grid-cols-2",
          )}>
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
                  phase={agent.phase}
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
