/**
 * Surface renderer registry — symmetric to dashboard/src/components/renderers for outputs.
 * OperatorWorkspace maps blocks via renderBlock(); registerSurfaceRenderer for extensions.
 */
import { registerSurfaceRenderer } from "./registry";

export { getSurfaceRenderer, listSurfaceRenderers, registerSurfaceRenderer } from "./registry";
export type { SurfaceRendererDef, SurfaceRendererProps } from "./registry";

// Registry hooks for future surface plugins; OperatorWorkspace uses inline renderBlock today.
registerSurfaceRenderer({
  surface: "input.markdown",
  component: () => null,
});
