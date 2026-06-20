"use client";

import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/ai-elements/shimmer";

export function TypingDots({ className }: { className?: string }) {
  return (
    <span
      aria-label="Working"
      className={cn("inline-flex items-center gap-1 py-1", className)}
      role="status"
    >
      {[0, 1, 2].map((index) => (
        <span
          className="size-1.5 rounded-full bg-[#9ca3af] animate-bounce"
          key={index}
          style={{ animationDelay: `${index * 150}ms`, animationDuration: "0.9s" }}
        />
      ))}
    </span>
  );
}

export function TranscriptThinkingIndicator({
  label = "Thinking…",
  className,
  variant = "dots",
}: {
  label?: string;
  className?: string;
  variant?: "dots" | "shimmer" | "label";
}) {
  if (variant === "dots") {
    return <TypingDots className={className} />;
  }

  if (variant === "label") {
    return (
      <div className={cn("text-sm text-[#6b7280]", className)}>
        {label}
      </div>
    );
  }

  return (
    <div className={cn("text-sm text-muted-foreground", className)}>
      <Shimmer duration={1}>{label}</Shimmer>
    </div>
  );
}
