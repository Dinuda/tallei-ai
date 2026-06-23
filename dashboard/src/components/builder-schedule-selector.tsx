"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Clock3, Webhook } from "lucide-react";

import {
  InteractivePromptMenu,
  type InteractivePromptAnswer,
  type InteractivePromptOption,
} from "@/components/ai-elements/interactive-prompt-menu";

export type ScheduleSetupOption = {
  id: string;
  label: string;
  description?: string;
  trigger?: "schedule" | "event";
  cron?: string;
  timezone?: string;
  toolkit?: string;
  triggerSlug?: string;
};

export type ScheduleSelectionOutput = InteractivePromptAnswer & {
  requirementId: string;
  value?: {
    trigger: "schedule";
    cron: string;
    timezone: string;
  } | {
    trigger: "event";
    toolkit: string;
    triggerSlug: string;
  };
};

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function defaultScheduleOptions(timezone: string): ScheduleSetupOption[] {
  return [
    {
      id: "schedule-hourly",
      label: "Every hour",
      description: "Check once per hour — the fastest supported cadence.",
      trigger: "schedule",
      cron: "0 * * * *",
      timezone,
    },
    {
      id: "schedule-daily",
      label: "Daily at 9:00 AM",
      description: "Run once each morning.",
      trigger: "schedule",
      cron: "0 9 * * *",
      timezone,
    },
    {
      id: "schedule-weekly",
      label: "Weekly on Monday at 9:00 AM",
      description: "Good for newsletters, digests, and weekly reports.",
      trigger: "schedule",
      cron: "0 9 * * 1",
      timezone,
    },
  ];
}

function scheduleValueForOption(option: ScheduleSetupOption, timezone: string): ScheduleSelectionOutput["value"] | null {
  if (option.trigger === "event" && option.toolkit && option.triggerSlug) {
    return { trigger: "event", toolkit: option.toolkit, triggerSlug: option.triggerSlug };
  }
  if (option.cron) {
    return {
      trigger: "schedule",
      cron: option.cron,
      timezone: option.timezone?.trim() || timezone,
    };
  }
  return null;
}

function buildPromptOptions(
  configured: ScheduleSetupOption[],
  events: Array<{ toolkit: string; slug: string; name: string; description: string }>,
  timezone: string,
): { options: InteractivePromptOption[]; valuesById: Map<string, ScheduleSelectionOutput["value"]> } {
  const valuesById = new Map<string, ScheduleSelectionOutput["value"]>();
  const merged: ScheduleSetupOption[] = [
    ...events.map((event) => ({
      id: `event-${event.toolkit}-${event.slug}`,
      label: event.name,
      description: event.description,
      trigger: "event" as const,
      toolkit: event.toolkit,
      triggerSlug: event.slug,
    })),
    ...(configured.length > 0 ? configured : defaultScheduleOptions(timezone)),
  ];

  const options = merged.flatMap((option) => {
    const value = scheduleValueForOption(option, timezone);
    if (!value) return [];
    valuesById.set(option.id, value);
    return [{
      id: option.id,
      label: option.label,
      description: option.description,
      value: option.label,
    }];
  });

  return { options, valuesById };
}

export function BuilderScheduleSelector({
  allowOther = true,
  completedOutput,
  onComplete,
  options: configuredOptions = [],
  question = "Choose a schedule",
  recommendedOptionIds = [],
  requirementId,
  sessionId,
  subtitle,
}: {
  allowOther?: boolean;
  completedOutput?: ScheduleSelectionOutput | null;
  onComplete?: (output: ScheduleSelectionOutput) => void;
  options?: ScheduleSetupOption[];
  question?: string;
  recommendedOptionIds?: string[];
  requirementId: string;
  sessionId: string;
  subtitle?: string;
}) {
  const [events, setEvents] = useState<Array<{ toolkit: string; slug: string; name: string; description: string }>>([]);
  const [loading, setLoading] = useState(!completedOutput);
  const timezone = useMemo(() => defaultTimezone(), []);

  useEffect(() => {
    if (completedOutput) return;
    let cancelled = false;
    void fetch(`/api/conductor/sessions/${sessionId}/schedule-options`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load schedule options");
        if (!cancelled) setEvents(Array.isArray(payload.capabilities?.events) ? payload.capabilities.events : []);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [completedOutput, sessionId]);

  const { options, valuesById } = useMemo(
    () => buildPromptOptions(configuredOptions, events, timezone),
    [configuredOptions, events, timezone],
  );

  if (completedOutput) {
    return (
      <div className="my-3 border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center bg-amber-600 text-white">
            {completedOutput.value?.trigger === "event" ? <Webhook className="size-4" /> : <Clock3 className="size-4" />}
          </span>
          <div>
            <div className="text-sm font-semibold text-amber-950" style={{ fontFamily: "var(--font-title)" }}>Schedule selected</div>
            <div className="text-xs text-amber-700">{completedOutput.answerText}</div>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="w-full border border-[#d1d5db] bg-white px-4 py-5 text-sm text-[#6b7280]">
        Checking available triggers...
      </div>
    );
  }

  return (
    <div className="w-full overflow-hidden border border-[#d1d5db] bg-white">
      {subtitle && (
        <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-2 text-[13px] text-[#6b7280]">
          {subtitle}
        </div>
      )}
      <InteractivePromptMenu
        allowOther={allowOther}
        onSubmit={(answer) => {
          const selectedId = answer.selectedOptionIds[0];
          const value = selectedId ? valuesById.get(selectedId) : undefined;
          const customScheduleText = answer.otherText?.trim();
          onComplete?.({
            requirementId,
            ...answer,
            ...(value ? { value } : {}),
            ...(customScheduleText ? { customScheduleText } : {}),
          });
        }}
        options={options}
        placement="composer"
        question={question}
        recommendedOptionIds={recommendedOptionIds}
        submittedAnswer={completedOutput ?? undefined}
      />
    </div>
  );
}
