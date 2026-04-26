"use client";

import { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function InlineCitation({ className, ...props }: ComponentProps<"a">) {
  return (
    <a
      className={cn(
        "inline-flex items-center rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:border-ring/40 hover:text-foreground",
        className
      )}
      {...props}
    />
  );
}

