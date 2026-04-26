"use client";

import { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Confirmation({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("grid gap-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-2.5", className)} {...props} />;
}

