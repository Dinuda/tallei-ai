import type { ToolSet } from "ai";

import type { WorkflowBuilderSession } from "../../services/session.service.js";

export type BuilderAnalyzerPhase = "discovery" | "requirements" | "compile" | "verification";

export type BuilderToolRun = (toolName: import("../../contracts/builder-types.js").BuilderToolName, input: Record<string, unknown>) => Promise<unknown>;

export type BuilderPhaseHandoff = {
  steps: Array<{
    phase: BuilderAnalyzerPhase;
    agentLabel: string;
    summary: Record<string, unknown>;
  }>;
};

export type BuilderPhaseConfig = {
  phase: BuilderAnalyzerPhase;
  agentLabel: string;
  systemPrompt: string;
  tools: ToolSet;
  stepLimit: number;
};

export type BuildPhaseConfigInput = {
  session: WorkflowBuilderSession;
  phase?: BuilderAnalyzerPhase;
  groundingContext?: Record<string, unknown> | null;
  handoff: BuilderPhaseHandoff;
  run: BuilderToolRun;
};
