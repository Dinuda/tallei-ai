"use client";

import { Activity } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  formatBuilderUsageCompact,
  type BuilderLiveUsage,
} from "@/lib/loop-builder-usage";

export function ConductorUsageIndicator({ usage }: { usage: BuilderLiveUsage }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button className="conductor-builder-page__spec-trigger" type="button">
            <Activity className="size-3.5" />
            <span>{formatBuilderUsageCompact(usage)}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent align="start" className="w-56 p-3" side="top">
          <div className="space-y-1.5 text-xs">
            <p className="pb-1 text-[11px] text-background/60">Session total (estimated)</p>
            <div className="flex justify-between gap-4">
              <span className="text-background/70">Prompt tokens</span>
              <span>{usage.promptTokens.toLocaleString()}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-background/70">Completion tokens</span>
              <span>{usage.completionTokens.toLocaleString()}</span>
            </div>
            <div className="flex justify-between gap-4 border-t border-background/20 pt-1.5 font-medium">
              <span>Total</span>
              <span>{usage.totalTokens.toLocaleString()}</span>
            </div>
            <div className="flex justify-between gap-4 font-medium">
              <span>Estimated cost</span>
              <span>${usage.estimatedCostUsd.toFixed(4)}</span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
