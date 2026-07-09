"use client";

import { AlertCircle, Info } from "lucide-react";
import { useState } from "react";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { ToolOutput } from "@/components/ai-elements/tool";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function TestRunHeaderStatus({
  status,
}: {
  status: "running" | "passed" | "failed";
}) {
  if (status === "running") {
    return (
      <span className="agent-team-lab-badge__status agent-team-lab-badge__status--running">
        <Shimmer className="text-[11px] font-medium">Running test…</Shimmer>
      </span>
    );
  }

  if (status === "passed") {
    return (
      <span className={cn("agent-team-lab-badge__status", "agent-team-lab-badge__status--passed")}>
        Test passed
      </span>
    );
  }

  return (
    <span className={cn("agent-team-lab-badge__status", "agent-team-lab-badge__status--failed")}>
      Test failed
    </span>
  );
}

function TechnicalDetailsDialog({
  output,
  errors,
}: {
  output: unknown;
  errors?: string[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          aria-label="Technical details"
          className="agent-team-lab-badge__info-btn"
          type="button"
        >
          <Info aria-hidden className="size-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(80vh,40rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Technical details</DialogTitle>
        </DialogHeader>
        {errors?.length ? (
          <ul className="space-y-1 text-sm leading-5 text-red-800">
            {errors.map((error) => (
              <li key={error} className="flex gap-2">
                <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <ToolOutput errorText={undefined} output={output} />
      </DialogContent>
    </Dialog>
  );
}

export function TestRunLabHeader({
  isRunning,
  footer,
  errors,
  output,
}: {
  isRunning: boolean;
  footer: "running" | "passed" | "failed" | null;
  errors?: string[];
  output?: unknown;
}) {
  const status = isRunning ? "running" : footer;
  const showStatus = status === "running" || status === "passed" || status === "failed";

  return (
    <div aria-label="Lab test run" className="agent-team-lab-badge agent-team-lab-badge--with-actions">
      <div className="agent-team-lab-badge__brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          aria-hidden
          className="agent-team-lab-badge__icon"
          draggable={false}
          height={24}
          src="/svg/wool-lab.svg"
          width={24}
        />
        <span aria-hidden className="agent-team-lab-badge__text agent-team-lab-badge__text--long">
          LAB - TEST RUN
        </span>
      </div>
      {showStatus || output ? (
        <div className="agent-team-lab-badge__actions">
          {showStatus && status ? <TestRunHeaderStatus status={status} /> : null}
          {output ? <TechnicalDetailsDialog errors={errors} output={output} /> : null}
        </div>
      ) : null}
    </div>
  );
}
