import type { ComponentType } from "react";

export type ArtifactRecord = {
  id: string;
  artifact_key: string;
  version: number;
  kind: string;
  body: string;
  data_json?: Record<string, unknown>;
  invalidated_at: string | null;
};

export type ArtifactRendererProps = {
  artifact: ArtifactRecord;
  runId: string;
  saving: boolean;
  onSave?: (data: Record<string, unknown>) => Promise<void>;
};

export type RendererDef = {
  kind: string;
  label: string;
  displayMode: "dialog" | "inline" | "none";
  dialogWidth?: string;
  component: ComponentType<ArtifactRendererProps>;
};

const registry = new Map<string, RendererDef>();

export function registerRenderer(def: RendererDef) {
  registry.set(def.kind, def);
}

export function getRenderer(kind: string): RendererDef | undefined {
  return registry.get(kind);
}

export function listRenderers(): RendererDef[] {
  return [...registry.values()];
}
