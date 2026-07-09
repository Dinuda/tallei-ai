import type { z } from "zod";

import type {
  AppEmbeddingRequest,
  AppEmbeddingResponse,
  AppJsonSchemaSpec,
  AppModelRequest,
  AppModelResponse,
  StructuredOutputResult,
} from "../types.js";
import {
  buildStructuredChatRequest,
  parseStructuredOutput,
  responseToStructuredText,
  selectStructuredOutputStrategy,
} from "../validators/structured-output.js";
import { modelRegistry } from "../registry.js";

export interface ModelProviderAdapter {
  readonly id: string;
  chat(request: AppModelRequest): Promise<AppModelResponse>;
  embed?(request: AppEmbeddingRequest): Promise<AppEmbeddingResponse>;
  structuredJsonSchema?(request: AppModelRequest, schema: AppJsonSchemaSpec): Promise<AppModelResponse>;
}

export async function runStructuredWithAdapter<T>(
  adapter: ModelProviderAdapter,
  request: AppModelRequest,
  schema: z.ZodType<T>,
  jsonSchema: AppJsonSchemaSpec,
): Promise<StructuredOutputResult<T>> {
  const route = modelRegistry.resolveModelRoute({
    purpose: request.purpose ?? "chat",
    modelId: request.model,
  });
  const strategy = selectStructuredOutputStrategy({
    supportsJsonSchema: route.capabilities.supportsJsonSchema && Boolean(adapter.structuredJsonSchema),
    supportsJsonMode: route.capabilities.supportsJsonMode,
    supportsTools: route.capabilities.supportsTools,
  });

  let response: AppModelResponse;
  if (strategy === "native_schema" && adapter.structuredJsonSchema) {
    response = await adapter.structuredJsonSchema(request, jsonSchema);
    return parseStructuredOutput(schema, responseToStructuredText(response), "native_schema");
  }

  const chatRequest = buildStructuredChatRequest(request, jsonSchema, strategy === "tool_call" ? "json_mode" : strategy);
  response = await adapter.chat(chatRequest);
  return parseStructuredOutput(schema, responseToStructuredText(response), strategy === "tool_call" ? "prompt_repair" : strategy);
}
