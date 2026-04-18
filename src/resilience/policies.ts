import type { RetryPolicy } from "./retry.js";

export interface CircuitPolicyConfig {
  readonly failureThreshold: number;
  readonly coolOffMs: number;
  readonly halfOpenSuccessThreshold: number;
}

export interface NamedPolicyConfig {
  readonly timeoutMs: number;
  readonly retry?: RetryPolicy;
  readonly circuit: CircuitPolicyConfig;
}

export interface ResiliencePolicies {
  readonly chatPolicy: NamedPolicyConfig;
  readonly embedPolicy: NamedPolicyConfig;
  readonly rerankPolicy: NamedPolicyConfig;
  readonly summarizePolicy: NamedPolicyConfig;
  readonly factExtractPolicy: NamedPolicyConfig;
  readonly graphExtractPolicy: NamedPolicyConfig;
  readonly vectorSearchPolicy: NamedPolicyConfig;
  readonly vectorUpsertPolicy: NamedPolicyConfig;
}

function retryPolicy(input: Omit<RetryPolicy, "shouldRetry" | "onRetry">): RetryPolicy {
  return {
    ...input,
  };
}

export const productionResiliencePolicies: ResiliencePolicies = {
  chatPolicy: {
    timeoutMs: 10_000,
    retry: retryPolicy({ maxRetries: 2, initialDelayMs: 500, maxDelayMs: 2_000, jitter: "equal" }),
    circuit: { failureThreshold: 5, coolOffMs: 30_000, halfOpenSuccessThreshold: 2 },
  },
  embedPolicy: {
    timeoutMs: 5_000,
    retry: retryPolicy({ maxRetries: 3, initialDelayMs: 300, maxDelayMs: 1_500, jitter: "equal" }),
    circuit: { failureThreshold: 8, coolOffMs: 20_000, halfOpenSuccessThreshold: 2 },
  },
  rerankPolicy: {
    timeoutMs: 8_000,
    retry: retryPolicy({ maxRetries: 1, initialDelayMs: 300, maxDelayMs: 1_000, jitter: "equal" }),
    circuit: { failureThreshold: 3, coolOffMs: 60_000, halfOpenSuccessThreshold: 1 },
  },
  summarizePolicy: {
    timeoutMs: 15_000,
    retry: retryPolicy({ maxRetries: 1, initialDelayMs: 500, maxDelayMs: 1_500, jitter: "equal" }),
    circuit: { failureThreshold: 3, coolOffMs: 60_000, halfOpenSuccessThreshold: 1 },
  },
  factExtractPolicy: {
    timeoutMs: 10_000,
    retry: retryPolicy({ maxRetries: 1, initialDelayMs: 500, maxDelayMs: 1_500, jitter: "equal" }),
    circuit: { failureThreshold: 3, coolOffMs: 60_000, halfOpenSuccessThreshold: 1 },
  },
  graphExtractPolicy: {
    timeoutMs: 30_000,
    retry: retryPolicy({ maxRetries: 2, initialDelayMs: 2_000, maxDelayMs: 10_000, jitter: "equal" }),
    circuit: { failureThreshold: 5, coolOffMs: 120_000, halfOpenSuccessThreshold: 2 },
  },
  vectorSearchPolicy: {
    timeoutMs: 8_000,
    retry: retryPolicy({ maxRetries: 2, initialDelayMs: 300, maxDelayMs: 1_500, jitter: "equal" }),
    circuit: { failureThreshold: 6, coolOffMs: 30_000, halfOpenSuccessThreshold: 2 },
  },
  vectorUpsertPolicy: {
    timeoutMs: 10_000,
    retry: retryPolicy({ maxRetries: 3, initialDelayMs: 500, maxDelayMs: 2_000, jitter: "equal" }),
    circuit: { failureThreshold: 6, coolOffMs: 30_000, halfOpenSuccessThreshold: 2 },
  },
};

export const developmentResiliencePolicies: ResiliencePolicies = {
  ...productionResiliencePolicies,
  chatPolicy: {
    ...productionResiliencePolicies.chatPolicy,
    timeoutMs: 15_000,
  },
  embedPolicy: {
    ...productionResiliencePolicies.embedPolicy,
    timeoutMs: 8_000,
  },
  summarizePolicy: {
    ...productionResiliencePolicies.summarizePolicy,
    timeoutMs: 20_000,
  },
  graphExtractPolicy: {
    ...productionResiliencePolicies.graphExtractPolicy,
    timeoutMs: 40_000,
  },
};

export function resolveResiliencePolicies(environment: string): ResiliencePolicies {
  return environment === "production" ? productionResiliencePolicies : developmentResiliencePolicies;
}
