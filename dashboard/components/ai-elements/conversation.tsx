"use client";

import { ComponentProps, PropsWithChildren, forwardRef, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export function Conversation({ className, children, ...props }: ComponentProps<"section">) {
  return (
    <section className={cn("relative", className)} {...props}>
      {children}
    </section>
  );
}

export const ConversationContent = forwardRef<HTMLDivElement, ComponentProps<"div">>(
  ({ className, children, ...props }, ref) => {
    return (
      <div ref={ref} className={cn("grid content-start gap-2 overflow-auto", className)} {...props}>
        {children}
      </div>
    );
  }
);

ConversationContent.displayName = "ConversationContent";

export function ConversationScrollButton({
  targetRef,
  className,
  children,
}: PropsWithChildren<{ targetRef: React.RefObject<HTMLElement | null>; className?: string }>) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    const onScroll = () => {
      const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
      setVisible(distance > 72);
    };

    onScroll();
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [targetRef]);

  if (!visible) return null;

  return (
    <button
      type="button"
      className={cn(
        "absolute bottom-2 right-2 rounded-full border border-border bg-background px-2 py-1 text-xs text-muted-foreground",
        className
      )}
      onClick={() => targetRef.current?.scrollTo({ top: targetRef.current.scrollHeight, behavior: "smooth" })}
      aria-label="Scroll to latest"
    >
      {children ?? "Latest"}
    </button>
  );
}
