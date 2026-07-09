"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Streamdown } from "streamdown";

import { Shimmer } from "./shimmer";
import { useAnimationFrameText } from "@/hooks/use-animation-frame-text";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = false,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: defaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    });

    const wasStreamingRef = useRef(isStreaming);
    const startTimeRef = useRef<number | null>(isStreaming ? Date.now() : null);
    const isOpenRef = useRef(isOpen);
    isOpenRef.current = isOpen;

    useEffect(() => {
      const wasStreaming = wasStreamingRef.current;
      wasStreamingRef.current = isStreaming;

      if (isStreaming && !wasStreaming) {
        startTimeRef.current = Date.now();
        // Keep the panel open while tokens stream; Radix may emit a close that we ignore below.
        if (!isOpenRef.current) {
          setIsOpen(true);
        }
        return;
      }

      if (!isStreaming && wasStreaming && startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming, setDuration, setIsOpen]);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        if (newOpen === isOpen) return;
        // Radix Collapsible can emit close while content remounts during streaming.
        // Accepting that close while a parent also forces open creates an update loop.
        if (!newOpen && isStreaming) return;
        setIsOpen(newOpen);
      },
      [isOpen, isStreaming, setIsOpen],
    );

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen }),
      [duration, isOpen, isStreaming, setIsOpen]
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>Thinking...</Shimmer>;
  }
  if (duration === undefined) {
    return <span>Thought for a few seconds</span>;
  }
  return <span>Thought for {duration} seconds</span>;
};

const triggerClassName =
  "inline-flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground";

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        aria-live={isStreaming ? "polite" : undefined}
        className={cn(triggerClassName, className)}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4 shrink-0 opacity-70" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn(
                "size-4 shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
                isOpen ? "rotate-180" : "rotate-0"
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
  footer?: ReactNode;
  isStreaming?: boolean;
};

const streamdownPlugins = { cjk, code, math, mermaid };

const REASONING_LIVE_MAX_HEIGHT = 240;

export const ReasoningContent = memo(
  ({ className, children, footer, isStreaming = false, ...props }: ReasoningContentProps) => {
    const { isOpen } = useReasoning();
    const reduceMotion = useReducedMotion();
    const liveScrollRef = useRef<HTMLDivElement>(null);
    const displayedText = useAnimationFrameText(isStreaming ? children : null, {
      onFlush: isStreaming && isOpen
        ? () => {
            const el = liveScrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }
        : undefined,
    });

    return (
      <CollapsibleContent
        className={cn(
          "mt-2 text-sm text-muted-foreground outline-none",
          className
        )}
        {...props}
      >
        <AnimatePresence initial={false}>
          {(isOpen || isStreaming) ? (
            <motion.div
              animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
              initial={reduceMotion ? undefined : { opacity: 0, y: 6 }}
              key="reasoning-body"
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            >
              {isStreaming ? (
                <div
                  className="conductor-reasoning-live overflow-y-auto overflow-x-hidden"
                  ref={liveScrollRef}
                  style={{ maxHeight: REASONING_LIVE_MAX_HEIGHT }}
                >
                  <p className="conductor-reasoning-live__text whitespace-pre-wrap break-words">
                    {displayedText}
                  </p>
                  {footer}
                </div>
              ) : (
                <>
                  <Streamdown plugins={streamdownPlugins}>{children}</Streamdown>
                  {footer}
                </>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </CollapsibleContent>
    );
  }
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
