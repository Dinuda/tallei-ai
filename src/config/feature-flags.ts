import type { Config } from "./load.js";

export interface FeatureFlags {
  readonly memoryDualWriteEnabled: boolean;
  readonly memoryShadowReadEnabled: boolean;
  readonly useNewSaveUseCase: boolean;
  readonly useNewRecallUseCase: boolean;
  readonly useNewListUseCase: boolean;
  readonly useNewDeleteUseCase: boolean;
  readonly graphExtractionEnabled: boolean;
  readonly recallV2Enabled: boolean;
  readonly recallV2ShadowMode: boolean;
  readonly dashboardGraphV2Enabled: boolean;
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
    graphExtractionEnabled: config.graphExtractionEnabled,
    recallV2Enabled: config.recallV2Enabled,
    recallV2ShadowMode: config.recallV2ShadowMode,
    dashboardGraphV2Enabled: config.dashboardGraphV2Enabled,
    rerankEnabled: config.rerankEnabled,
    browserLlmFallbackEnabled: config.browserLlmFallbackEnabled,
  };
}
