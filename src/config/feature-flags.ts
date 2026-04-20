import type { Config } from "./load.js";

export interface FeatureFlags {
  readonly memoryDualWriteEnabled: boolean;
  readonly memoryShadowReadEnabled: boolean;
  readonly useNewSaveUseCase: boolean;
  readonly useNewRecallUseCase: boolean;
  readonly useNewListUseCase: boolean;
  readonly useNewDeleteUseCase: boolean;
  readonly rerankEnabled: boolean;
  readonly browserLlmFallbackEnabled: boolean;
}

export function getFeatureFlags(config: Config): FeatureFlags {
  return {
    memoryDualWriteEnabled: config.memoryDualWriteEnabled,
    memoryShadowReadEnabled: config.memoryShadowReadEnabled,
    useNewSaveUseCase: config.useNewSaveUseCase,
    useNewRecallUseCase: config.useNewRecallUseCase,
    useNewListUseCase: config.useNewListUseCase,
    useNewDeleteUseCase: config.useNewDeleteUseCase,
    rerankEnabled: config.rerankEnabled,
    browserLlmFallbackEnabled: config.browserLlmFallbackEnabled,
  };
}
