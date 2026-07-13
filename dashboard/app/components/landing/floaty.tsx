"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type FloatyProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  duration?: number;
  style?: "float" | "drift";
};

export function Floaty({
  children,
  className,
  delay = 0,
  duration = 6,
  style = "float",
}: FloatyProps) {
  return (
    <div
      className={cn(
        "landing-floaty",
        style === "drift" ? "landing-floaty--drift" : "landing-floaty--float",
        className,
      )}
      style={
        {
          "--floaty-delay": `${delay}s`,
          "--floaty-duration": `${duration}s`,
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}
