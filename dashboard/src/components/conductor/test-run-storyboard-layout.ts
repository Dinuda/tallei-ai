import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { MarkerType, Position } from "@xyflow/react";

import type { TestRunStoryBeat } from "@/components/conductor/test-run-storyboard-view-model";

const HORIZONTAL_GAP = 360;
const VERTICAL_GAP = 220;
const SINGLE_ROW_MAX = 6;

export type RouteHandleSide = "left" | "right" | "top" | "bottom";

const handlePosition: Record<RouteHandleSide, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

export function routeHandlePosition(side: RouteHandleSide): Position {
  return handlePosition[side];
}

export function testRunNodePosition(index: number, total: number): {
  x: number;
  y: number;
  inputSide?: RouteHandleSide;
  outputSide?: RouteHandleSide;
} {
  if (total <= SINGLE_ROW_MAX) {
    return {
      x: index * HORIZONTAL_GAP,
      y: 0,
      ...(index > 0 ? { inputSide: "left" as const } : {}),
      ...(index < total - 1 ? { outputSide: "right" as const } : {}),
    };
  }

  const columns = 3;
  const row = Math.floor(index / columns);
  const col = index % columns;
  const rowStart = row * columns;
  const rowEnd = Math.min(rowStart + columns - 1, total - 1);
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const isRowStart = col === 0;
  const isRowEnd = index === rowEnd;
  const wrapsToNextRow = isRowEnd && index < total - 1;

  let inputSide: RouteHandleSide | undefined;
  if (!isFirst) {
    inputSide = isRowStart && row > 0 ? "top" : "left";
  }

  let outputSide: RouteHandleSide | undefined;
  if (!isLast) {
    outputSide = wrapsToNextRow ? "bottom" : "right";
  }

  return {
    x: col * HORIZONTAL_GAP,
    y: row * VERTICAL_GAP,
    ...(inputSide ? { inputSide } : {}),
    ...(outputSide ? { outputSide } : {}),
  };
}

export function testRunCanvasHeight(total: number): number {
  if (total <= SINGLE_ROW_MAX) return 380;
  const rows = Math.ceil(total / 3);
  if (rows <= 1) return 380;
  if (rows === 2) return 400;
  return 480;
}

export type TestRunBeatNodeData = TestRunStoryBeat & {
  index: number;
  userImage?: string;
  userName?: string;
  inputSide?: RouteHandleSide;
  outputSide?: RouteHandleSide;
};

export type TestRunFlowNode = FlowNode<TestRunBeatNodeData, "testRunBeat">;

export type TestRunEdgeType = "animated" | "temporary" | "smoothstep";

function edgeTypeForBeats(source: TestRunStoryBeat, target: TestRunStoryBeat): TestRunEdgeType {
  if (target.status === "active") return "animated";
  if (target.status === "pending" || target.status === "skipped") return "temporary";
  return "smoothstep";
}

function edgeStyle(type: TestRunEdgeType): FlowEdge["style"] {
  if (type === "animated") {
    return { stroke: "var(--accent)", strokeWidth: 2 };
  }
  if (type === "temporary") {
    return { stroke: "#cbd5e1", strokeWidth: 1.25, strokeDasharray: "5,5" };
  }
  return { stroke: "#94a3b8", strokeWidth: 1.25 };
}

export function buildTestRunCanvasModel(
  beats: TestRunStoryBeat[],
  user?: { image?: string | null; name?: string | null },
): { nodes: TestRunFlowNode[]; edges: FlowEdge[] } {
  const nodes = beats.map((beat, index): TestRunFlowNode => {
    const layout = testRunNodePosition(index, beats.length);
    return {
      id: beat.id,
      type: "testRunBeat",
      position: { x: layout.x, y: layout.y },
      data: {
        ...beat,
        index,
        ...(layout.inputSide ? { inputSide: layout.inputSide } : {}),
        ...(layout.outputSide ? { outputSide: layout.outputSide } : {}),
        ...(user?.image ? { userImage: user.image } : {}),
        ...(user?.name ? { userName: user.name } : {}),
      },
      draggable: false,
      selectable: true,
    };
  });

  const edges = beats.slice(1).map((beat, index): FlowEdge => {
    const sourceBeat = beats[index];
    const targetBeat = beat;
    const type = sourceBeat && targetBeat
      ? edgeTypeForBeats(sourceBeat, targetBeat)
      : "smoothstep";

    return {
      id: `test-run-edge-${index}`,
      source: beats[index]?.id ?? `beat-${index}`,
      target: beat.id,
      type,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: edgeStyle(type),
      animated: type === "animated",
    };
  });

  return { nodes, edges };
}
