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
  isCollapsing: boolean;
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
  /** When true, collapse automatically after streaming ends. Enabled by default. */
  autoClose?: boolean;
};

const AUTO_CLOSE_DELAY = 700;
const COLLAPSE_DURATION = 0.45;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    autoClose = true,
    children,
    ...props
  }: ReasoningProps) => {
    const resolvedDefaultOpen = defaultOpen ?? isStreaming;
    const isExplicitlyClosed = defaultOpen === false;
    const preferExpanded = defaultOpen === true;
    const shouldAutoClose = autoClose && !preferExpanded;

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
    const isOpenRef = useRef(isOpen);
    isOpenRef.current = isOpen;
    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const [isCollapsing, setIsCollapsing] = useState(false);
    const startTimeRef = useRef<number | null>(null);
    const collapseTimerRef = useRef<number | null>(null);

    useEffect(() => {
      if (isStreaming) {
        hasEverStreamedRef.current = true;
        setHasAutoClosed((current) => (current ? false : current));
        setIsCollapsing((current) => (current ? false : current));
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming, setDuration]);

    useEffect(() => {
      if (!isStreaming || isExplicitlyClosed || isOpenRef.current) return;
      setIsOpen(true);
    }, [isExplicitlyClosed, isStreaming, setIsOpen]);

    useEffect(() => {
      if (
        shouldAutoClose
        && hasEverStreamedRef.current
        && !isStreaming
        && isOpen
        && !hasAutoClosed
      ) {
        const timer = window.setTimeout(() => {
          setIsCollapsing(true);
          setIsOpen(false);
          setHasAutoClosed(true);
          collapseTimerRef.current = window.setTimeout(() => {
            setIsCollapsing(false);
            collapseTimerRef.current = null;
          }, COLLAPSE_DURATION * 1000);
        }, AUTO_CLOSE_DELAY);

        return () => window.clearTimeout(timer);
      }
    }, [shouldAutoClose, isStreaming, isOpen, setIsOpen, hasAutoClosed]);

    useEffect(() => () => {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
      }
    }, []);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        if (newOpen === isOpen) return;
        // Radix can emit close events while the parent is forcing open during streaming.
        if (!newOpen && isStreaming && !isExplicitlyClosed) return;
        if (!newOpen) {
          setIsCollapsing(true);
          collapseTimerRef.current = window.setTimeout(() => {
            setIsCollapsing(false);
            collapseTimerRef.current = null;
          }, COLLAPSE_DURATION * 1000);
        } else {
          setIsCollapsing(false);
        }
        setIsOpen(newOpen);
      },
      [isExplicitlyClosed, isOpen, isStreaming, setIsOpen],
    );

    const contextValue = useMemo(
      () => ({ duration, isCollapsing, isOpen, isStreaming, setIsOpen }),
      [duration, isCollapsing, isOpen, isStreaming, setIsOpen],
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

const defaultGetThinkingMessage = (
  isStreaming: boolean,
  duration: number | undefined,
) => {
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>Thinking...</Shimmer>;
  }
  const label = duration === undefined
    ? "Thought for a few seconds"
    : `Thought for ${duration} second${duration === 1 ? "" : "s"}`;
  return <p>{label}</p>;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();

    const message = getThinkingMessage
      ? getThinkingMessage(isStreaming, duration)
      : defaultGetThinkingMessage(isStreaming, duration);

    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 text-left">{message}</span>
            <ChevronDownIcon
              className={cn(
                "size-4 shrink-0 transition-transform duration-300 ease-out",
                isOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children?: string;
  isAnimating?: boolean;
};

const streamdownPlugins = { cjk, code, math, mermaid };

export const ReasoningContent = memo(
  ({ className, children = "", isAnimating, ...props }: ReasoningContentProps) => {
    const { isStreaming } = useReasoning();
    const text = children.trim();
    const active = isAnimating ?? isStreaming;

    if (!text && active) return null;

    return (
      <CollapsibleContent
        className={cn(
          "mt-4 text-sm text-muted-foreground outline-none",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2",
          "data-[state=closed]:animate-out data-[state=open]:animate-in",
          className,
        )}
        {...props}
      >
        {text ? (
          <Streamdown plugins={streamdownPlugins}>{children}</Streamdown>
        ) : (
          <p className="italic">No thinking details were returned for this step.</p>
        )}
      </CollapsibleContent>
    );
  },
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
