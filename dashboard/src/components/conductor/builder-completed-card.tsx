"use client";

import { Check } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type BuilderCompletedVariant = "emerald" | "violet" | "amber" | "indigo";

const variantStyles: Record<
  BuilderCompletedVariant,
  { border: string; bg: string; title: string; subtitle: string; icon: string }
> = {
  emerald: {
    border: "border-[var(--builder-emerald-border)]",
    bg: "bg-[var(--builder-emerald-bg)]",
    title: "text-[var(--builder-emerald-text)]",
    subtitle: "text-[var(--builder-emerald-text-muted)]",
    icon: "bg-[var(--builder-emerald-accent)]",
  },
  violet: {
    border: "border-[var(--builder-violet-border)]",
    bg: "bg-[var(--builder-violet-bg)]",
    title: "text-[var(--builder-violet-text)]",
    subtitle: "text-[var(--builder-violet-text-muted)]",
    icon: "bg-[var(--builder-violet-accent)]",
  },
  amber: {
    border: "border-[var(--builder-amber-border)]",
    bg: "bg-[var(--builder-amber-bg)]",
    title: "text-[var(--builder-amber-text)]",
    subtitle: "text-amber-700",
    icon: "bg-[var(--builder-amber-accent)]",
  },
  indigo: {
    border: "border-[var(--builder-indigo-border)]",
    bg: "bg-[var(--builder-indigo-bg-solid)]",
    title: "text-[var(--builder-indigo-text)]",
    subtitle: "text-[var(--builder-indigo-text-muted)]",
    icon: "bg-[var(--builder-indigo-accent)]",
  },
};

export function BuilderCompletedCard({
  title,
  subtitle,
  variant = "emerald",
  icon: Icon = Check,
  className,
}: {
  title: string;
  subtitle?: string;
  variant?: BuilderCompletedVariant;
  icon?: LucideIcon;
  className?: string;
}) {
  const styles = variantStyles[variant];

  return (
    <div className={cn("my-3 border px-4 py-3", styles.border, styles.bg, className)}>
      <div className="flex items-center gap-3">
        <span className={cn("flex size-8 shrink-0 items-center justify-center text-white", styles.icon)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <div
            className={cn("text-sm font-semibold", styles.title)}
            style={{ fontFamily: "var(--font-title)" }}
          >
            {title}
          </div>
          {subtitle ? (
            <div className={cn("text-xs", styles.subtitle)}>{subtitle}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
