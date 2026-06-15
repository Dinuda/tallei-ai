import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const editorialDialogContentClass =
  "flex flex-col overflow-hidden rounded-none border border-[#d1d5db] bg-white p-0 shadow-none ring-0";

export function EditorialDialogHeader({
  title,
  description,
  meta,
}: {
  title: string;
  description?: string;
  meta?: ReactNode;
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
      {description ? (
        <p className="mt-1 text-[14px] leading-6 text-[#6b7280]">{description}</p>
      ) : null}
      {meta ? <div className="mt-4 flex flex-wrap items-center gap-2">{meta}</div> : null}
    </div>
  );
}

export function EditorialDialogBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-5", className)}
      style={{ fontFamily: "var(--font-fustat)" }}
    >
      {children}
    </div>
  );
}

export function EditorialDialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[#e5e7eb] bg-[#fafafa] px-6 py-4">
      {children}
    </div>
  );
}

export function EditorialField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border border-[#e5e7eb] bg-white", className)}>
      <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-2">
        <p
          className="text-[10px] font-semibold tracking-[0.1em] text-[#6b7280] uppercase"
          style={{ fontFamily: "var(--font-title)" }}
        >
          {label}
        </p>
      </div>
      <div className="px-4 py-3 text-[14px] leading-6 text-[#111827]">{children}</div>
    </div>
  );
}

export function EditorialStatGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

export function EditorialStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border border-[#e5e7eb] bg-white">
      <div className="border-b border-[#e5e7eb] bg-[#fafafa] px-4 py-2">
        <p
          className="text-[10px] font-semibold tracking-[0.1em] text-[#6b7280] uppercase"
          style={{ fontFamily: "var(--font-title)" }}
        >
          {label}
        </p>
      </div>
      <p className="px-4 py-3 text-[22px] font-bold tracking-[-0.02em] text-[#111827]">{value}</p>
    </div>
  );
}

export function EditorialPanel({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border border-[#d1d5db] bg-white", className)}>
      <header className="border-b border-[#e5e7eb] bg-[#fafafa] px-5 py-3.5">
        <h3
          className="text-[14px] font-bold tracking-[-0.02em] text-[#111827]"
          style={{ fontFamily: "var(--font-title)" }}
        >
          {title}
        </h3>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function EditorialListRow({
  title,
  meta,
  subtitle,
  body,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  subtitle?: ReactNode;
  body?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-b border-[#e5e7eb] bg-white px-4 py-4 last:border-b-0", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-[#111827]" style={{ fontFamily: "var(--font-title)" }}>
            {title}
          </p>
          {subtitle ? <p className="mt-0.5 text-[12px] text-[#9ca3af]">{subtitle}</p> : null}
        </div>
        {meta}
      </div>
      {body ? <div className="mt-3 text-[13px] leading-6 text-[#6b7280]">{body}</div> : null}
    </div>
  );
}

export function EditorialEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="border border-dashed border-[#d1d5db] bg-[#fafafa] px-4 py-6 text-[13px] text-[#9ca3af]">
      {children}
    </p>
  );
}

export function EditorialMetaTag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "amber" | "red";
}) {
  const toneClass = tone === "blue"
    ? "border-[#9bb8d9] bg-[#edf3fb] text-[#2d5a87]"
    : tone === "amber"
      ? "border-[#d4a574] bg-[#fdf8f3] text-[#92400e]"
      : tone === "red"
        ? "border-[#d9a3a3] bg-[#fdf2f2] text-[#991b1b]"
        : "border-[#e5e7eb] bg-[#fafafa] text-[#6b7280]";
  return (
    <span
      className={cn("border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase", toneClass)}
      style={{ fontFamily: "var(--font-fustat)" }}
    >
      {children}
    </span>
  );
}
