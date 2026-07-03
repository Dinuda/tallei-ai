"use client";

import { useReactFlow } from "@xyflow/react";
import { useEffect } from "react";

export function OutcomeBriefFitView({ stageCount }: { stageCount: number }) {
  const { fitView } = useReactFlow();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.18, maxZoom: 1, duration: 150 });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, stageCount]);

  return null;
}
