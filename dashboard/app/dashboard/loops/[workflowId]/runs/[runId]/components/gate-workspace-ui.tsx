"use client";

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Streamdown } from "streamdown";

import { cn } from "@/lib/utils";

const PLACEHOLDER_SPLIT = /(\[(?:paste|tbd|todo|fill|insert)[^\]]*\]|\b(?:tbd|details pending|to be determined|placeholder)\b)/i;
const PLACEHOLDER_TEST = /^\[(?:paste|tbd|todo|fill|insert)[^\]]*\]$|^(?:tbd|details pending|to be determined|placeholder)$/i;

function isEvalSystemMessage(text: string): boolean {
  return /output contains placeholder|unfilled template|placeholder_detected/i.test(text);
}

export function gateStatusImperative(mode: string): string {
  if (mode === "missing_input") return "Review the output and provide the missing input";
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

function GateSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-[#e5e7eb] px-7 py-6 last:border-b-0">
      <h3 className="text-[13px] font-semibold tracking-wide text-[#374151] uppercase">{title}</h3>
      {description ? <p className="mt-1 text-[13px] leading-5 text-[#6b7280]">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function GateIssueCallout({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex gap-3 rounded-md border border-[#fcd34d] bg-[#fffbeb] px-4 py-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#b45309]" />
      <div>
        <p className="text-[13px] font-semibold text-[#92400e]">{title}</p>
        <p className="mt-0.5 text-[13px] leading-5 text-[#78350f]">{body}</p>
      </div>
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

export function InputRequiredWorkspace({
  agentOutput,
  issueTitle,
  issueBody,
  fieldLabel,
  fieldPlaceholder,
  value,
  onChange,
}: {
  agentOutput: string;
  issueTitle: string;
  issueBody: string;
  fieldLabel: string;
  fieldPlaceholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      {agentOutput ? (
        <GateSection
          title="What the agent produced"
          description="Placeholder or incomplete sections are highlighted."
        >
          <div className="rounded-md border border-[#e5e7eb] bg-[#fafafa] p-5">
            <HighlightedDraftText text={agentOutput} />
          </div>
        </GateSection>
      ) : null}

      <GateSection title="What needs your attention">
        <GateIssueCallout title={issueTitle} body={issueBody} />
      </GateSection>

      <GateSection
        title="Your input"
        description={`Fill in ${fieldLabel.toLowerCase()} so the agent can continue.`}
      >
        <label className="block">
          <span className="mb-2 block text-[13px] font-semibold text-[#374151]">{fieldLabel}</span>
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="min-h-36 w-full border border-[#d1d5db] bg-white p-4 text-[14px] leading-relaxed text-[#111827] outline-none focus:border-[#9ca3af] focus:ring-2 focus:ring-[#fef3c7]"
            placeholder={fieldPlaceholder}
          />
        </label>
      </GateSection>
    </>
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
    <>
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
    </>
  );
}
