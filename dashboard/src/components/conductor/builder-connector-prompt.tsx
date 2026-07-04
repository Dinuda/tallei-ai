"use client";

import { LayoutGrid, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";
import { Button } from "@/components/ui/button";
import { connectorLogoUrl } from "@/components/conductor/conductor-shared";
import { apiFetch } from "@/lib/api-fetch";

type ConnectorStatus = {
  connected?: boolean;
  error?: string;
};

type AuthorizationResult = {
  redirectUrl?: string;
  connectionRequestId?: string;
  error?: string;
};

const PENDING_CONNECTOR_KEY = "tallei.pendingConnectorAuthorization";
export const CONNECTOR_RETURN_URL_KEY = "tallei.connectorReturnUrl";

function friendlyConnectionError(error: unknown, toolkit: string): string {
  const message = error instanceof Error ? error.message : "Could not check this connection.";
  if (/auth config|configured composio/i.test(message)) {
    const displayName = toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
    return `${displayName} isn't available to connect yet. Choose another app.`;
  }
  return message;
}

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
  const [connectionRequestId, setConnectionRequestId] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [returnedFromAuthorization, setReturnedFromAuthorization] = useState(false);
  const verifyInFlight = useRef(false);
  const restoredPendingRef = useRef(false);

  const recommendedCount = recommendedOptionIds.filter((id) =>
    options.some((option) => option.id === id),
  ).length;

  const completeSelection = useCallback((answer: InteractivePromptAnswer) => {
    setConnectionBusy(false);
    setPendingAnswer(null);
    setPendingToolkit(null);
    setConnectionRequestId(null);
    setConnectionError(null);
    setReturnedFromAuthorization(false);
    window.sessionStorage.removeItem(PENDING_CONNECTOR_KEY);
    window.sessionStorage.removeItem(CONNECTOR_RETURN_URL_KEY);
    onSubmit(answer);
  }, [onSubmit]);

  useEffect(() => {
    if (restoredPendingRef.current) return;
    restoredPendingRef.current = true;
    const stored = window.sessionStorage.getItem(PENDING_CONNECTOR_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as {
        answer?: InteractivePromptAnswer;
        toolkit?: string;
        connectionRequestId?: string;
      };
      if (!parsed.answer || !parsed.toolkit || !parsed.connectionRequestId) return;
      if (!options.some((option) => option.value === parsed.toolkit)) return;
      setPendingAnswer(parsed.answer);
      setPendingToolkit(parsed.toolkit);
      setConnectionRequestId(parsed.connectionRequestId);
      setReturnedFromAuthorization(true);
    } catch {
      window.sessionStorage.removeItem(PENDING_CONNECTOR_KEY);
    }
  }, [options]);

  const verifyPendingConnection = useCallback(async () => {
    if (!pendingAnswer || !pendingToolkit || verifyInFlight.current) return;
    verifyInFlight.current = true;
    setConnectionBusy(true);
    setConnectionError(null);
    try {
      const path = connectionRequestId
        ? `/api/connectors/authorize/${encodeURIComponent(connectionRequestId)}/verify`
        : `/api/connectors/status/${encodeURIComponent(pendingToolkit)}`;
      const response = await apiFetch(path, connectionRequestId
        ? { method: "POST", body: JSON.stringify({ toolkit: pendingToolkit, timeoutMs: 3_000 }) }
        : undefined);
      const status = await response.json().catch(() => ({})) as ConnectorStatus;
      if (response.ok && status.connected) {
        completeSelection(pendingAnswer);
        return;
      }
      if (!response.ok) {
        setConnectionError(status.error ?? "Could not verify this connection.");
      } else {
        setReturnedFromAuthorization(false);
        setConnectionRequestId(null);
        window.sessionStorage.removeItem(PENDING_CONNECTOR_KEY);
        window.sessionStorage.removeItem(CONNECTOR_RETURN_URL_KEY);
        setConnectionError("Connection was not completed. Try again or choose another app.");
      }
    } catch {
      setConnectionError("Could not verify this connection. Try again.");
    } finally {
      verifyInFlight.current = false;
      setConnectionBusy(false);
    }
  }, [completeSelection, connectionRequestId, pendingAnswer, pendingToolkit]);

  useEffect(() => {
    if (!returnedFromAuthorization || !pendingAnswer || !pendingToolkit || !connectionRequestId) return;
    void verifyPendingConnection();
  }, [connectionRequestId, pendingAnswer, pendingToolkit, returnedFromAuthorization, verifyPendingConnection]);

  const verifyOrConnect = useCallback(async (answer: InteractivePromptAnswer) => {
    const toolkit = answer.selectedValues[0]?.trim();
    if (!toolkit || answer.otherText) {
      onSubmit(answer);
      return;
    }

    setPendingAnswer(answer);
    setPendingToolkit(toolkit);
    setConnectionBusy(true);
    setConnectionError(null);
    try {
      const statusResponse = await apiFetch(`/api/connectors/status/${encodeURIComponent(toolkit)}`);
      const status = await statusResponse.json().catch(() => ({})) as ConnectorStatus;
      if (statusResponse.ok && status.connected) {
        completeSelection(answer);
        return;
      }

      const authResponse = await apiFetch(`/api/connectors/${encodeURIComponent(toolkit)}/authorize`, {
        method: "POST",
        body: JSON.stringify({ callbackUrl: `${window.location.origin}/connect/complete` }),
      });
      const authorization = await authResponse.json().catch(() => ({})) as AuthorizationResult;
      if (!authResponse.ok || !authorization.redirectUrl || !authorization.connectionRequestId) {
        throw new Error(authorization.error ?? "Could not start authorization.");
      }
      setConnectionRequestId(authorization.connectionRequestId);
      window.sessionStorage.setItem(PENDING_CONNECTOR_KEY, JSON.stringify({
        answer,
        toolkit,
        connectionRequestId: authorization.connectionRequestId,
      }));
      window.sessionStorage.setItem(CONNECTOR_RETURN_URL_KEY, window.location.href);
      window.location.assign(authorization.redirectUrl);
    } catch (error) {
      setConnectionError(friendlyConnectionError(error, toolkit));
    } finally {
      setConnectionBusy(false);
    }
  }, [completeSelection, onSubmit]);

  const handleRetry = useCallback(() => {
    if (!pendingAnswer) return;
    if (connectionError) {
      setConnectionRequestId(null);
      setConnectionError(null);
      void verifyOrConnect(pendingAnswer);
      return;
    }
    if (connectionRequestId) {
      void verifyPendingConnection();
      return;
    }
    void verifyOrConnect(pendingAnswer);
  }, [connectionError, connectionRequestId, pendingAnswer, verifyOrConnect, verifyPendingConnection]);

  const resetPending = useCallback(() => {
    setPendingAnswer(null);
    setPendingToolkit(null);
    setConnectionRequestId(null);
    setConnectionError(null);
    setReturnedFromAuthorization(false);
    window.sessionStorage.removeItem(PENDING_CONNECTOR_KEY);
    window.sessionStorage.removeItem(CONNECTOR_RETURN_URL_KEY);
  }, []);

  const pendingToolkitLabel = pendingToolkit
    ? pendingToolkit.charAt(0).toUpperCase() + pendingToolkit.slice(1)
    : "";

  useEffect(() => {
    if (!connectionError) return;
    toast.error(connectionError, { id: "connector-connection-error" });
  }, [connectionError]);

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
              {connectionBusy ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : null}
              <span className="truncate">
                {connectionError
                  ? `${pendingToolkitLabel} connection not completed`
                  : connectionRequestId
                  ? `Connect ${pendingToolkitLabel} to continue`
                  : `Verifying ${pendingToolkitLabel}…`}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                aria-label="Choose another app"
                disabled={connectionBusy}
                onClick={resetPending}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <LayoutGrid className="size-4" />
              </Button>
              <Button
                disabled={connectionBusy}
                onClick={handleRetry}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw className={connectionBusy ? "animate-spin" : undefined} />
                {connectionError ? "Try again" : "Refresh"}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <InteractivePromptMenu
          allowMultiple={allowMultiple}
          allowOther={allowOther}
          disabled={disabled || connectionBusy}
          onDismiss={onDismiss}
          onSubmit={(answer) => void verifyOrConnect(answer)}
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
