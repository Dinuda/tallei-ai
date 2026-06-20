"use client";

import { cn } from "@/lib/utils";
import { AgentPersonaAvatar } from "./agent-persona-avatar";
import { agentStatusLine, roleBadgeClass, type AgentPersonaUi } from "./agent-persona";

type AgentPersonaCardProps = {
  persona: AgentPersonaUi;
  goal?: string;
  actions?: string[];
  index?: number;
  phase?: "working" | "finished" | "queued" | "failed" | "idle";
  compact?: boolean;
  className?: string;
};

export function AgentPersonaCard({
  persona,
  goal,
  actions,
  index,
  phase = "idle",
  compact = false,
  className,
}: AgentPersonaCardProps) {
  const statusPhase = phase === "idle" ? "queued" : phase;
  const statusText = phase !== "idle"
    ? agentStatusLine(persona.displayName, statusPhase, goal)
    : null;

  return (
    <div
      className={cn(
        "rounded-md border border-[#e4f5c6] bg-white p-3 shadow-sm",
        compact && "p-2.5",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AgentPersonaAvatar persona={persona} size={compact ? "sm" : "md"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {typeof index === "number" ? (
              <span className="text-xs font-medium text-[#7a9a4a]">{index + 1}.</span>
            ) : null}
            <span className="text-sm font-semibold text-[#182506]">{persona.displayName}</span>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                roleBadgeClass(persona.roleKey),
              )}
            >
              {persona.roleLabel}
            </span>
          </div>
          {goal ? (
            <p className={cn("mt-1 text-sm text-[#3d5c18]", compact && "line-clamp-2")}>{goal}</p>
          ) : null}
          {statusText ? (
            <p className="mt-1 text-xs font-medium text-[#7eb71b]">{statusText}</p>
          ) : null}
          {actions && actions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {actions.map((action) => (
                <span
                  key={action}
                  className="rounded border border-[#e4f5c6] bg-[#f8fdf2] px-2 py-0.5 text-[10px] font-medium text-[#3d5c18]"
                >
                  {action}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
