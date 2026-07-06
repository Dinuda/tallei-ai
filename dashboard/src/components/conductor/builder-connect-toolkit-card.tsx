"use client";

import { LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";

import { BuilderCompletedCard } from "@/components/conductor/builder-completed-card";
import { connectorLogoUrl } from "@/components/conductor/conductor-shared";
import {
  formatToolkitLabel,
  useConnectorAuthorization,
} from "@/components/conductor/use-connector-authorization";
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
  const redirectUrl = output?.redirectUrl;
  const connectionRequestId = output?.connectionRequestId;
  const displayName = formatToolkitLabel(toolkit);
  const returnedFromAuthKey = useMemo(
    () => (connectionRequestId ? `tallei.pendingToolkitAuthorization:${connectionRequestId}` : null),
    [connectionRequestId],
  );
  const [connected, setConnected] = useState(false);

  const {
    busy,
    statusLabel,
    canRestart,
    restartConnection,
  } = useConnectorAuthorization({
    toolkit,
    onConnected: () => setConnected(true),
    initialAuth: redirectUrl && connectionRequestId
      ? { redirectUrl, connectionRequestId }
      : undefined,
    autoStart: state === "output-available" && Boolean(redirectUrl),
    returnedFromAuthKey,
  });

  if (connected) {
    return (
      <BuilderCompletedCard
        iconAlt={toolkit}
        iconSrc={connectorLogoUrl(toolkit)}
        subtitle={`${displayName} is connected and ready to use.`}
        title="App connected"
        variant="emerald"
      />
    );
  }

  if (state !== "output-available" || !redirectUrl) {
    return null;
  }

  return (
    <div className="w-full border border-[var(--builder-indigo-border)] bg-[var(--builder-indigo-bg)]" data-transcript-block>
      <div className="border-b border-[var(--builder-indigo-border-light)] bg-white px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--builder-indigo-border-light)] bg-white">
            <img
              alt={toolkit}
              className="size-5 object-contain"
              draggable={false}
              src={connectorLogoUrl(toolkit)}
            />
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
        {busy ? (
          <span className={cn("flex items-center gap-2 text-sm text-[var(--builder-indigo-text)]")}>
            <LoaderCircle className="size-4 animate-spin" />
            {statusLabel || `Connecting ${displayName}…`}
          </span>
        ) : canRestart ? (
          <Button
            className="bg-[var(--builder-indigo-accent)] text-white hover:bg-[var(--builder-indigo-accent-hover)]"
            onClick={restartConnection}
            size="sm"
            style={{ borderRadius: 0 }}
            type="button"
          >
            Restart connection
          </Button>
        ) : (
          <span className={cn("text-xs text-[var(--builder-indigo-text-muted)]")}>
            Redirecting to authorization…
          </span>
        )}
      </div>
    </div>
  );
}
