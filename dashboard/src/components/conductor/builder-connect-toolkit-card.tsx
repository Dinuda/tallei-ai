"use client";

import { ExternalLink, LoaderCircle, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { BuilderCompletedCard } from "@/components/conductor/builder-completed-card";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";

type ConnectToolkitOutput = {
  ok?: boolean;
  toolkit?: string;
  redirectUrl?: string;
  connectionRequestId?: string;
};

export function BuilderConnectToolkitCard({
  toolkit,
  output,
  state,
}: {
  toolkit: string;
  output?: ConnectToolkitOutput | null;
  state: string;
}) {
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const verifyingRef = useRef(false);

  const redirectUrl = output?.redirectUrl;
  const connectionRequestId = output?.connectionRequestId;
  const displayName = toolkit.charAt(0).toUpperCase() + toolkit.slice(1);

  const markConnected = useCallback(() => {
    setConnected(true);
    setBusy(false);
    setVerifyError(null);
    setFallbackUrl(null);
    verifyingRef.current = false;
  }, []);

  const verifyConnection = useCallback(async () => {
    if (verifyingRef.current) return;
    if (!connectionRequestId) {
      markConnected();
      return;
    }
    verifyingRef.current = true;
    setBusy(true);
    setVerifyError(null);
    try {
      const res = await apiFetch(
        `/api/connectors/authorize/${encodeURIComponent(connectionRequestId)}/verify`,
        {
          method: "POST",
          body: JSON.stringify({ toolkit }),
        },
      );
      const data = await res.json().catch(() => ({})) as { connected?: boolean; error?: string };
      if (res.ok && data.connected) {
        markConnected();
        return;
      }
      setVerifyError(data.error ?? "Connection not confirmed yet. Complete authorization and try again.");
    } catch {
      setVerifyError("Could not verify the connection. Try again.");
    } finally {
      verifyingRef.current = false;
    }
  }, [connectionRequestId, markConnected, toolkit]);

  useEffect(() => {
    const onReturn = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "tallei-connector-complete") {
        return;
      }
      void verifyConnection();
    };
    const onFocus = () => {
      if (busy) void verifyConnection();
    };
    window.addEventListener("message", onReturn);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("message", onReturn);
      window.removeEventListener("focus", onFocus);
    };
  }, [busy, verifyConnection]);

  if (connected) {
    return (
      <BuilderCompletedCard
        subtitle={`${displayName} is connected and ready to use.`}
        title="App connected"
        variant="emerald"
      />
    );
  }

  if (state !== "output-available" || !redirectUrl) {
    return null;
  }

  function openAuth() {
    if (!redirectUrl) return;
    setBusy(true);
    setVerifyError(null);
    setFallbackUrl(null);
    const popup = window.open(redirectUrl, `connector-${toolkit}`, "popup=yes,width=560,height=760");
    if (!popup) setFallbackUrl(redirectUrl);
  }

  return (
    <div className="w-full border border-[var(--builder-indigo-border)] bg-[var(--builder-indigo-bg)]" data-transcript-block>
      <div className="border-b border-[var(--builder-indigo-border-light)] bg-white px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center bg-[var(--builder-indigo-bg-solid)] text-[var(--builder-indigo-accent)]">
            <ShieldCheck className="size-4" />
          </span>
          <div>
            <div
              className="text-[14px] font-bold tracking-[-0.02em] text-[var(--builder-indigo-text)]"
              style={{ fontFamily: "var(--font-title)" }}
            >
              Connect {displayName}
            </div>
            <p className="mt-0.5 text-[13px] text-[var(--builder-indigo-text-muted)]">
              Authorize {displayName} so this loop can use it.
            </p>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 p-4">
        <Button
          className="bg-[var(--builder-indigo-accent)] text-white hover:bg-[var(--builder-indigo-accent-hover)]"
          disabled={busy}
          onClick={openAuth}
          size="sm"
          style={{ borderRadius: 0 }}
          type="button"
        >
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : `Connect ${displayName}`}
        </Button>
        {fallbackUrl ? (
          <a
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--builder-indigo-accent)] underline underline-offset-4"
            href={fallbackUrl}
            rel="noreferrer"
            target="_blank"
          >
            Open authorization <ExternalLink className="size-3" />
          </a>
        ) : null}
        {busy ? (
          <span className={cn("text-xs text-[var(--builder-indigo-text-muted)]")}>
            Complete authorization in the popup window…
          </span>
        ) : null}
        {verifyError ? (
          <span className={cn("text-xs text-red-600")}>{verifyError}</span>
        ) : null}
      </div>
    </div>
  );
}
