import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { EditorialActionButton } from "@/components/glyph-action";
import type { ArtifactRecord } from "./registry";

type EmailTemplateMeta = {
  subject?: string;
  preview?: string;
};

export function inferArtifactDisplayTitle(artifact: ArtifactRecord, fallbackLabel = "Draft") {
  const template = artifact.data_json?.emailTemplate as EmailTemplateMeta | undefined;
  if (template?.subject?.trim()) return template.subject.trim();

  if (template?.preview?.trim()) {
    const line = template.preview.trim().split("\n").find((value) => value.trim())?.trim() ?? "";
    if (line) return line.length > 56 ? `${line.slice(0, 53)}...` : line;
  }

  const hints = `${artifact.kind} ${artifact.artifact_key}`.toLowerCase();
  if (hints.includes("newsletter")) return "Newsletter draft";
  if (hints.includes("email")) return "Email draft";
  if (hints.includes("report")) return "Report draft";
  if (hints.includes("brief")) return "Brief draft";
  return `${fallbackLabel} draft`;
}

export function EditorialArtifactTag({
  children,
  tone = "blue",
}: {
  children: ReactNode;
  tone?: "blue" | "neutral" | "green";
}) {
  const toneClass = tone === "green"
    ? "border-[#86c8a8] bg-[#edf8f2] text-[#166534]"
    : tone === "blue"
      ? "border-[#9bb8d9] bg-[#edf3fb] text-[#2d5a87]"
      : "border-[#e5e7eb] bg-[#fafafa] text-[#6b7280]";
  return (
    <span
      className={cn("shrink-0 border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase", toneClass)}
      style={{ fontFamily: "var(--font-fustat)" }}
    >
      {children}
    </span>
  );
}

export function EditorialOpenEditorButton({
  onClick,
  label = "Edit draft",
  disabled,
}: {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <EditorialActionButton
      label={label}
      glyph="edit"
      variant="primary"
      onClick={onClick}
      disabled={disabled}
    />
  );
}

export function EditorialArtifactToolbar({
  tag,
  title,
  hint,
  action,
}: {
  tag: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border border-[#d1d5db] bg-[#fafafa] px-4 py-3">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <EditorialArtifactTag>{tag}</EditorialArtifactTag>
          <p
            className="truncate text-[14px] font-semibold text-[#111827]"
            style={{ fontFamily: "var(--font-title)" }}
          >
            {title}
          </p>
        </div>
        {hint ? (
          <p className="mt-1 text-[12px] leading-5 text-[#6b7280]" style={{ fontFamily: "var(--font-fustat)" }}>
            {hint}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function EditorialPreviewFrame({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title: string;
  className?: string;
}) {
  return (
    <div className={cn("border border-t-0 border-[#d1d5db] bg-white", className)}>
      {children}
    </div>
  );
}

export function editorialEditorDialogClass(width = "!max-w-[90vw]") {
  return cn(
    width,
    "flex max-h-[92vh] flex-col gap-0 overflow-hidden rounded-none border border-[#d1d5db] bg-white p-0 shadow-none ring-0",
  );
}

export function EditorialEditorDialogHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      className="border-b border-[#e5e7eb] bg-[#fafafa] px-6 py-5"
      style={{ fontFamily: "var(--font-fustat)" }}
    >
      <h2
        className="text-[20px] font-bold tracking-[-0.02em] text-[#111827]"
        style={{ fontFamily: "var(--font-title)" }}
      >
        {title}
      </h2>
      <p className="mt-1 text-[14px] leading-6 text-[#6b7280]">{description}</p>
    </div>
  );
}
