"use client";

import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { renameLoop } from "@/lib/loops-api";
import { cn } from "@/lib/utils";

function formatLoopStatus(status: string) {
  return status.replace(/_/g, " ");
}

function loopStatusBadgeClass(status: string) {
  switch (status) {
    case "active":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "paused":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "archived":
      return "border-slate-200 bg-slate-100 text-slate-600";
    default:
      return "border-slate-200 bg-slate-50 text-slate-500";
  }
}

export function ConductorLoopHeader({
  loopId,
  loopName,
  status,
  onLoopNameChange,
}: {
  loopId?: string;
  loopName?: string;
  status: string;
  onLoopNameChange?: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(loopName ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(loopName ?? "");
  }, [loopName, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function saveName() {
    const trimmed = draft.trim();
    const currentName = loopName?.trim() ?? "";
    if (!trimmed || trimmed === currentName) {
      setEditing(false);
      setDraft(loopName ?? "");
      return;
    }

    if (!loopId) {
      onLoopNameChange?.(trimmed);
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      await renameLoop(loopId, trimmed);
      onLoopNameChange?.(trimmed);
      setEditing(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rename loop");
      setDraft(loopName ?? "");
    } finally {
      setSaving(false);
    }
  }

  const displayName = loopId
    ? (loopName?.trim() || "Untitled loop")
    : "New loop";

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        {editing ? (
          <Input
            ref={inputRef}
            aria-label="Loop name"
            className="h-8 max-w-[min(20rem,50vw)] text-sm font-semibold"
            disabled={saving}
            value={draft}
            onBlur={() => void saveName()}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveName();
              }
              if (event.key === "Escape") {
                setDraft(loopName ?? "");
                setEditing(false);
              }
            }}
          />
        ) : (
          <>
            <h1 className="truncate text-sm font-semibold leading-none text-slate-900">
              {displayName}
            </h1>
            <button
              aria-label="Edit loop name"
              className="inline-flex shrink-0 items-center justify-center rounded-sm p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              onClick={() => setEditing(true)}
              type="button"
            >
              <Pencil className="size-3.5" />
            </button>
          </>
        )}
      </div>
      <Badge
        className={cn(
          "h-5 rounded-md px-2 text-[10px] font-semibold uppercase tracking-[0.08em]",
          loopStatusBadgeClass(status),
        )}
        variant="outline"
      >
        {formatLoopStatus(status)}
      </Badge>
    </div>
  );
}
