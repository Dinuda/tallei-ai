"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, RefreshCw, X } from "lucide-react";

type IntegrationAsset =
  | {
      assetKey: "chatgpt_openapi";
      label: string;
      latestVersion: string;
      actionKind: "open_setup";
      action: {
        setupPath: string;
        openApiPath: string;
      };
    }
  | {
      assetKey: "claude_instructions";
      label: string;
      latestVersion: string;
      actionKind: "copy_text";
      action: {
        copyText: string;
      };
    };

type UpdatesResponse = {
  updates?: IntegrationAsset[];
};

function isIntegrationAsset(value: unknown): value is IntegrationAsset {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IntegrationAsset>;
  if (candidate.assetKey !== "chatgpt_openapi" && candidate.assetKey !== "claude_instructions") {
    return false;
  }
  return typeof candidate.label === "string" && typeof candidate.latestVersion === "string";
}

export function DashboardUpdateBanner() {
  const [updates, setUpdates] = useState<IntegrationAsset[]>([]);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [acknowledging, setAcknowledging] = useState(false);

  useEffect(() => {
    let canceled = false;

    async function loadUpdates() {
      try {
        const response = await fetch("/api/integration-updates", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as UpdatesResponse;
        const nextUpdates = Array.isArray(payload.updates)
          ? payload.updates.filter(isIntegrationAsset)
          : [];
        if (!canceled) setUpdates(nextUpdates);
      } catch {
        if (!canceled) setUpdates([]);
      }
    }

    void loadUpdates();
    return () => {
      canceled = true;
    };
  }, []);

  const claudeUpdate = useMemo(
    () => updates.find((update) => update.assetKey === "claude_instructions"),
    [updates]
  );
  const chatGptUpdate = useMemo(
    () => updates.find((update) => update.assetKey === "chatgpt_openapi"),
    [updates]
  );

  const handleCopyClaude = useCallback(async () => {
    if (!claudeUpdate || claudeUpdate.actionKind !== "copy_text") return;
    try {
      await navigator.clipboard.writeText(claudeUpdate.action.copyText);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("idle");
    }
  }, [claudeUpdate]);

  const acknowledgeAll = useCallback(async () => {
    if (updates.length === 0) return;
    setAcknowledging(true);
    try {
      const responses = await Promise.all(
        updates.map((update) =>
          fetch(`/api/integration-updates/${encodeURIComponent(update.assetKey)}/acknowledge`, {
            method: "POST",
          })
        )
      );

      if (responses.every((response) => response.ok)) {
        setUpdates([]);
      }
    } finally {
      setAcknowledging(false);
    }
  }, [updates]);

  if (updates.length === 0) return null;

  const uiFontStyle = {
    fontFamily:
      "var(--font-fustat, var(--font-sans, ui-sans-serif)), var(--font-sans, ui-sans-serif), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  } as const;

  return (
    <section className="px-4 pt-4 sm:px-6" aria-label="Integration updates" style={uiFontStyle}>
      <div className="flex flex-col gap-3 border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Update your setup to enjoy the best experience</p>
          <p className="mt-1 text-sm text-amber-900">
            Latest versions:{" "}
            {updates.map((update) => `${update.label} v${update.latestVersion}`).join(", ")}.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {claudeUpdate?.actionKind === "copy_text" ? (
            <button
              type="button"
              onClick={() => void handleCopyClaude()}
              className="inline-flex h-9 items-center gap-2 border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-950 hover:bg-amber-100"
            >
              {copyState === "copied" ? <Check size={15} /> : <Copy size={15} />}
              {copyState === "copied" ? "Copied" : "Copy Claude update"}
            </button>
          ) : null}

          {chatGptUpdate?.actionKind === "open_setup" ? (
            <Link
              href={chatGptUpdate.action.setupPath}
              className="inline-flex h-9 items-center gap-2 border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-950 hover:bg-amber-100"
            >
              <ExternalLink size={15} />
              Open ChatGPT guide
            </Link>
          ) : null}

          <button
            type="button"
            onClick={() => void acknowledgeAll()}
            disabled={acknowledging}
            className="inline-flex h-9 items-center gap-2 border border-amber-300 bg-amber-500 px-3 text-sm font-semibold text-amber-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Dismiss integration update banner"
          >
            {acknowledging ? <RefreshCw size={15} className="animate-spin" /> : <X size={15} />}
            Hide
          </button>
        </div>
      </div>
    </section>
  );
}
