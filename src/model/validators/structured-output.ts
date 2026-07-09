import type { z } from "zod";

import type {
  AppJsonSchemaSpec,
  AppModelRequest,
  AppModelResponse,
  StructuredOutputResult,
  StructuredOutputStrategy,
} from "../types.js";
import { toLegacyChatMessages } from "../normalize/messages.js";

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export async function parseStructuredOutput<T>(
  schema: z.ZodType<T>,
  rawText: string,
  strategy: StructuredOutputStrategy,
): Promise<StructuredOutputResult<T>> {
  const candidate = extractJsonObject(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(`Structured output JSON parse failed (${strategy}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = schema.parse(parsed);
  return { data, strategy, rawText };
}

export function buildStructuredChatRequest(
  request: AppModelRequest,
  schema: AppJsonSchemaSpec,
  strategy: StructuredOutputStrategy,
): AppModelRequest {
  if (strategy === "native_schema") {
    return {
      ...request,
      responseFormat: "json_schema",
      jsonSchema: schema,
    };
  }
  if (strategy === "json_mode") {
    return {
      ...request,
      responseFormat: "json",
      messages: [
        {
          role: "system",
          content: `Return valid JSON only matching schema "${schema.name}".`,
        },
        ...request.messages,
      ],
    };
  }
  return {
    ...request,
    responseFormat: "json",
    messages: [
      {
        role: "system",
        content: `Return a single JSON object matching schema "${schema.name}". No markdown.`,
      },
      ...toLegacyChatMessages(request.messages).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
  };
}

export function selectStructuredOutputStrategy(input: {
  supportsJsonSchema: boolean;
  supportsJsonMode: boolean;
  supportsTools: boolean;
  preferred?: StructuredOutputStrategy;
}): StructuredOutputStrategy {
  if (input.preferred === "native_schema" && input.supportsJsonSchema) return "native_schema";
  if (input.supportsJsonSchema) return "native_schema";
  if (input.supportsJsonMode) return "json_mode";
  if (input.supportsTools) return "tool_call";
  return "prompt_repair";
}

export function responseToStructuredText(response: AppModelResponse): string {
  if (response.text?.trim()) return response.text.trim();
  if (response.toolCalls?.length) {
    const first = response.toolCalls[0];
    if (typeof first.arguments === "string") return first.arguments;
    return JSON.stringify(first.arguments ?? {});
  }
  return "";
}
