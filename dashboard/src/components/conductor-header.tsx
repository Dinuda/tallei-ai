"use client";

import { ConductorLoopHeader } from "@/components/conductor/conductor-loop-header";
import { useConductorLayout } from "@/components/conductor/conductor-layout-context";

export function ConductorHeader() {
  const ctx = useConductorLayout();
  if (!ctx) return null;

  return (
    <div className="min-w-0 w-full">
      <ConductorLoopHeader
        loopId={ctx.loopId}
        loopName={ctx.loopName}
        onLoopNameChange={ctx.commitLoopName}
        status={ctx.status}
      />
    </div>
  );
}
