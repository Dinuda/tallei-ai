"use client";

import { cn } from "@/lib/utils";
import { dicebearDylanUrl, type AgentPersonaUi } from "./agent-persona";

type AgentPersonaAvatarProps = {
  persona: Pick<AgentPersonaUi, "displayName" | "avatarSeed" | "avatarUrl">;
  size?: "sm" | "md" | "lg";
  className?: string;
};

const sizeClasses = {
  sm: "h-8 w-8",
  md: "h-10 w-10",
  lg: "h-12 w-12",
};

export function AgentPersonaAvatar({ persona, size = "md", className }: AgentPersonaAvatarProps) {
  const url = persona.avatarUrl ?? dicebearDylanUrl(persona.avatarSeed);
  const initials = persona.displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-full border border-[#d1d5db] bg-[#f8fdf2]",
        sizeClasses[size],
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={`${persona.displayName} avatar`}
        className="h-full w-full object-cover"
        onError={(event) => {
          const target = event.currentTarget;
          target.style.display = "none";
          const parent = target.parentElement;
          if (parent && !parent.querySelector("[data-fallback]")) {
            const fallback = document.createElement("span");
            fallback.dataset.fallback = "true";
            fallback.className = "flex h-full w-full items-center justify-center text-[10px] font-semibold text-[#3d5c18]";
            fallback.textContent = initials;
            parent.appendChild(fallback);
          }
        }}
      />
    </div>
  );
}
