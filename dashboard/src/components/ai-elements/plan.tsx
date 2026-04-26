"use client";

import { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Plan({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("grid gap-2 rounded-lg border border-border bg-card p-3", className)} {...props} />;
}

export function PlanTitle({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("m-0 text-sm font-semibold text-foreground", className)} {...props} />;
}

export function PlanList({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid gap-1.5", className)} {...props} />;
}

export function PlanItem({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-md border border-border/80 bg-background px-2.5 py-2 text-xs text-foreground", className)} {...props} />;
}

