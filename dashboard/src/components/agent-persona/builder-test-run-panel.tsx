"use client";

import { Activity, CheckCircle2, Loader2, XCircle } from "lucide-react";

import { IssueNotice, type ToolPart } from "@/components/ai-elements/tool";
import { maskBuilderIssueText } from "@/lib/builder-issue-text";

type BuilderCommand = {
  toolName?: string;
  status?: string;
  error?: string;
  result?: Record<string, unknown>;
  events?: Array<{
    stage?: string;
    message?: string;
    status?: string;
  }>;
};

type BuilderTestRun = {
  id?: string;
  status?: string;
  error?: string | null;
};

function latestCommandForTool(commands: BuilderCommand[], toolName: string): BuilderCommand | null {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    if (command?.toolName === toolName) return command;
  }
  return null;
}

function readTestRun(result: Record<string, unknown> | undefined): BuilderTestRun | null {
  const value = result?.testRun;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as BuilderTestRun
    : null;
}

function readCommandSnapshot(value: unknown): BuilderCommand | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as BuilderCommand
    : null;
}

type BuilderTestRunPanelProps = {
  part: ToolPart;
  commands: BuilderCommand[];
};

export function BuilderTestRunPanel({ part, commands }: BuilderTestRunPanelProps) {
  const command = latestCommandForTool(commands, "runBuilderTest") ?? readCommandSnapshot(part.output);
  const testRun = readTestRun(command?.result);
  const status = command?.status ?? (part.state === "output-available" ? "completed" : "running");
  const latestMessage = command?.events?.at(-1)?.message;
  const failed = status === "failed" || status === "rejected" || testRun?.status === "failed";
  const complete = status === "completed";

  if (failed) {
    return (
      <IssueNotice
        summary={maskBuilderIssueText(
          command?.error ?? testRun?.error ?? "Builder test run failed.",
          "builder-test-run",
        )}
      />
    );
  }

  const Icon = complete ? CheckCircle2 : Loader2;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-[#d6e4f0] bg-[#f7fbff] shadow-sm">
      <div className="flex items-center gap-2 border-b border-[#e4eef7] bg-white px-4 py-3">
        <Activity size={16} className="text-[#2f6f9f]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[#132638]" style={{ fontFamily: "var(--font-title)" }}>
            {complete ? "Builder test complete" : "Running builder test"}
          </div>
          {testRun?.id ? (
            <div className="truncate text-xs text-[#5f7890]">Run {testRun.id}</div>
          ) : null}
        </div>
        <Icon size={16} className={complete ? "text-[#2f8f55]" : "animate-spin text-[#2f6f9f]"} />
      </div>

      <div className="space-y-2 p-4">
        <p className="text-sm text-[#42657f]">
          {latestMessage ?? (complete ? "The saved loop test run finished." : "Executing the saved loop separately from the save step...")}
        </p>
        {testRun?.status ? (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-[#d6e4f0] bg-white px-2.5 py-1 text-[11px] font-medium text-[#34566f]">
            {testRun.status === "failed" ? <XCircle size={12} /> : <CheckCircle2 size={12} />}
            {testRun.status}
          </div>
        ) : null}
      </div>
    </div>
  );
}
