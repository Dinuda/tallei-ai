"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { loopBuilderHref, resolveLoopRunNavigation } from "@/lib/loop-run-navigation";

type LoopActivationCardProps = {
  workflowId: string;
  sessionId: string;
  phase?: string;
  triggerSummary?: string;
  latestRun?: { id: string } | null;
};

export function LoopActivationCard({
  workflowId,
  sessionId,
  phase,
  triggerSummary,
  latestRun,
}: LoopActivationCardProps) {
  const router = useRouter();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!workflowId || !["saved", "active", "verifying"].includes(phase ?? "")) return null;

  const openLoop = async () => {
    setOpening(true);
    setError(null);
    try {
      const href = await resolveLoopRunNavigation(workflowId, latestRun ?? undefined);
      router.push(href);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open loop");
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="rounded-lg border border-[#cce89e] bg-[#f8fdf2] p-4">
      <p className="text-sm font-semibold text-[#182506]">Loop is live</p>
      <p className="mt-1 text-sm text-[#3d5c18]">
        {triggerSummary ?? "Runs from your schedule or integrations appear on the run page automatically."}
      </p>
      <p className="mt-1 text-xs text-[#7a9a4a]">
        No triggered runs yet? Open loop to start watching or run a manual test.
      </p>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" className="h-9 gap-1.5" onClick={() => void openLoop()} disabled={opening}>
          {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          Open loop
        </Button>
        <p className="mt-1 text-[10px] text-[var(--text-muted)]">
          Goes to the run page (latest run, or starts a manual test).
        </p>
        <Button asChild type="button" variant="outline" className="h-9">
          <a href={loopBuilderHref(sessionId)}>Edit in builder</a>
        </Button>
      </div>
    </div>
  );
}
