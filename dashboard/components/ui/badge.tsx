import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--accent-light)] text-[var(--text)] border border-[var(--border)]",
        success:
          "bg-[#e6f5c8] text-[#3d5c18] border border-[#cce89e]",
        neutral:
          "bg-[var(--border-light)] text-[var(--text-muted)] border border-[var(--border)]",
        outline:
          "bg-transparent border border-[var(--border)] text-[var(--text-2)]",
        accent:
          "bg-[#7eb71b] text-white border border-transparent",
        hero:
          "bg-white/10 text-white/80 border border-white/20 backdrop-blur-sm",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
