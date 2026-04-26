"use client";

import { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function ChainOfThought({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground", className)} {...props} />;
}

