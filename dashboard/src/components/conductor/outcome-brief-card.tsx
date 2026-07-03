"use client";

import type { NodeProps } from "@xyflow/react";
import { Controls, Handle, MiniMap } from "@xyflow/react";
import { UserRound } from "lucide-react";
import Image from "next/image";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";

import { Canvas } from "@/components/ai-elements/canvas";
import { OutcomeBriefFitView } from "@/components/conductor/outcome-brief-fit-view";
import {
  buildCanvasModel,
  routeCanvasHeight,
  routeHandlePosition,
  type RouteFlowNode,
} from "@/components/conductor/outcome-brief-layout";
import type { OutcomeReviewViewModel } from "@/components/conductor/outcome-review-view-model";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

function identityInitials(identity: string): string {
  return identity.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function gateDisplayName(name?: string): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} (You)` : "You";
}

function RouteNode({ data, selected }: NodeProps<RouteFlowNode>) {
  const isTallei = data.identity === "Tallei";
  const isGate = data.kind === "approval";
  const displayIdentity = isGate ? gateDisplayName(data.userName) : data.identity;
  return (
    <div className={cn(
      "relative border px-4 py-3 shadow-sm",
      isGate
        ? "w-56 border-none bg-[var(--ed-accent-bg)]"
        : "border-[var(--ed-border-light)] bg-white",
      !isGate && (data.kind === "action" ? "w-48" : "w-44"),
      selected && (isGate
        ? "ring-1 ring-[var(--ed-accent-border)]"
        : "border-[var(--ed-border)] bg-[var(--ed-surface-alt)] ring-1 ring-[var(--ed-border)]"),
    )}>
      {data.inputSide ? (
        <Handle className="opacity-0" position={routeHandlePosition(data.inputSide)} type="target" />
      ) : null}
      <div className="flex min-h-12 items-center gap-3">
        <div className={cn(
          "flex size-11 shrink-0 items-center justify-center text-sm font-bold",
          isGate && "text-[var(--tag-blue-text)]",
        )}>
          {isGate ? (
            <Avatar className="size-9">
              {data.userImage ? <AvatarImage alt={displayIdentity} src={data.userImage} /> : null}
              <AvatarFallback className="bg-[var(--ed-accent-bg)] text-[11px] font-semibold text-[var(--tag-blue-text)]">
                {data.userName?.trim() ? identityInitials(data.userName) : <UserRound className="size-4" />}
              </AvatarFallback>
            </Avatar>
          ) : isTallei ? (
            <Image alt="Tallei" className="h-4 w-9 object-contain" height={16} src="/tallei.svg" width={36} />
          ) : data.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img alt={data.identity} className="size-7 object-contain" draggable={false} src={`https://logos.composio.dev/api/${data.icon}`} />
          ) : identityInitials(data.identity) || "•"}
        </div>
        <div className="min-w-0">
          <p className={cn("truncate text-xs font-semibold", isGate ? "text-[var(--tag-blue-text)]" : "text-slate-950")}>{displayIdentity}</p>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-slate-500">{data.description}</p>
      {data.outputSide ? (
        <Handle className="opacity-0" position={routeHandlePosition(data.outputSide)} type="source" />
      ) : null}
    </div>
  );
}

const nodeTypes = { route: RouteNode };

export function OutcomeBriefCard({ viewModel, streaming, status }: {
  viewModel: OutcomeReviewViewModel;
  streaming: boolean;
  status?: "confirmed" | "change-requested";
}) {
  const { data: session } = useSession();
  const { nodes, edges } = useMemo(
    () => buildCanvasModel(viewModel.stages, {
      image: session?.user?.image,
      name: session?.user?.name,
    }),
    [session?.user?.image, session?.user?.name, viewModel.stages],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedStage = selectedId ? nodes.find((node) => node.id === selectedId)?.data : null;

  return (
    <section aria-busy={streaming} aria-label="Routing manifest" className="mb-3 overflow-hidden border border-[var(--ed-border)] bg-white">
      <div className="border-b border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] px-4 py-4 sm:px-5">
        <h3 className="text-base font-semibold leading-6 text-[var(--ed-text)]">{viewModel.title}</h3>
      </div>

      <div
        className="border-b border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)]"
        style={{ height: routeCanvasHeight(viewModel.stages.length) }}
      >
        <Canvas
          edges={edges}
          elementsSelectable
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.18 }}
          nodes={nodes}
          nodeTypes={nodeTypes}
          nodesConnectable={false}
          nodesDraggable={false}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          panOnDrag
          panOnScroll
          proOptions={{ hideAttribution: true }}
          zoomOnDoubleClick
        >
          <OutcomeBriefFitView stageCount={viewModel.stages.length} />
          <Controls className="rounded-none [&>button]:rounded-none" position="bottom-right" showInteractive={false} />
          {viewModel.stages.length > 6 ? <MiniMap className="rounded-none" pannable zoomable /> : null}
        </Canvas>
      </div>

      <div className="min-h-20 bg-white px-4 py-3 sm:px-5">
        {selectedStage ? (
          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--ed-text-4)]">
                {selectedStage.kind === "approval" ? gateDisplayName(selectedStage.userName) : selectedStage.identity}
              </p>
              <p className="mt-1 text-xs font-semibold text-[var(--ed-text)]">{selectedStage.label}</p>
            </div>
            <p className="text-xs leading-5 text-[var(--ed-text-3)]">{selectedStage.description}</p>
          </div>
        ) : <p className="text-xs leading-5 text-[var(--ed-text-4)]">Select a route step to inspect its configured goal.</p>}
      </div>

      <p className="sr-only">Starts when: {viewModel.runsWhen}. What it does: {viewModel.does}. Approval: {viewModel.approval}. Result: {viewModel.result}</p>
      {streaming || status ? (
        <footer className="border-t border-slate-100 px-4 py-2 text-right text-[11px] font-medium text-slate-500">
          {streaming ? "Preparing route…" : status === "confirmed" ? "Route confirmed" : "Changes requested"}
        </footer>
      ) : null}
    </section>
  );
}
