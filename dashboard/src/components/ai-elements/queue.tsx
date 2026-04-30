"use client";

import { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Queue({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("grid gap-2 rounded-lg border border-border/70 bg-background p-2.5", className)} {...props} />;
}

export function QueueTitle({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground", className)} {...props} />;
}

export function QueueList({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap gap-1.5", className)} {...props} />;
}

export function QueueItem({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground", className)} {...props} />;
}

