"use client";

import type { ReactNode } from "react";
import {
  ChevronDown,
  Copy,
  Download,
  Maximize2,
  Pencil,
} from "lucide-react";

import { cn } from "@/lib/utils";

export function ChatArtifactToolbar({
  onCopy,
  onDownload,
  onEdit,
  onExpand,
  editLabel = "Edit",
}: {
  onCopy?: () => void;
  onDownload?: () => void;
  onEdit: () => void;
  onExpand?: () => void;
  editLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#ececec] px-3 py-2">
      <button
        className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e5e5] bg-white px-3 py-1.5 text-[13px] font-medium text-[#111827] transition-colors hover:bg-[#fafafa]"
        onClick={(event) => {
          event.stopPropagation();
          onEdit();
        }}
        type="button"
      >
        <Pencil className="size-3.5" />
        {editLabel}
      </button>
      <div className="flex items-center gap-0.5">
        {onCopy ? (
          <ChatArtifactIconButton label="Copy" onClick={onCopy}>
            <Copy className="size-4" />
          </ChatArtifactIconButton>
        ) : null}
        {onDownload ? (
          <ChatArtifactIconButton label="Download" onClick={onDownload}>
            <Download className="size-4" />
          </ChatArtifactIconButton>
        ) : null}
        {onExpand ? (
          <ChatArtifactIconButton label="Expand" onClick={onExpand}>
            <Maximize2 className="size-4" />
          </ChatArtifactIconButton>
        ) : null}
      </div>
    </div>
  );
}

function ChatArtifactIconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex size-8 items-center justify-center rounded-md text-[#6b7280] transition-colors hover:bg-[#f3f4f6] hover:text-[#111827]"
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

export function ChatArtifactScrollFade({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 flex h-20 flex-col items-center justify-end bg-gradient-to-t from-white via-white/90 to-transparent pb-2",
        className,
      )}
    >
      <span className="inline-flex size-7 items-center justify-center rounded-full border border-[#e5e5e5] bg-white text-[#6b7280] shadow-sm">
        <ChevronDown className="size-4" />
      </span>
    </div>
  );
}

export function ChatArtifactMinimap({
  items,
  activeId,
  onSelect,
}: {
  items: Array<{ id: string; label: string }>;
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-1.5 border-r border-[#ececec] bg-[#fafafa] py-6">
      {items.map((item) => (
        <button
          aria-label={item.label}
          className={cn(
            "h-1 w-5 rounded-full transition-colors",
            activeId === item.id ? "bg-[#111827]" : "bg-[#d1d5db] hover:bg-[#9ca3af]",
          )}
          key={item.id}
          onClick={() => onSelect(item.id)}
          title={item.label}
          type="button"
        />
      ))}
    </div>
  );
}

export function ChatArtifactDocumentBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-2xl px-6 py-8 text-[15px] leading-7 text-[#374151]",
        className,
      )}
      style={{ fontFamily: "var(--font-fustat)" }}
    >
      {children}
    </div>
  );
}

export function ChatArtifactFloatingBar({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-6 pt-10">
      <div className="pointer-events-auto w-full max-w-xl">{children}</div>
    </div>
  );
}
