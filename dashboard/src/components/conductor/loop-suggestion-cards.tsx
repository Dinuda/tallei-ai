"use client";

import { cn } from "@/lib/utils";

const STARTER_PROMPTS = [
  {
    id: "support-inbox",
    title: "Support inbox triage",
    description: "Read new tickets, classify priority, and draft replies for review.",
    message: "When a support ticket arrives, classify it by priority and create a reply draft for my review before anything is sent.",
  },
  {
    id: "weekly-digest",
    title: "Weekly team digest",
    description: "Summarize activity and send a recurring update.",
    message: "Create a weekly loop that summarizes what happened in our tools and emails me a digest every Monday morning.",
  },
  {
    id: "lead-followup",
    title: "Lead follow-up",
    description: "Watch for new leads and draft personalized outreach.",
    message: "When a new lead comes in, research them and draft a personalized follow-up email for my review before sending.",
  },
];

export function LoopSuggestionCards({
  className,
  onSelect,
}: {
  className?: string;
  onSelect: (message: string) => void;
}) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-3", className)}>
      {STARTER_PROMPTS.map((prompt) => (
        <button
          className="border border-[var(--cb-border,#d1d5db)] bg-white p-4 text-left transition-colors hover:border-[#9ca3af] hover:bg-slate-50"
          key={prompt.id}
          onClick={() => onSelect(prompt.message)}
          type="button"
        >
          <div
            className="text-sm font-semibold text-[var(--cb-text,#111827)]"
            style={{ fontFamily: "var(--font-title)" }}
          >
            {prompt.title}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--cb-text-muted,#6b7280)]">
            {prompt.description}
          </p>
        </button>
      ))}
    </div>
  );
}
