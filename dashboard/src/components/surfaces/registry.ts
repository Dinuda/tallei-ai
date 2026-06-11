import type { ComponentType } from "react";
import type { InputSurface } from "@/lib/operator-view-types";

export type SurfaceRendererProps = {
  surface: InputSurface;
  blockId: string;
  label?: string;
  description?: string;
  props?: Record<string, unknown>;
  data?: unknown;
};

export type SurfaceRendererDef = {
  surface: InputSurface;
  component: ComponentType<SurfaceRendererProps>;
};

const registry = new Map<InputSurface, SurfaceRendererDef>();

export function registerSurfaceRenderer(def: SurfaceRendererDef) {
  registry.set(def.surface, def);
}

export function getSurfaceRenderer(surface: InputSurface): SurfaceRendererDef | undefined {
  return registry.get(surface);
}

export function listSurfaceRenderers(): SurfaceRendererDef[] {
  return [...registry.values()];
}
