import type { InputSurface } from "../loop-engine/input-surfaces.js";
import type { OperatorCheckpoint, OperatorCheckpointSurface } from "./operator-checkpoint.js";

export function enrichCheckpointWithGrillMe(input: {
  checkpoint: OperatorCheckpoint;
  guardrails: string[];
}): OperatorCheckpoint {
  if (input.guardrails.length === 0) return input.checkpoint;
  const reviewSurfaces: InputSurface[] = ["review.email", "review.preview", "confirm.send", "review.draft"];
  return {
    ...input.checkpoint,
    surfaces: input.checkpoint.surfaces.map((surface) => {
      if (!reviewSurfaces.includes(surface.surface)) return surface;
      return {
        ...surface,
        props: {
          ...(surface.props ?? {}),
          grillMe: {
            guardrails: input.guardrails,
            blockers: [] as string[],
            warnings: [] as string[],
          },
        },
      } satisfies OperatorCheckpointSurface;
    }),
  };
}
