import type { BuilderAnalyzerPhase } from "./types.js";

export type BuilderArtifactKey = "intent" | "buildContract" | "spec" | "verification";

const PHASE_GRAPH: Record<BuilderAnalyzerPhase, { next: BuilderAnalyzerPhase[]; prev: BuilderAnalyzerPhase[] }> = {
  discovery: { next: ["requirements"], prev: [] },
  requirements: { next: ["compile"], prev: ["discovery"] },
  compile: { next: ["verification"], prev: ["requirements", "discovery"] },
  verification: { next: [], prev: ["compile"] },
};

const PHASE_ORDER: BuilderAnalyzerPhase[] = ["discovery", "requirements", "compile", "verification"];

const ARTIFACT_OWNER: Record<BuilderAnalyzerPhase, BuilderArtifactKey> = {
  discovery: "intent",
  requirements: "buildContract",
  compile: "spec",
  verification: "verification",
};

export function canAdvancePhase(from: BuilderAnalyzerPhase, to: BuilderAnalyzerPhase): boolean {
  return PHASE_GRAPH[from].next.includes(to);
}

export function canRegressPhase(current: BuilderAnalyzerPhase, target: BuilderAnalyzerPhase): boolean {
  if (current === target) return false;
  return reachablePhase(current, target, "backward");
}

function reachablePhase(
  from: BuilderAnalyzerPhase,
  to: BuilderAnalyzerPhase,
  direction: "forward" | "backward",
): boolean {
  const visited = new Set<BuilderAnalyzerPhase>();
  const queue = [from];
  while (queue.length > 0) {
    const phase = queue.shift()!;
    if (phase === to) return true;
    if (visited.has(phase)) continue;
    visited.add(phase);
    const neighbors = direction === "forward" ? PHASE_GRAPH[phase].next : PHASE_GRAPH[phase].prev;
    queue.push(...neighbors);
  }
  return false;
}

export function downstreamPhases(phase: BuilderAnalyzerPhase): BuilderAnalyzerPhase[] {
  const phaseIndex = PHASE_ORDER.indexOf(phase);
  if (phaseIndex < 0) return [];
  return PHASE_ORDER.slice(phaseIndex + 1);
}

export function artifactKeysForPhase(phase: BuilderAnalyzerPhase): BuilderArtifactKey[] {
  const phaseIndex = PHASE_ORDER.indexOf(phase);
  if (phaseIndex < 0) return [];
  return PHASE_ORDER.slice(0, phaseIndex + 1).map((entry) => ARTIFACT_OWNER[entry]);
}

export function artifactKeyForPhase(phase: BuilderAnalyzerPhase): BuilderArtifactKey {
  return ARTIFACT_OWNER[phase];
}

export function downstreamArtifactKeys(phase: BuilderAnalyzerPhase): BuilderArtifactKey[] {
  return downstreamPhases(phase).map((entry) => ARTIFACT_OWNER[entry]);
}

export function phaseOrder(): BuilderAnalyzerPhase[] {
  return [...PHASE_ORDER];
}
