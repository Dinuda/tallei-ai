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
  useState,
} from "react";
import { Streamdown } from "streamdown";

import { Shimmer } from "./shimmer";

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
  /** Ms to wait after streaming ends before auto-collapsing (default 1000). */
  autoCloseDelay?: number;
};

const DEFAULT_AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    autoCloseDelay = DEFAULT_AUTO_CLOSE_DELAY,
    children,
    ...props
  }: ReasoningProps) => {
    const resolvedDefaultOpen = defaultOpen ?? isStreaming;
    // Track if defaultOpen was explicitly set to false (to prevent auto-open)
    const isExplicitlyClosed = defaultOpen === false;

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    });

    const hasEverStreamedRef = useRef(isStreaming);
    const wasStreamingRef = useRef(isStreaming);
    const isOpenRef = useRef(isOpen);
    const hasAutoClosedRef = useRef(false);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const startTimeRef = useRef<number | null>(isStreaming ? Date.now() : null);
    const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    isOpenRef.current = isOpen;
    hasAutoClosedRef.current = hasAutoClosed;

    // Stream transitions only — never depend on isOpen/hasAutoClosed here.
    useEffect(() => {
      const wasStreaming = wasStreamingRef.current;
      wasStreamingRef.current = isStreaming;

      if (isStreaming && !wasStreaming) {
        hasEverStreamedRef.current = true;
        if (autoCloseTimerRef.current !== null) {
          clearTimeout(autoCloseTimerRef.current);
          autoCloseTimerRef.current = null;
        }
        if (hasAutoClosedRef.current) {
          setHasAutoClosed(false);
        }
        startTimeRef.current = Date.now();
        if (!isExplicitlyClosed && !isOpenRef.current) {
          setIsOpen(true);
        }
        return;
      }

      if (!isStreaming && wasStreaming) {
        if (startTimeRef.current !== null) {
          setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
          startTimeRef.current = null;
        }

        if (
          hasEverStreamedRef.current
          && isOpenRef.current
          && !hasAutoClosedRef.current
          && autoCloseTimerRef.current === null
        ) {
          autoCloseTimerRef.current = setTimeout(() => {
            autoCloseTimerRef.current = null;
            setIsOpen(false);
            setHasAutoClosed(true);
          }, autoCloseDelay);
        }
      }
    }, [autoCloseDelay, isExplicitlyClosed, isStreaming, setDuration, setIsOpen]);

    useEffect(() => () => {
      if (autoCloseTimerRef.current !== null) {
        clearTimeout(autoCloseTimerRef.current);
      }
    }, []);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        if (newOpen === isOpen) return;
        // Radix can emit close while parent keeps this open during streaming.
        if (!newOpen && isStreaming && !isExplicitlyClosed) return;
        if (!newOpen && autoCloseTimerRef.current !== null) {
          clearTimeout(autoCloseTimerRef.current);
          autoCloseTimerRef.current = null;
        }
        setIsOpen(newOpen);
      },
      [isExplicitlyClosed, isOpen, isStreaming, setIsOpen],
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
    return <p>Thought for a few seconds</p>;
  }
  return <p>Thought for {duration} seconds</p>;
};

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
        className={cn(
          "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]",
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
};

const streamdownPlugins = { cjk, code, math, mermaid };

export const reasoningStreamdownPlugins = streamdownPlugins;

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        "mt-4 text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className
      )}
      {...props}
    >
      <Streamdown plugins={streamdownPlugins}>{children}</Streamdown>
    </CollapsibleContent>
  )
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
