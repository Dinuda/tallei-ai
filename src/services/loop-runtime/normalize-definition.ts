import {
  loopDefinitionSchema,
  type LoopDefinition,
} from "../loop-executor/types.js";

/**
 * Runtime normalization is intentionally structural only. Gates, render targets,
 * and agent roles must be declared by the workflow definition.
 */
export function normalizeLoopDefinitionForRuntime(definition: LoopDefinition): LoopDefinition {
  return loopDefinitionSchema.parse(definition);
}
