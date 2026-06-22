"use client";

import { CheckCircle2, XCircle } from "lucide-react";

import { type ToolPart } from "@/components/ai-elements/tool";
import {
  formatRunToolLabel,
  isRunToolComplete,
  isRunToolInProgress,
  resolveRunToolDetail,
  resolveRunToolMeta,
} from "@/lib/spec-run-tool-transcript";

export function RunToolRow({ part, toolName }: { part: ToolPart; toolName: string }) {
  const input = part.input && typeof part.input === "object" && !Array.isArray(part.input)
    ? part.input as Record<string, unknown>
    : {};
  const output = part.output && typeof part.output === "object" && !Array.isArray(part.output)
    ? part.output as Record<string, unknown>
    : {};
  const errorText = (part as { errorText?: string }).errorText
    ?? (typeof output.error === "string" ? output.error : "");
  const inProgress = isRunToolInProgress(part.state);
  const complete = isRunToolComplete(part.state);
  const errored = part.state === "output-error" || Boolean(errorText) || output.ok === false;
  const label = formatRunToolLabel(toolName);
  const meta = resolveRunToolMeta(toolName, output);
  const detail = resolveRunToolDetail(toolName, input, output);

  if (errored) {
    return (
      <div className="border border-[#d1d5db] bg-white px-3 py-2.5 text-[13px] text-[#374151]">
        <div className="flex flex-wrap items-center gap-2">
          <XCircle className="size-3.5 shrink-0 text-[#6b7280]" />
          <span className="font-medium text-[#111827]">{label}</span>
          <span className="text-[12px] text-[#9ca3af]">· failed</span>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-[#d1d5db] bg-white px-3 py-2.5 text-[13px] text-[#374151]">
      <div className="flex flex-wrap items-center gap-2">
        {inProgress ? null : (
          <CheckCircle2 className="size-3.5 shrink-0 text-[#16a34a]" />
        )}
        <span className="font-medium text-[#111827]">{label}</span>
        {complete && meta ? (
          <span className="text-[12px] text-[#9ca3af]">· {meta}</span>
        ) : null}
      </div>
      {detail && !inProgress ? (
        <p className="mt-1 text-[12px] leading-5 text-[#6b7280]">{detail}</p>
      ) : null}
    </div>
  );
}

export function isCompactRunTool(toolName: string): boolean {
  return toolName === "getTriggerPayload"
    || toolName === "searchMemory"
    || toolName === "searchWeb"
    || toolName.startsWith("action_");
}
