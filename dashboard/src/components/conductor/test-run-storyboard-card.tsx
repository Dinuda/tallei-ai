"use client";

import type { NodeProps } from "@xyflow/react";
import { Handle, MiniMap } from "@xyflow/react";
import type { DynamicToolUIPart } from "ai";
import { AlertCircle, ChevronDown, UserRound } from "lucide-react";
import { useSession } from "next-auth/react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { Edge as WorkflowEdge } from "@/components/ai-elements/edge";
import {
  NodeContent,
  NodeDescription,
  NodeHeader,
  NodeTitle,
} from "@/components/ai-elements/node";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { AgentTeamAvatar, rosterAvatarShellClassName } from "@/components/conductor/agent-team-avatar";
import { TestRunLabHeader } from "@/components/conductor/test-run-lab-header";
import { TestRunCanvasFocus } from "@/components/conductor/test-run-canvas-focus";
import type { PresentAgentTeamOutput } from "@/components/conductor/conductor-shared";
import {
  buildTestRunCanvasModel,
  routeHandlePosition,
  testRunCanvasHeight,
  type TestRunFlowNode,
} from "@/components/conductor/test-run-storyboard-layout";
import {
  buildTestRunStoryboardViewModel,
  type TestRunBeatDataSection,
  type TestRunBeatStatus,
  type TestRunScenarioInput,
} from "@/components/conductor/test-run-storyboard-view-model";
import { useTestRunPlayback } from "@/components/conductor/use-test-run-playback";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

type StoryboardExpandContextValue = {
  expandedBeatId: string | null;
  setExpandedBeatId: (beatId: string | null) => void;
};

const StoryboardExpandContext = createContext<StoryboardExpandContextValue | null>(null);

function useStoryboardExpand() {
  const context = useContext(StoryboardExpandContext);
  if (!context) {
    throw new Error("useStoryboardExpand must be used within TestRunStoryboardCard");
  }
  return context;
}

