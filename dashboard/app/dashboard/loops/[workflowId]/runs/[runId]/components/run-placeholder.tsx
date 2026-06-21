"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export function RunPlaceholder({
  workflowId,
  runId,
  workflowTitle,
}: {
  workflowId: string;
  runId: string;
  workflowTitle?: string;
}) {
  return (
    <main className="flex h-[calc(100dvh-3.5rem)] flex-col items-center justify-center bg-white px-6 text-[#111827]">
      <div className="max-w-md text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6b7280]">
          Run view
        </p>
        <h1 className="mt-2 text-[20px] font-semibold">
          {workflowTitle?.trim() || "Loop run"}
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-[#6b7280]">
          The run interface is being rebuilt as a single chat thread.
          This run is paused until the new experience ships.
        </p>
        <p className="mt-2 font-mono text-[12px] text-[#9ca3af]">{runId}</p>
        <Link
          href={`/dashboard/loops/${workflowId}`}
          className="mt-6 inline-flex items-center gap-2 border border-[#d1d5db] bg-white px-4 py-2 text-[13px] font-medium text-[#374151] transition-colors hover:bg-[#f9fafb]"
        >
          <ArrowLeft className="size-4" />
          Back to loop
        </Link>
      </div>
    </main>
  );
}
