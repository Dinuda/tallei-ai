"use client";

import type { ReactNode } from "react";
import { Streamdown } from "streamdown";

import { cn } from "@/lib/utils";
import { EditorialActionButton } from "./glyph-icons";

const PLACEHOLDER_SPLIT = /(\[(?:paste|tbd|todo|fill|insert)[^\]]*\]|\b(?:tbd|details pending|to be determined|placeholder)\b)/i;
const PLACEHOLDER_TEST = /^\[(?:paste|tbd|todo|fill|insert)[^\]]*\]$|^(?:tbd|details pending|to be determined|placeholder)$/i;

function isEvalSystemMessage(text: string): boolean {
  return /output contains placeholder|unfilled template|placeholder_detected/i.test(text);
}

export function gateStatusImperative(mode: string): string {
  if (mode === "missing_input") return "Paste the missing input below to continue";
  if (mode === "memory_confirmation") return "Select which memories the next agent may use";
  if (mode === "draft_review") return "Review the draft, then approve or request changes";
  if (mode === "pre_send") return "Confirm the final version before sending";
  return "Review and decide how to continue";
}

export function resolveInputFieldLabel(
  inputsRequired: string[] | undefined,
  gateQuestion: string | undefined,
): string {
  const key = inputsRequired?.[0];
  if (key) return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (gateQuestion && !isEvalSystemMessage(gateQuestion)) return gateQuestion;
  return "Required input";
}

export function resolveInputFieldPlaceholder(inputsRequired: string[] | undefined): string {
  const key = inputsRequired?.[0];
  if (key === "sprint_notes") {
    return "Paste sprint notes — shipped this week, in progress, blockers, next week…";
  }
  if (key) return `Paste or type ${key.replace(/_/g, " ")}…`;
  return "Paste or type the information the agent needs to continue…";
}

export function readGateAgentOutput(
  gatePayload: { result?: { text?: string } } & Record<string, unknown>,
  stepText: string,
): string {
  if (stepText.trim()) return stepText.trim();
  const text = gatePayload.result?.text;
  return typeof text === "string" ? text.trim() : "";
}

export function HighlightedDraftText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(PLACEHOLDER_SPLIT);
  return (
    <div className={cn("whitespace-pre-wrap text-[15px] leading-7 text-[#111827]", className)}>
      {parts.map((part, index) => {
        const isHighlight = PLACEHOLDER_TEST.test(part.trim());
        if (isHighlight) {
          return (
            <mark
              key={`${index}-${part.slice(0, 12)}`}
              className="rounded-sm bg-[#fef3c7] px-1 py-0.5 font-medium text-[#92400e] ring-1 ring-inset ring-[#fcd34d]"
            >
              {part}
            </mark>
          );
        }
        return <span key={`${index}-plain`}>{part}</span>;
      })}
    </div>
  );
}

export function AgentProgressPips({
  steps,
  currentStepId,
}: {
  steps: Array<{ id: string; status: string }>;
  currentStepId?: string | null;
}) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`${steps.filter((s) => s.status === "succeeded" || s.status === "approved").length} of ${steps.length} agents done`}>
      {steps.map((step) => {
        const isDone = step.status === "succeeded" || step.status === "approved";
        const isActive = step.id === currentStepId
          || step.status === "running"
          || step.status === "waiting_for_gate";
        return (
          <span
            key={step.id}
            className={cn(
              "size-2 rounded-full transition-colors",
              isDone && "bg-[#2563eb]",
              !isDone && isActive && "bg-[#f59e0b] ring-2 ring-[#fef3c7]",
              !isDone && !isActive && "bg-[#d1d5db]",
            )}
          />
        );
      })}
      <span className="ml-1 font-mono text-[10px] font-medium text-[#6b7280]">
        {steps.filter((s) => s.status === "succeeded" || s.status === "approved").length}/{steps.length}
      </span>
    </div>
  );
}

export function MissingInputWorkspace({
  agentOutput,
  agentName,
  fieldLabel,
  fieldPlaceholder,
  value,
  onChange,
  onSubmit,
  submitDisabled,
  busy,
}: {
  agentOutput: string;
  agentName: string;
  fieldLabel: string;
  fieldPlaceholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitDisabled: boolean;
  busy: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="border-b border-[#ebebeb] px-7 py-6">
        <div
          className="group -mx-2 rounded-md px-3 py-2 transition-colors hover:bg-[#f7f7f5]"
          style={{ fontFamily: "var(--font-fustat)" }}
        >
          <p className="mb-1.5 text-[13px] font-medium text-[#9b9a97]">{fieldLabel}</p>
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={fieldPlaceholder}
            rows={6}
            autoFocus
            className="w-full resize-none border-0 bg-transparent text-[15px] leading-[1.65] text-[#37352f] outline-none placeholder:text-[#c4c4c0] focus:ring-0"
          />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <EditorialActionButton
            label="Submit input"
            glyph="submit"
            variant="primary"
            onClick={onSubmit}
            disabled={busy || submitDisabled}
            className="px-5 text-[14px]"
          />
          <p className="text-[13px] text-[#9b9a97]">Paste the real content, then submit to continue.</p>
        </div>
      </section>

      {agentOutput ? (
        <section className="px-7 py-6">
          <p className="mb-3 text-[13px] font-medium text-[#9b9a97]">
            What {agentName} produced
          </p>
          <p className="mb-4 text-[13px] leading-5 text-[#6b7280]">
            Highlighted sections are placeholders or gaps — your input above replaces them.
          </p>
          <div className="rounded-md border border-[#ebebeb] bg-[#f7f7f5] px-5 py-4">
            <HighlightedDraftText text={agentOutput} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function GateSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-[#e5e7eb] px-7 py-6 last:border-b-0">
      <h3 className="text-[13px] font-semibold tracking-wide text-[#374151] uppercase">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function DraftReviewWorkspace({
  agentOutput,
  children,
}: {
  agentOutput: string;
  children?: ReactNode;
}) {
  return (
    <GateSection title="Draft output">
      {children ?? (
        agentOutput ? (
          <div className="rounded-md border border-[#e5e7eb] bg-white p-5">
            {/\[(?:paste|tbd)/i.test(agentOutput) ? (
              <HighlightedDraftText text={agentOutput} />
            ) : (
              <div className="prose prose-slate max-w-none text-[16px] leading-7">
                <Streamdown>{agentOutput}</Streamdown>
              </div>
            )}
          </div>
        ) : (
          <p className="py-12 text-center text-sm text-[#9ca3af]">No draft output available yet.</p>
        )
      )}
    </GateSection>
  );
}
