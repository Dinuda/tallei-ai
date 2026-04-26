"use client";

import { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Sources({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("grid gap-2 rounded-lg border border-border/70 bg-background p-2.5", className)} {...props} />;
}

export function SourcesTitle({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground", className)} {...props} />;
}

export function SourcesContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid gap-1.5", className)} {...props} />;
}

export function SourceItem({ className, ...props }: ComponentProps<"a">) {
  return (
    <a
      className={cn(
        "grid gap-0.5 rounded-md border border-border bg-card px-2.5 py-2 text-xs text-muted-foreground hover:border-ring/40 hover:text-foreground",
        className
      )}
      {...props}
    />
  );
}

