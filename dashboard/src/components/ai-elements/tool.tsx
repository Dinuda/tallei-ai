"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { BUILDER_ISSUE_SUMMARY, maskBuilderIssueText } from "@/lib/builder-issue-text";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    data-tool-call=""
    className={cn(
      "group not-prose mb-4 w-full max-w-full min-w-0 overflow-hidden rounded-lg border border-[#d1d5db] bg-white",
      className,
    )}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Issue",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <AlertCircleIcon className="size-4 text-amber-700" />,
};

export function IssueNotice({
  className,
  summary,
}: {
  className?: string;
  summary?: string;
}) {
  const message = summary ?? BUILDER_ISSUE_SUMMARY;

  return (
    <Collapsible className={cn("not-prose mb-4 w-full border border-[#e5e7eb] bg-[#fafafa]", className)} defaultOpen={false}>
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left">
        <div className="flex items-center gap-2 text-sm text-[#6b7280]">
          <AlertCircleIcon className="size-4 shrink-0 text-amber-700" />
          <span>{message}</span>
        </div>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-[#e5e7eb] px-3 py-2.5 text-sm text-[#6b7280]">
        Something did not finish as expected. You can retry or adjust your choices and continue.
      </CollapsibleContent>
    </Collapsible>
  );
}

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 text-xs border" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full min-w-0 items-center justify-between gap-4 bg-[#fafafa] px-3 py-2.5 text-left",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-sm">{title ?? derivedName}</span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "max-w-full min-w-0 overflow-hidden border-t border-[#e5e7eb] p-4 text-popover-foreground outline-none",
      "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=closed]:duration-200",
      "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 data-[state=open]:duration-200",
      "space-y-4",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  if (input === undefined) return null;
  return (
    <div className={cn("max-w-full min-w-0 space-y-2 overflow-hidden", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Parameters
      </h4>
      <div className="max-w-full min-w-0 overflow-hidden border border-[#e5e7eb] bg-muted/50">
        <pre className="max-w-full whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground">
          {JSON.stringify(input, null, 2)}
        </pre>
      </div>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (errorText) {
    return (
      <div className={className} {...props}>
        <IssueNotice summary={maskBuilderIssueText(errorText, "tool-output")} />
      </div>
    );
  }

  if (output === undefined) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <pre className="max-w-full whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground">
        {JSON.stringify(output, null, 2)}
      </pre>
    );
  } else if (typeof output === "string") {
    Output = (
      <pre className="max-w-full whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground">
        {output}
      </pre>
    );
  }

  return (
    <div className={cn("max-w-full min-w-0 space-y-2 overflow-hidden", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Result
      </h4>
      <div className="max-w-full min-w-0 overflow-hidden border border-[#e5e7eb] bg-muted/50 text-xs text-foreground">
        {Output}
      </div>
    </div>
  );
};
