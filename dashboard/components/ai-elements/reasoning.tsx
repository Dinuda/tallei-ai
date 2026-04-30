"use client";

import { ComponentProps, useState } from "react";

import { cn } from "@/lib/utils";

export function Reasoning({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("grid gap-2 rounded-lg border border-dashed border-border p-2.5", className)} {...props} />;
}

export function ReasoningToggle({
  title = "Reasoning",
  className,
  children,
}: { title?: string; className?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("grid gap-2", className)}>
      <button
        type="button"
        className="w-fit rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? `Hide ${title}` : `Show ${title}`}
      </button>
      {open ? <div className="text-xs text-muted-foreground">{children}</div> : null}
    </div>
  );
}

