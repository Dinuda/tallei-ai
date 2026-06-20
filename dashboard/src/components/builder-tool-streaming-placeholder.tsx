"use client";

import { cn } from "@/lib/utils";

export function BuilderToolStreamingPlaceholder({
  label = "Preparing next step…",
  placement = "transcript",
}: {
  label?: string;
  placement?: "transcript" | "composer";
}) {
  return (
    <div className={cn(
      "w-full overflow-hidden bg-[#f9f8fc]",
      placement === "composer"
        ? "border-0"
        : "my-3 border border-[#e8e5f0]",
    )}>
      <div className="flex items-center gap-2 px-4 py-4 text-sm font-medium text-[#6b7280]">
        <span>{label}</span>
        <span className="inline-flex gap-0.5">
          <span className="size-1.5 animate-pulse bg-muted-foreground" style={{ animationDelay: "0ms" }} />
          <span className="size-1.5 animate-pulse bg-muted-foreground" style={{ animationDelay: "150ms" }} />
          <span className="size-1.5 animate-pulse bg-muted-foreground" style={{ animationDelay: "300ms" }} />
        </span>
      </div>
    </div>
  );
}
