"use client";

import { Mail } from "lucide-react";

import { cn } from "@/lib/utils";

export type InboundEmailSummary = {
  event: string;
  subject: string;
  customerName: string;
  customerEmail: string;
  bodyPreview: string;
};

function formatTriggerLabel(event: string): string {
  const normalized = event.trim();
  if (!normalized) return "Inbound email";
  if (/gmail/i.test(normalized)) return "New Gmail message";
  return normalized
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function senderInitials(name: string, email: string): string {
  const fromName = name.trim();
  if (fromName) {
    return fromName
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }
  return email.slice(0, 2).toUpperCase() || "?";
}

export function InboundEmailTriggerCard({ summary }: { summary: InboundEmailSummary }) {
  const displayName = summary.customerName.trim() || summary.customerEmail.split("@")[0] || "Customer";
  const initials = senderInitials(summary.customerName, summary.customerEmail);
  const triggerLabel = formatTriggerLabel(summary.event);

  return (
    <div className="w-full max-w-[760px]">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e4f5c6] bg-[#f8fdf2] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#3d5c18]">
          <Mail className="size-3.5 text-[#7eb71b]" />
          Run trigger
        </span>
        <span className="text-[12px] text-[#7a9a4a]">{triggerLabel}</span>
      </div>

      <article
        className={cn(
          "overflow-hidden rounded-xl border border-[#e5e7eb] bg-white shadow-sm",
          "ring-1 ring-black/[0.02]",
        )}
      >
        <div className="flex items-start gap-3 border-b border-[#f3f4f6] bg-[#fafafa] px-4 py-3.5">
          <div
            className="grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#ea4335] to-[#c5221f] text-[13px] font-bold text-white"
            aria-hidden
          >
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <p className="text-[14px] font-semibold text-[#111827]">{displayName}</p>
              {summary.customerEmail ? (
                <p className="truncate text-[13px] text-[#6b7280]">&lt;{summary.customerEmail}&gt;</p>
              ) : null}
            </div>
            <p className="mt-0.5 text-[12px] text-[#9ca3af]">to your support inbox</p>
          </div>
        </div>

        <div className="px-4 py-4">
          <h3 className="text-[17px] font-semibold leading-snug tracking-[-0.01em] text-[#111827]">
            {summary.subject || "No subject"}
          </h3>
          {summary.bodyPreview ? (
            <p className="mt-3 whitespace-pre-wrap text-[14px] leading-6 text-[#374151]">
              {summary.bodyPreview}
            </p>
          ) : (
            <p className="mt-3 text-[14px] italic text-[#9ca3af]">No message body.</p>
          )}
        </div>

        <footer className="border-t border-[#f3f4f6] bg-[#fcfcfd] px-4 py-2.5 text-[12px] text-[#6b7280]">
          This message started the run.
        </footer>
      </article>
    </div>
  );
}
