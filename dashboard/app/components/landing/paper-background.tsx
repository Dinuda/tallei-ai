import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PaperVariant = "blank" | "lined" | "grid";

export function PaperBackground({
  children,
  variant = "lined",
  className,
}: {
  children?: ReactNode;
  variant?: PaperVariant;
  className?: string;
}) {
  return (
    <div className={cn("landing-paper", `landing-paper--${variant}`, className)} aria-hidden={!children}>
      {children}
    </div>
  );
}
