"use client";

import { Mail } from "lucide-react";

import type { NewsletterSendMetadata } from "./newsletter-metadata";

export function NewsletterMetadataPanel({
  metadata,
  title = "What subscribers will receive",
  compact = false,
}: {
  metadata: NewsletterSendMetadata;
  title?: string;
  compact?: boolean;
}) {
  const hasContent = Boolean(metadata.subject || metadata.preview || metadata.greeting);
  if (!hasContent) return null;

  const rows = [
    { label: "Subject", value: metadata.subject },
    { label: "Preview text", value: metadata.preview },
    { label: "Intro", value: metadata.greeting },
  ].filter((row) => row.value);

  if (compact) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</p>
        <div className="mt-1.5 space-y-1">
          {rows.map((row) => (
            <p key={row.label} className="text-xs leading-5 text-slate-700">
              <span className="font-medium text-slate-900">{row.label}: </span>
              {row.value}
            </p>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-indigo-100">
          <Mail className="size-3.5 text-indigo-700" />
        </span>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</p>
      </div>
      <dl className="grid gap-px bg-slate-200/60 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-col gap-1 bg-white px-4 py-3">
            <dt className="text-[11px] font-medium text-slate-500">{row.label}</dt>
            <dd className="text-sm font-semibold leading-snug text-slate-900">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
