"use client";

import { useEffect, useState } from "react";
import { Check, Clock3, LoaderCircle, Webhook } from "lucide-react";

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
      <div className="my-3 border border-[#d1d5db] bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center bg-[#111827] text-white">
            <Check className="size-4" />
          </span>
          <div>
            <div className="text-sm font-semibold text-[#111827]" style={{ fontFamily: "var(--font-title)" }}>Schedule selected</div>
            <div className="text-xs text-[#6b7280]">{completedOutput.answerText}</div>
          </div>
        </div>
      </div>
    );
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const choices = [
    { label: "Run every hour", description: "Check once per hour.", cron: "0 * * * *" },
    { label: "Run daily", description: "Check once per day at 9:00 AM.", cron: "0 9 * * *" },
  ];

  return (
    <div className="w-full border border-[#d1d5db] bg-white">
      <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center bg-[#e5e7eb] text-[#6b7280]">
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

      <div className="p-4">
        {loading && (
          <div className="flex items-center gap-2 border border-dashed border-[#d1d5db] bg-[#fafafa] px-4 py-5 text-xs text-[#6b7280]">
            <LoaderCircle className="size-4 animate-spin" /> Checking available triggers...
          </div>
        )}

        {!loading && events.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-[#6b7280] uppercase" style={{ fontFamily: "var(--font-title)" }}>Event triggers</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {events.map((event) => (
                <Button
                  className={cn(
                    "h-auto min-h-[72px] justify-start border bg-white px-4 py-3 text-left transition-colors",
                    "border-[#e5e7eb] text-[#111827] hover:border-[#d1d5db] hover:bg-[#fafafa]"
                  )}
                  key={`${event.toolkit}:${event.slug}`}
                  onClick={() => onComplete?.({
                    answerText: event.name,
                    requirementId,
                    value: { trigger: "event", toolkit: event.toolkit, triggerSlug: event.slug },
                  })}
                  variant="outline"
                  style={{ borderRadius: 0 }}
                >
                  <Webhook className="mr-3 size-4 shrink-0 text-[#6b7280]" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium" style={{ fontFamily: "var(--font-title)" }}>{event.name}</span>
                    <span className="mt-0.5 block text-xs font-normal text-[#6b7280]">{event.description}</span>
                  </span>
                </Button>
              ))}
            </div>
          </div>
        )}

        <div>
          {!loading && events.length > 0 && (
            <p className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-[#6b7280] uppercase" style={{ fontFamily: "var(--font-title)" }}>Schedule</p>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {choices.map((choice) => (
              <Button
                className={cn(
                  "h-auto min-h-[72px] justify-start border bg-white px-4 py-3 text-left transition-colors",
                  "border-[#e5e7eb] text-[#111827] hover:border-[#d1d5db] hover:bg-[#fafafa]"
                )}
                key={choice.cron}
                onClick={() => onComplete?.({
                  answerText: choice.label,
                  requirementId,
                  value: { trigger: "schedule", cron: choice.cron, timezone },
                })}
                variant="outline"
                style={{ borderRadius: 0 }}
              >
                <Clock3 className="mr-3 size-4 shrink-0 text-[#6b7280]" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium" style={{ fontFamily: "var(--font-title)" }}>{choice.label}</span>
                  <span className="mt-0.5 block text-xs font-normal text-[#6b7280]">{choice.description}</span>
                </span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
