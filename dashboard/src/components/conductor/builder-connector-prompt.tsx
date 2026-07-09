"use client";

import { LayoutGrid, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";
import { Button } from "@/components/ui/button";
import { connectorLogoUrl } from "@/components/conductor/conductor-shared";
import {
  CONNECTOR_RETURN_URL_KEY,
  formatToolkitLabel,
  PENDING_CONNECTOR_KEY,
  useConnectorAuthorization,
} from "@/components/conductor/use-connector-authorization";

export { CONNECTOR_RETURN_URL_KEY };

export function BuilderConnectorPrompt({
  question,
  options,
  recommendedOptionIds = [],
  allowMultiple = false,
  allowOther = true,
  disabled = false,
  onDismiss,
  onSubmit,
  selectionHint,
  step,
}: {
  question: string;
  options: InteractivePromptOption[];
  recommendedOptionIds?: string[];
  allowMultiple?: boolean;
  allowOther?: boolean;
  disabled?: boolean;
  onDismiss?: () => void;
  onSubmit: (answer: InteractivePromptAnswer) => void;
  selectionHint?: string;
  step?: { index: number; total: number };
}) {
  const [pendingAnswer, setPendingAnswer] = useState<InteractivePromptAnswer | null>(null);
  const [pendingToolkit, setPendingToolkit] = useState<string | null>(null);
  const restoredPendingRef = useRef(false);

  const recommendedCount = recommendedOptionIds.filter((id) =>
    options.some((option) => option.id === id),
  ).length;

  useEffect(() => {
    if (restoredPendingRef.current) return;
    restoredPendingRef.current = true;
    const stored = window.sessionStorage.getItem(PENDING_CONNECTOR_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as {
        answer?: InteractivePromptAnswer;
        toolkit?: string;
      };
      if (!parsed.answer || !parsed.toolkit) return;
      if (!options.some((option) => option.value === parsed.toolkit)) return;
      setPendingAnswer(parsed.answer);
      setPendingToolkit(parsed.toolkit);
    } catch {
      window.sessionStorage.removeItem(PENDING_CONNECTOR_KEY);
      window.sessionStorage.removeItem(CONNECTOR_RETURN_URL_KEY);
    }
  }, [options]);

  const completeSelection = useCallback((answer: InteractivePromptAnswer) => {
    setPendingAnswer(null);
    setPendingToolkit(null);
    onSubmit(answer);
  }, [onSubmit]);

  const pendingAnswerRef = useRef(pendingAnswer);
  pendingAnswerRef.current = pendingAnswer;

  const pendingSession = useMemo(() => ({
    buildPayload: (toolkit: string, connectionRequestId: string) => ({
      answer: pendingAnswerRef.current,
      toolkit,
      connectionRequestId,
    }),
    canRestore: (payload: { answer?: InteractivePromptAnswer; toolkit?: string }) => {
      if (!payload.answer || !payload.toolkit) return false;
      return options.some((option) => option.value === payload.toolkit);
    },
  }), [options]);

  const handleConnected = useCallback(() => {
    const answer = pendingAnswerRef.current;
    if (answer) completeSelection(answer);
  }, [completeSelection]);

  const {
    busy,
    statusLabel,
    canRestart,
    ensureConnected,
    restartConnection,
    reset,
  } = useConnectorAuthorization({
    toolkit: pendingToolkit,
    onConnected: handleConnected,
    pendingSession,
  });

  const handleSubmit = useCallback((answer: InteractivePromptAnswer) => {
    const toolkit = answer.selectedValues[0]?.trim();
    if (!toolkit || answer.otherText) {
      onSubmit(answer);
      return;
    }
    setPendingAnswer(answer);
    setPendingToolkit(toolkit);
    void ensureConnected(toolkit, { answer, toolkit });
  }, [ensureConnected, onSubmit]);

  const handleReset = useCallback(() => {
    reset();
    setPendingAnswer(null);
    setPendingToolkit(null);
  }, [reset]);

  const pendingToolkitLabel = pendingToolkit ? formatToolkitLabel(pendingToolkit) : "";

  return (
    <div className="w-full border border-[var(--builder-indigo-border)] bg-[var(--builder-indigo-bg)]">
      <div className="border-b border-[var(--builder-indigo-border-light)] bg-white px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center bg-[var(--builder-indigo-bg-solid)] text-[var(--builder-indigo-accent)]">
              <ShieldCheck className="size-4" />
            </span>
            <div>
              <div
                className="text-[14px] font-bold tracking-[-0.02em] text-[var(--builder-indigo-text)]"
                style={{ fontFamily: "var(--font-title)" }}
              >
                Choose an app
              </div>
              <p className="mt-0.5 text-[13px] text-[var(--builder-indigo-text-muted)]">
                Pick the app that should power this loop.
              </p>
            </div>
          </div>
          {options.length > 0 ? (
            <span className="border border-[var(--builder-indigo-border)] bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--builder-indigo-accent)]">
              Top {recommendedCount} recommended · {options.length} apps
            </span>
          ) : null}
        </div>
      </div>
      {pendingAnswer && pendingToolkit ? (
        <div className="bg-white px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden border border-[var(--builder-indigo-border-light)] bg-white">
              <img
                alt={pendingToolkit}
                className="size-5 object-contain"
                draggable={false}
                src={connectorLogoUrl(pendingToolkit)}
              />
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-[var(--builder-indigo-text)]">
              {busy ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : null}
              <span className="truncate">
                {statusLabel || `Connecting ${pendingToolkitLabel}…`}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                aria-label="Choose another app"
                disabled={busy}
                onClick={handleReset}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <LayoutGrid className="size-4" />
              </Button>
              {canRestart ? (
                <Button
                  disabled={busy}
                  onClick={restartConnection}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RefreshCw className={busy ? "animate-spin" : undefined} />
                  Restart connection
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <InteractivePromptMenu
          allowMultiple={allowMultiple}
          allowOther={allowOther}
          disabled={disabled || busy}
          onDismiss={onDismiss}
          onSubmit={handleSubmit}
          options={options}
          placement="composer"
          question={question}
          rankedAppsLayout
          recommendedOptionIds={recommendedOptionIds}
          selectionHint={selectionHint}
          step={step}
          variant="connector"
        />
      )}
    </div>
  );
}
