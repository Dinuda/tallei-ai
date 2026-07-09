import type { z } from "zod";

import { config } from "../../config/index.js";
import { createLoopChatOpenAiSdk } from "../../services/llm/loop-chat-client.js";
import type {
  AppJsonSchemaSpec,
  AppModelRequest,
  AppModelResponse,
  StructuredOutputResult,
} from "../types.js";
import { toResponsesInput } from "../normalize/messages.js";
import { parseStructuredOutput, responseToStructuredText } from "../validators/structured-output.js";
import type { ModelProviderAdapter } from "./adapter.js";

function extractResponseText(response: unknown): string {
  const row = response as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  if (typeof row?.output_text === "string" && row.output_text.trim()) {
    return row.output_text.trim();
  }
  const output = Array.isArray(row?.output) ? row.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

export class OpenAiResponsesAdapter implements ModelProviderAdapter {
  readonly id = "openai";

  async structuredJsonSchema(
    request: AppModelRequest,
    schema: AppJsonSchemaSpec,
  ): Promise<AppModelResponse> {
    if (config.llmProvider !== "openai") {
      throw new Error("OpenAI Responses structured output requires TALLEI_LLM__PROVIDER=openai");
    }
    const client = createLoopChatOpenAiSdk({ userId: request.userId });
    const response = await (client.responses as unknown as {
      create: (
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => Promise<unknown>;
    }).create(
      {
        model: request.model ?? config.plannerModel,
        input: toResponsesInput(request.messages),
        tools: (request.webSearchBudget ?? 0) > 0 ? [{ type: "web_search_preview" }] : [],
        text: {
          format: {
            type: "json_schema",
            name: schema.name,
            strict: schema.strict ?? true,
            schema: schema.schema,
          },
        },
      },
      request.signal ? { signal: request.signal } : undefined,
    );
    return {
      text: extractResponseText(response),
      finishReason: "stop",
      model: request.model ?? config.plannerModel,
      provider: "openai",
      raw: response,
    };
  }

  async chat(request: AppModelRequest): Promise<AppModelResponse> {
    if (!request.jsonSchema) {
      throw new Error("OpenAiResponsesAdapter.chat requires jsonSchema for non-structured calls");
    }
    return this.structuredJsonSchema(request, request.jsonSchema);
  }
}

export async function runOpenAiResponsesStructured<T>(
  request: AppModelRequest,
  schema: z.ZodType<T>,
  jsonSchema: AppJsonSchemaSpec,
): Promise<StructuredOutputResult<T>> {
  const adapter = new OpenAiResponsesAdapter();
  const response = await adapter.structuredJsonSchema(request, jsonSchema);
  return parseStructuredOutput(schema, responseToStructuredText(response), "native_schema");
}