function stopNodePointer(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function identityInitials(name?: string): string {
  return (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function gateDisplayName(name?: string): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} (You)` : "You";
}

function formatStepData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function BeatStatusChip({ status }: { status: TestRunBeatStatus }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--accent)]">
        <Shimmer className="text-[10px] font-semibold uppercase tracking-[0.08em]">Working</Shimmer>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-red-700">
        <AlertCircle className="size-3" aria-hidden />
        Failed
      </span>
    );
  }
  return null;
}

function BeatDataPanel({
  beatId,
  sections,
  status,
}: {
  beatId: string;
  sections: TestRunBeatDataSection[];
  status: TestRunBeatStatus;
}) {
  const { expandedBeatId, setExpandedBeatId } = useStoryboardExpand();
  const open = expandedBeatId === beatId;
  const canExpand = status !== "skipped" && sections.length > 0;

  if (!canExpand) return null;

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => setExpandedBeatId(nextOpen ? beatId : null)}
    >
      <CollapsibleTrigger
        className="flex w-full items-center justify-between gap-2 rounded border border-[var(--ed-border-light)] bg-white px-2 py-1.5 text-left text-[10px] font-semibold text-[var(--ed-text-2)] hover:bg-[var(--ed-surface-alt)]"
        onClick={stopNodePointer}
        onPointerDown={stopNodePointer}
      >
        <span>Test data</span>
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent
        className="absolute left-0 top-[calc(100%+0.25rem)] z-[200] w-80 max-w-[min(20rem,calc(100vw-2rem))] overflow-hidden border border-[var(--ed-border)] bg-white shadow-xl"
        onClick={stopNodePointer}
        onPointerDown={stopNodePointer}
      >
        <div className="border-b border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--ed-text-4)]">
            Test data
          </p>
        </div>
        <div className="max-h-56 space-y-3 overflow-y-auto p-3">
          {sections.map((section) => (
            <div key={section.title}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ed-text-muted)]">
                {section.title}
              </p>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded border border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] p-2 font-mono text-[10px] leading-4 text-[var(--ed-text-3)]">
                {formatStepData(section.data)}
              </pre>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TestRunBeatNode({ data, selected }: NodeProps<TestRunFlowNode>) {
  const { expandedBeatId } = useStoryboardExpand();
  const isApproval = data.kind === "approval";
  const isTrigger = data.kind === "trigger";
  const isResult = data.kind === "result";
  const displayTitle = isApproval ? gateDisplayName(data.userName) : data.title;
  const isExpanded = expandedBeatId === data.id;

  return (
    <div className={cn(
      "relative",
      isExpanded && "z-[200]",
      selected && "ring-1 ring-[var(--ed-border)]",
      data.status === "active" && !isApproval && "ring-1 ring-[var(--accent)]",
    )}>
      {data.inputSide ? (
        <Handle className="opacity-0" position={routeHandlePosition(data.inputSide)} type="target" />
      ) : null}
      <Card
        className={cn(
          "w-60 gap-0 rounded-none border p-0 shadow-sm",
          isApproval
            ? "border-none bg-[var(--ed-accent-bg)]"
            : "border-[var(--ed-border-light)] bg-white",
          data.status === "failed" && "border-red-200 bg-red-50",
        )}
      >
        <NodeHeader className="rounded-none border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] p-3">
          <div className="flex items-center gap-3">
            {isApproval ? (
              <Avatar className="size-9 shrink-0">
                {data.userImage ? <AvatarImage alt={displayTitle} src={data.userImage} /> : null}
                <AvatarFallback className="bg-[var(--ed-accent-bg)] text-[11px] font-semibold text-[var(--tag-blue-text)]">
                  {data.userName?.trim() ? identityInitials(data.userName) : <UserRound className="size-4" />}
                </AvatarFallback>
              </Avatar>
            ) : data.avatarSeed ? (
              <span className={rosterAvatarShellClassName(data.avatarSeed)}>
                <AgentTeamAvatar
                  alt={`${displayTitle} avatar`}
                  className="size-9"
                  seed={data.avatarSeed}
                  size={36}
                />
              </span>
            ) : (
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--ed-surface-alt)] text-[11px] font-semibold text-[var(--ed-text)]">
                {isTrigger ? "▶" : isResult ? "✓" : "•"}
              </div>
            )}
            <div className="min-w-0">
              <NodeTitle className={cn(
                "truncate text-xs font-semibold",
                isApproval ? "text-[var(--tag-blue-text)]" : "text-[var(--ed-text)]",
              )}>
                {displayTitle}
              </NodeTitle>
              <NodeDescription className="truncate text-[11px] text-[var(--ed-text-muted)]">
                {data.subtitle}
              </NodeDescription>
            </div>
          </div>
        </NodeHeader>
        <NodeContent className="space-y-2 p-3">
          <p className={cn(
            "line-clamp-4 text-[11px] leading-5",
            data.status === "failed" ? "text-red-800" : "text-[var(--ed-text-2)]",
          )}>
            {data.narrative}
          </p>
          {data.errors?.length ? (
            <ul className="space-y-1 rounded border border-red-200 bg-red-50 p-2 text-[10px] leading-4 text-red-800">
              {data.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          {data.stepData?.length ? (
            <BeatDataPanel beatId={data.id} sections={data.stepData} status={data.status} />
          ) : null}
          <BeatStatusChip status={data.status} />
        </NodeContent>
      </Card>
      {data.outputSide ? (
        <Handle className="opacity-0" position={routeHandlePosition(data.outputSide)} type="source" />
      ) : null}
    </div>
  );
}

const nodeTypes = { testRunBeat: TestRunBeatNode };
const edgeTypes = {
  animated: WorkflowEdge.Animated,
  temporary: WorkflowEdge.Temporary,
};

export function TestRunStoryboardCard({
  team,
  scenario,
  output,
  streaming,
  toolState,
}: {
  team?: PresentAgentTeamOutput | null;
  scenario?: TestRunScenarioInput;
  output?: unknown;
  streaming: boolean;
  toolState: DynamicToolUIPart["state"];
}) {
  const { data: session } = useSession();
  const baseViewModel = useMemo(
    () => buildTestRunStoryboardViewModel({ team, scenario }),
    [team, scenario],
  );
  const playback = useTestRunPlayback({
    beats: baseViewModel.beats,
    streaming: streaming || toolState === "input-available",
    output,
  });
  const viewModel = useMemo(
    () => buildTestRunStoryboardViewModel({
      team,
      scenario,
      output,
      activeBeatIndex: playback.activeBeatIndex,
      approvalApproved: playback.approvalApproved,
      resolvedFromOutput: playback.resolvedFromOutput,
    }),
    [
      team,
      scenario,
      output,
      playback.activeBeatIndex,
      playback.approvalApproved,
      playback.resolvedFromOutput,
    ],
  );
  const { nodes: baseNodes, edges } = useMemo(
    () => buildTestRunCanvasModel(viewModel.beats, {
      image: session?.user?.image,
      name: session?.user?.name,
    }),
    [session?.user?.image, session?.user?.name, viewModel.beats],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedBeatId, setExpandedBeatId] = useState<string | null>(null);
  const expandContext = useMemo(
    () => ({ expandedBeatId, setExpandedBeatId }),
    [expandedBeatId],
  );
  const isRunning = viewModel.footer === "running"
    || toolState === "input-streaming"
    || toolState === "input-available";
  const focusBeatId = isRunning
    ? viewModel.beats[playback.activeBeatIndex]?.id ?? null
    : null;

  useEffect(() => {
    if (isRunning && focusBeatId) {
      setSelectedId(focusBeatId);
    }
  }, [focusBeatId, isRunning]);

  const nodes = useMemo(
    () => baseNodes.map((node) => ({
      ...node,
      selected: node.id === (isRunning && focusBeatId ? focusBeatId : selectedId),
    })),
    [baseNodes, focusBeatId, isRunning, selectedId],
  );
  const selectedBeat = selectedId ? nodes.find((node) => node.id === selectedId)?.data : null;

  return (
    <section
      aria-busy={isRunning}
      aria-label="Test run storyboard"
      className="overflow-hidden border border-[var(--ed-border)] bg-white"
      data-transcript-block
    >
      <TestRunLabHeader
        errors={viewModel.errors}
        footer={viewModel.footer}
        isRunning={isRunning}
        output={output}
      />

      <div className="border-b border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] px-4 py-4 sm:px-5">
        <h3 className="text-base font-semibold leading-6 text-[var(--ed-text)]">{viewModel.title}</h3>
      </div>

      <div
        className="border-b border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)]"
        style={{ height: testRunCanvasHeight(viewModel.beats.length) }}
      >
        <StoryboardExpandContext.Provider value={expandContext}>
          <Canvas
            edgeTypes={edgeTypes}
            edges={edges}
            elementsSelectable
            fitView
            fitViewOptions={{ maxZoom: 0.9, padding: 0.28 }}
            nodes={nodes}
            nodeTypes={nodeTypes}
            nodesConnectable={false}
            nodesDraggable={false}
            onNodeClick={(_, node) => {
              setSelectedId(node.id);
              if (expandedBeatId && expandedBeatId !== node.id) {
                setExpandedBeatId(null);
              }
            }}
            panOnDrag
            panOnScroll
            proOptions={{ hideAttribution: true }}
            zoomOnDoubleClick
          >
            <TestRunCanvasFocus
              beatCount={viewModel.beats.length}
              focusBeatId={focusBeatId}
              isRunning={isRunning}
            />
            <Controls className="rounded-none [&>button]:rounded-none" position="bottom-right" showInteractive={false} />
            {viewModel.beats.length > 6 ? <MiniMap className="rounded-none" pannable zoomable /> : null}
          </Canvas>
        </StoryboardExpandContext.Provider>
      </div>

      <div className="min-h-20 bg-white px-4 py-3 sm:px-5">
        {selectedBeat ? (
          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--ed-text-4)]">
                {selectedBeat.kind === "approval" ? gateDisplayName(selectedBeat.userName) : selectedBeat.title}
              </p>
              <p className="mt-1 text-xs font-semibold text-[var(--ed-text)]">{selectedBeat.subtitle}</p>
            </div>
            <p className="text-xs leading-5 text-[var(--ed-text-3)]">{selectedBeat.narrative}</p>
          </div>
        ) : (
          <p className="text-xs leading-5 text-[var(--ed-text-4)]">
            Select a workflow step to inspect what happened during the test run.
          </p>
        )}
      </div>
    </section>
  );
}
