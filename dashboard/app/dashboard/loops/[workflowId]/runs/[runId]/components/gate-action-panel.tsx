"use client";

import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { engineGateHeadline, readEngineGateType, readRecord } from "./run-view-utils";

export type GateActionPayload = {
  gateType?: string;
  question?: string;
  items?: Array<{ id: string; excerpt: string; include?: boolean }>;
  fields?: Array<{ key: string; label: string; required?: boolean }>;
  draft?: string;
  provider?: string;
  target?: string;
  recipients?: Array<{ email: string; name?: string }>;
};

function readPayload(payload: unknown): GateActionPayload {
  return readRecord(payload) as GateActionPayload;
}

export function GateActionPanel({
  gateId,
  title,
  payload,
  busy,
  prominent = false,
  onApprove,
  onReject,
  onSubmitInput,
}: {
  gateId: string;
  title: string;
  payload: unknown;
  busy: boolean;
  prominent?: boolean;
  onApprove: (decision: Record<string, unknown>) => Promise<void>;
  onReject: () => Promise<void>;
  onSubmitInput: (value: string) => Promise<void>;
}) {
  const data = readPayload(payload);
  const gateType = readEngineGateType(payload) ?? "approval";
  const [memoryItems, setMemoryItems] = useState(
    () => (data.items ?? []).map((item) => ({ ...item, include: item.include !== false })),
  );
  const [missingInput, setMissingInput] = useState("");

  const headline = useMemo(() => engineGateHeadline(gateType), [gateType]);

  return (
    <div className={cn(
      "rounded-2xl border p-4 shadow-sm",
      prominent ? "border-sky-300 bg-sky-50/80 ring-2 ring-sky-200/60" : "border-amber-200/80 bg-amber-50/60",
    )}>
      <div className="mb-3">
        <p className="text-sm font-semibold text-amber-950">{headline}</p>
        <p className="mt-1 text-sm text-amber-900/80">{data.question ?? title}</p>
        {gateType === "draft_review" ? (
          <p className="mt-1 text-xs text-amber-900/70">Review the full draft below, then approve or reject here.</p>
        ) : null}
      </div>

      {gateType === "memory_confirmation" && memoryItems.length > 0 ? (
        <div className="mb-4 space-y-2">
          {memoryItems.map((item) => (
            <label
              key={item.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border bg-white/80 p-3",
                item.include ? "border-lime-300" : "border-slate-200 opacity-70",
              )}
            >
              <input
                type="checkbox"
                checked={item.include}
                onChange={(event) => {
                  setMemoryItems((prev) =>
                    prev.map((row) => (row.id === item.id ? { ...row, include: event.target.checked } : row)),
                  );
                }}
                className="mt-1"
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500">[{item.id.slice(0, 8)}]</p>
                <p className="text-sm text-slate-800">{item.excerpt}</p>
              </div>
            </label>
          ))}
        </div>
      ) : null}

      {gateType === "missing_input" ? (
        <div className="mb-4 space-y-2">
          <p className="text-xs font-medium text-slate-600">
            Paste the required details below, then submit. The run will continue after you provide this input.
          </p>
          <Textarea
            value={missingInput}
            onChange={(event) => setMissingInput(event.target.value)}
            placeholder={(data.fields?.[0]?.label ?? "Paste sprint notes and required details here") + "…"}
            className={cn("bg-white", prominent ? "min-h-48 text-sm" : "min-h-28")}
          />
        </div>
      ) : null}

      {gateType === "pre_send" ? (
        <div className="mb-4 rounded-xl border bg-white/90 p-3 text-sm text-slate-800">
          <p><span className="font-medium">Provider:</span> {data.provider ?? "unknown"}</p>
          <p><span className="font-medium">Target:</span> {data.target ?? "unknown"}</p>
          {Array.isArray(data.recipients) && data.recipients.length > 0 ? (
            <p className="mt-1"><span className="font-medium">Recipients:</span> {data.recipients.length}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {gateType === "missing_input" ? (
          <Button
            disabled={busy || !missingInput.trim()}
            onClick={() => onSubmitInput(missingInput.trim())}
            className="bg-[#7eb71b] hover:bg-[#6aa015]"
          >
            <Check className="mr-2 size-4" />
            Submit input
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() => {
              if (gateType === "memory_confirmation") {
                void onApprove({ items: memoryItems.filter((item) => item.include) });
                return;
              }
              void onApprove({ approvedAt: new Date().toISOString(), channel: "ui" });
            }}
            className="bg-[#7eb71b] hover:bg-[#6aa015]"
          >
            <Check className="mr-2 size-4" />
            {gateType === "draft_review" ? "Approve draft" : gateType === "pre_send" ? "Confirm send" : "Confirm"}
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={() => void onReject()}>
          <X className="mr-2 size-4" />
          Reject
        </Button>
      </div>
      <p className="mt-2 text-xs text-amber-900/60">Gate {gateId.slice(0, 8)}</p>
    </div>
  );
}
