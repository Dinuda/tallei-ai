"use client";

import { ExternalLink, LoaderCircle, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { BuilderCompletedCard } from "@/components/conductor/builder-completed-card";
import { Button } from "@/components/ui/button";
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
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  const redirectUrl = output?.redirectUrl;
  const displayName = toolkit.charAt(0).toUpperCase() + toolkit.slice(1);

  const markConnected = useCallback(() => {
    setConnected(true);
    setBusy(false);
    setFallbackUrl(null);
  }, []);

  useEffect(() => {
    const onReturn = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "tallei-connector-complete") {
        return;
      }
      markConnected();
    };
    const onFocus = () => {
      if (busy) markConnected();
    };
    window.addEventListener("message", onReturn);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("message", onReturn);
      window.removeEventListener("focus", onFocus);
    };
  }, [busy, markConnected]);

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
    setFallbackUrl(null);
    const popup = window.open(redirectUrl, `connector-${toolkit}`, "popup=yes,width=560,height=760");
    if (!popup) setFallbackUrl(redirectUrl);
  }

  return (
    <div className="my-3 w-full border border-[var(--builder-indigo-border)] bg-[var(--builder-indigo-bg)]">
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
      </div>
    </div>
  );
}
