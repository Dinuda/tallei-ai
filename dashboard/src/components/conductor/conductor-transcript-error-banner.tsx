"use client";

import { AlertCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ConductorTranscriptError } from "@/lib/conductor-transcript-error";
import { cn } from "@/lib/utils";

export function ConductorTranscriptErrorBanner({
  error,
  onRetry,
  className,
}: {
  error: ConductorTranscriptError;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <Alert
      className={cn("conductor-transcript-error", className)}
      variant="destructive"
    >
      <AlertCircle />
      <AlertTitle>{error.title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{error.message}</span>
        {error.detail && error.detail !== error.message ? (
          <span className="font-mono text-xs opacity-80">{error.detail}</span>
        ) : null}
        {error.retryable && onRetry ? (
          <button
            className="conductor-transcript-error__retry"
            onClick={onRetry}
            type="button"
          >
            Retry
          </button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
