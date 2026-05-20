import { config } from "../../config/index.js";
import { aiProviderRegistry } from "../../providers/ai/index.js";

export type LoopMinerPhase = "episode" | "detector" | "evaluator" | "dna";

function resolveConfiguredModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : aiProviderRegistry.chatModelName();
}

export function loopMinerModelForPhase(phase: LoopMinerPhase): string {
  if (phase === "episode" && config.loopMinerEpisodeModel.trim()) return resolveConfiguredModel(config.loopMinerEpisodeModel);
  if (phase === "detector" && config.loopMinerDetectorModel.trim()) return resolveConfiguredModel(config.loopMinerDetectorModel);
  if (phase === "evaluator" && config.loopMinerEvaluatorModel.trim()) return resolveConfiguredModel(config.loopMinerEvaluatorModel);
  if (phase === "dna" && config.loopMinerDnaModel.trim()) return resolveConfiguredModel(config.loopMinerDnaModel);
  return resolveConfiguredModel(config.loopMinerModel);
}
