"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileJson, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { TaskBlueprint } from "@/components/conductor/conductor-shared";
import { outcomeRoleLabel, readTaskBlueprint } from "@/components/conductor/conductor-shared";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { deleteLoop } from "@/lib/loops-api";

export type LoopEventTriggerStatus = {
  subscribed: boolean;
  subscriptionStatus: string | null;
  composioTriggerSlug: string | null;
  channelStatus: string | null;
  composioInstanceId: string | null;
};

export function ConductorSpecSheet({
  loopId,
  loopName,
  spec,
  missingSlots,
  status,
  compiledPlanId,
  eventTrigger,
  readyToCompile,
  onRun,
}: {
  loopId?: string;
  loopName?: string;
  spec: Record<string, unknown> | null;
  missingSlots: string[];
  status: string;
  compiledPlanId: string | null;
  eventTrigger?: LoopEventTriggerStatus | null;
  readyToCompile: boolean;
  onRun?: () => void;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const taskBlueprint = readTaskBlueprint(spec);
  const triggerKind = spec?.trigger && typeof spec.trigger === "object" && !Array.isArray(spec.trigger)
    ? String((spec.trigger as Record<string, unknown>).kind ?? "")
    : "";
  const provisioningBanner = buildEventTriggerProvisioningBanner({
    triggerKind,
    status,
    compiledPlanId,
    eventTrigger: eventTrigger ?? null,
  });
  const specPanelValue = spec
    ? JSON.stringify(spec, null, 2)
    : "Describe what you want automated in chat. Tallei will name the loop from your first message and build the spec here.";

  async function handleDelete() {
    if (!loopId) return;
    const label = loopName?.trim() || "this loop";
    if (!window.confirm(`Delete "${label}"? This removes the loop and stops any schedules.`)) {
      return;
    }
    setDeleting(true);
    try {
      await deleteLoop(loopId);
      router.push("/dashboard/loops");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete loop");
      setDeleting(false);
    }
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button className="conductor-builder-page__spec-trigger" type="button">
          <FileJson className="size-3.5" />
          <span>{readyToCompile ? "Spec ready" : "Loop spec"}</span>
        </button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle style={{ fontFamily: "var(--font-title)" }}>
            {loopName ?? "Loop spec"}
          </SheetTitle>
          <SheetDescription>
            Status: {status}
            {compiledPlanId ? ` · plan ${compiledPlanId.slice(0, 8)}…` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          {provisioningBanner ? (
            <div
              className={`rounded-[var(--radius-md,14px)] border px-3 py-2 text-sm ${
                provisioningBanner.tone === "success"
                  ? "border-[var(--border,#cce89e)] bg-[var(--accent-light,#e6f5c8)] text-[var(--text-2,#3d5c18)]"
                  : provisioningBanner.tone === "warning"
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : "border-[var(--border-light,#e4f5c6)] bg-[var(--surface,#fff)] text-muted-foreground"
              }`}
            >
              {provisioningBanner.message}
            </div>
          ) : null}

          {taskBlueprint ? <TaskBlueprintSummary blueprint={taskBlueprint} /> : null}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Configuration JSON
            </p>
            <Textarea readOnly className="min-h-[240px] font-mono text-xs" value={specPanelValue} />
          </div>

          {readyToCompile ? (
            <p className="text-sm font-medium text-[var(--builder-emerald-accent)]">Ready to compile</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Missing: {missingSlots.join(", ") || (loopId ? "—" : "Send your first message to start")}
            </p>
          )}

          <div className="flex flex-col gap-2 pt-2">
            <Button variant="secondary" onClick={() => onRun?.()} disabled={!onRun || status !== "active"}>
              Run now
            </Button>
            {loopId ? (
              <Link className="text-center text-sm text-[var(--ed-accent)] hover:underline" href={`/dashboard/loops/${loopId}/runs`}>
                View runs
              </Link>
            ) : null}
            <Link className="text-center text-sm text-[var(--ed-accent)] hover:underline" href="/dashboard/approvals">
              Approval inbox
            </Link>
            {loopId ? (
              <Button
                className="mt-2 text-red-600 hover:bg-red-50 hover:text-red-700"
                disabled={deleting}
                onClick={() => void handleDelete()}
                type="button"
                variant="outline"
              >
                <Trash2 className="mr-2 size-4" />
                {deleting ? "Deleting…" : "Delete loop"}
              </Button>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function buildEventTriggerProvisioningBanner(input: {
  triggerKind: string;
  status: string;
  compiledPlanId: string | null;
  eventTrigger: LoopEventTriggerStatus | null;
}): { message: string; tone: "neutral" | "success" | "warning" } | null {
  if (input.triggerKind !== "event") return null;

  if (input.status === "active" && input.eventTrigger?.subscribed && input.eventTrigger.composioTriggerSlug) {
    return {
      tone: "success",
      message: `Listening: ${input.eventTrigger.composioTriggerSlug}`,
    };
  }

  if (input.status === "active" && input.eventTrigger && !input.eventTrigger.subscribed) {
    return {
      tone: "warning",
      message: "Activate failed to provision — fix trigger slug and activate again (pause → activate).",
    };
  }

  if (input.compiledPlanId && input.status !== "active") {
    return {
      tone: "neutral",
      message: "Compiled — activate to register Composio webhook.",
    };
  }

  return null;
}

function TaskBlueprintSummary({ blueprint }: { blueprint: TaskBlueprint }) {
  const outcomes = blueprint.outcomes ?? [];
  if (outcomes.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task blueprint</p>
      {blueprint.summary ? (
        <p className="text-sm text-[var(--ed-text-2)]">{blueprint.summary}</p>
      ) : null}
      <ul className="space-y-2">
        {outcomes.map((outcome) => (
          <li className="border border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] p-3 text-sm" key={outcome.id}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{outcomeRoleLabel(outcome.role)}</span>
              <span className="text-xs uppercase text-muted-foreground">{outcome.status}</span>
            </div>
            <p className="mt-1 text-muted-foreground">{outcome.description}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
