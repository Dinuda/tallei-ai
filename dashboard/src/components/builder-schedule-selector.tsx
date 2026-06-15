"use client";

import { useEffect, useState } from "react";
import { Check, Clock3, LoaderCircle, Webhook } from "lucide-react";

import { Button } from "@/components/ui/button";

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
      <div className="my-3 border border-[#d1d5db] bg-white">
        <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-2">
          <p className="text-[10px] font-semibold tracking-[0.1em] text-[#6b7280] uppercase">Schedule selected</p>
        </div>
        <div className="p-4 text-[13px] leading-6 text-[#111827]">{completedOutput.answerText}</div>
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
        <h2 className="text-[14px] font-bold tracking-[-0.02em] text-[#111827]">Choose a schedule</h2>
        <p className="mt-0.5 text-[13px] text-[#6b7280]">
          {!loading && events.length > 0
            ? "Choose what should start this loop."
            : "Real-time triggers are not available for these connected apps yet. Choose hourly or daily instead."}
        </p>
      </div>

      <div className="p-4">
        {loading && <div className="flex items-center justify-center gap-2 py-5 text-xs text-[#6b7280]"><LoaderCircle className="size-4 animate-spin" /> Checking available triggers...</div>}
        {!loading && events.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-[#6b7280] uppercase">Event triggers</p>
            <div className="space-y-1">
              {events.map((event) => (
                <Button
                  className="h-auto w-full justify-start border border-[#d1d5db] bg-white px-4 py-4 text-left text-[#111827] hover:bg-[#fafafa]"
                  key={`${event.toolkit}:${event.slug}`}
                  onClick={() => onComplete?.({
                    answerText: event.name,
                    requirementId,
                    value: { trigger: "event", toolkit: event.toolkit, triggerSlug: event.slug },
                  })}
                  variant="outline"
                  style={{ borderRadius: 0 }}
                >
                  <Webhook className="mr-3 size-4 shrink-0 text-[#d97706]" />
                  <span><span className="block text-sm font-medium">{event.name}</span><span className="mt-1 block text-xs font-normal text-[#6b7280]">{event.description}</span></span>
                </Button>
              ))}
            </div>
          </div>
        )}
        <div>
          {!loading && events.length > 0 && (
            <p className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-[#6b7280] uppercase">Schedule</p>
          )}
          <div className="space-y-1">
            {choices.map((choice) => (
              <Button
                className="h-auto w-full justify-start border border-[#d1d5db] bg-white px-4 py-4 text-left text-[#111827] hover:bg-[#fafafa]"
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
                <span><span className="block text-sm font-medium">{choice.label}</span><span className="mt-1 block text-xs font-normal text-[#6b7280]">{choice.description}</span></span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
