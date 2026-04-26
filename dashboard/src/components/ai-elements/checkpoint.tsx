"use client";

import { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Checkpoint({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-md border border-amber-200 bg-amber-50/50 px-2.5 py-2 text-xs text-amber-900", className)} {...props} />;
}

