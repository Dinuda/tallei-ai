"use client";

import { useEffect, useState } from "react";
import { Check, Clock3, Circle, LoaderCircle, Webhook } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ScheduleSelectionOutput = {
  answerText: string;
  requirementId: string;
  value: {
    trigger: "schedule";
    cron: string;
    timezone: string;
  } | {
    trigger: "event";
    toolkit: string;
    triggerSlug: string;
  };
};

type ScheduleOption = {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  value: ScheduleSelectionOutput["value"];
};

export function BuilderScheduleSelector({
  completedOutput,
  onComplete,
  requirementId,
  sessionId,
}: {
  completedOutput?: ScheduleSelectionOutput | null;
  onComplete?: (output: ScheduleSelectionOutput) => void;
  requirementId: string;
  sessionId: string;
}) {
  const [events, setEvents] = useState<Array<{ toolkit: string; slug: string; name: string; description: string }>>([]);
  const [loading, setLoading] = useState(!completedOutput);

  useEffect(() => {
    if (completedOutput) return;
    let cancelled = false;
    void fetch(`/api/loop-builder/sessions/${sessionId}/schedule-options`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load schedule options");
        if (!cancelled) setEvents(Array.isArray(payload.capabilities?.events) ? payload.capabilities.events : []);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [completedOutput, sessionId]);

  if (completedOutput) {
    return (
      <div className="my-3 border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center bg-amber-600 text-white">
            {completedOutput.value.trigger === "event" ? <Webhook className="size-4" /> : <Clock3 className="size-4" />}
          </span>
          <div>
            <div className="text-sm font-semibold text-amber-950" style={{ fontFamily: "var(--font-title)" }}>Schedule selected</div>
            <div className="text-xs text-amber-700">{completedOutput.answerText}</div>
          </div>
        </div>
      </div>
    );
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const options: ScheduleOption[] = [
    ...events.map((event, index) => ({
      id: `event-${event.toolkit}-${event.slug}`,
      label: event.name,
      description: event.description,
      icon: <Webhook className="size-4 text-amber-600" />,
      value: { trigger: "event" as const, toolkit: event.toolkit, triggerSlug: event.slug },
    })),
    {
      id: "schedule-hourly",
      label: "Run every hour",
      description: "Check once per hour.",
      icon: <Clock3 className="size-4 text-slate-500" />,
      value: { trigger: "schedule" as const, cron: "0 * * * *", timezone },
    },
    {
      id: "schedule-daily",
      label: "Run daily",
      description: "Check once per day at 9:00 AM.",
      icon: <Clock3 className="size-4 text-slate-500" />,
      value: { trigger: "schedule" as const, cron: "0 9 * * *", timezone },
    },
  ];

  function select(option: ScheduleOption) {
    onComplete?.({
      answerText: option.label,
      requirementId,
      value: option.value,
    });
  }

  return (
    <div className="w-full overflow-hidden bg-white border border-[#d1d5db]">
      <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center bg-slate-100 text-slate-600">
            <Clock3 className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-bold tracking-[-0.02em] text-[#111827]" style={{ fontFamily: "var(--font-title)" }}>Choose a schedule</h2>
            <p className="mt-0.5 text-[13px] text-[#6b7280]">
              {!loading && events.length > 0
                ? "Choose what should start this loop."
                : "Real-time triggers are not available for these connected apps yet. Choose hourly or daily instead."}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-1 p-2">
        {loading && (
          <div className="flex items-center gap-2 px-3 py-5 text-xs text-[#6b7280]">
            <LoaderCircle className="size-4 animate-spin" /> Checking available triggers...
          </div>
        )}
        {!loading && options.map((option, index) => (
          <button
            className={cn(
              "flex w-full items-start gap-3 border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-[#fafafa]",
            )}
            key={option.id}
            onClick={() => select(option)}
            type="button"
          >
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center border border-[#e5e7eb] bg-white">
              {option.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-sm font-semibold text-[#111827]" style={{ fontFamily: "var(--font-title)" }}>{option.label}</span>
              <span className="mt-0.5 block text-xs text-[#6b7280]">{option.description}</span>
            </span>
            <Circle className="mt-2 size-2 text-[#d1d5db]" />
          </button>
        ))}
      </div>
    </div>
  );
}
