"use client";

import { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Tool({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("grid gap-2 rounded-lg border border-border bg-card p-3", className)} {...props} />;
}

export function ToolHeader({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground", className)} {...props} />;
}

export function ToolContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid gap-2 text-sm text-foreground", className)} {...props} />;
}

