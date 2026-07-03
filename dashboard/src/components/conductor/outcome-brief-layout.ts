import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { MarkerType, Position } from "@xyflow/react";

import type { OutcomeReviewStage } from "@/components/conductor/outcome-review-view-model";

export const ROUTE_COLUMNS = 3;
const HORIZONTAL_GAP = 270;
const VERTICAL_GAP = 150;

export type RouteHandleSide = "left" | "right" | "top" | "bottom";

export type RouteNodeData = OutcomeReviewStage & {
  index: number;
  userImage?: string;
  userName?: string;
  inputSide?: RouteHandleSide;
  outputSide?: RouteHandleSide;
};

export type RouteFlowNode = FlowNode<RouteNodeData, "route">;

const handlePosition: Record<RouteHandleSide, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

export function routeHandlePosition(side: RouteHandleSide): Position {
  return handlePosition[side];
}

export function routeNodePosition(index: number, total: number): {
  x: number;
  y: number;
  inputSide?: RouteHandleSide;
  outputSide?: RouteHandleSide;
} {
  const columns = Math.min(ROUTE_COLUMNS, Math.max(total, 1));
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

export function routeCanvasHeight(total: number): number {
  const columns = Math.min(ROUTE_COLUMNS, Math.max(total, 1));
  const rows = Math.ceil(total / columns);
  if (rows <= 1) return 300;
  if (rows === 2) return 360;
  return 430;
}

export function buildCanvasModel(
  stages: OutcomeReviewStage[],
  user?: { image?: string | null; name?: string | null },
): { nodes: RouteFlowNode[]; edges: FlowEdge[] } {
  const nodes = stages.map((stage, index): RouteFlowNode => {
    const layout = routeNodePosition(index, stages.length);
    return {
      id: `route-${index}`,
      type: "route",
      position: { x: layout.x, y: layout.y },
      data: {
        ...stage,
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

  const edges = stages.slice(1).map((_, index): FlowEdge => ({
    id: `route-edge-${index}`,
    source: `route-${index}`,
    target: `route-${index + 1}`,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "#94a3b8", strokeWidth: 1.25 },
  }));

  return { nodes, edges };
}
