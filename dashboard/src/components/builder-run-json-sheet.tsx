"use client";

import { useMemo, useState } from "react";
import { Copy } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { BuilderRunFlow } from "@/lib/builder-run-flow";

type BuilderRunJsonSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payload: unknown;
};

type ViewMode = "flow" | "json";

function flowDisplayPayload(payload: unknown): BuilderRunFlow | unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const root = payload as Record<string, unknown>;
  if (root.flow && typeof root.flow === "object" && !Array.isArray(root.flow)) {
    return root.flow as BuilderRunFlow;
  }
  return { timeline: [] };
}

export function BuilderRunJsonSheet({ open, onOpenChange, payload }: BuilderRunJsonSheetProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("flow");
  const displayPayload = useMemo(
    () => (viewMode === "flow" ? flowDisplayPayload(payload) : payload),
    [payload, viewMode],
  );
  const text = useMemo(() => JSON.stringify(displayPayload, null, 2), [displayPayload]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b border-slate-200 px-4 py-3 text-left">
          <div className="flex items-start justify-between gap-3 pr-8">
            <div className="space-y-1">
              <SheetTitle>Builder run JSON</SheetTitle>
              <SheetDescription>
                Full builder flow: analyzer system prompts, backend command I/O, and chat message parts.
              </SheetDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${
                  viewMode === "flow"
                    ? "border-lime-300 bg-lime-50 text-lime-800"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
                onClick={() => setViewMode("flow")}
              >
                Flow
              </button>
              <button
                type="button"
                className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium ${
                  viewMode === "json"
                    ? "border-lime-300 bg-lime-50 text-lime-800"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
                onClick={() => setViewMode("json")}
              >
                JSON
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                onClick={() => void navigator.clipboard.writeText(text)}
              >
                <Copy size={12} />
                Copy
              </button>
            </div>
          </div>
        </SheetHeader>
        <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-relaxed text-slate-800">
          {text}
        </pre>
      </SheetContent>
    </Sheet>
  );
}
