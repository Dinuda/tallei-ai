import { jsonSchemaToZod, jsonSchemaToZodShape } from "@composio/json-schema-to-zod";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

function asJsonSchema7(schema: Record<string, unknown>): JSONSchema7 {
  return schema as JSONSchema7;
}

export function summarizeConnectorInputSchema(schema: Record<string, unknown>): string {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  const properties = schema.properties && typeof schema.properties === "object"
    ? Object.keys(schema.properties as Record<string, unknown>)
    : [];
  const lines = [
    "Use exact connector schema property names at the top level (do not nest under payload).",
  ];
  if (required.length > 0) {
    lines.push(`Required: ${required.join(", ")}.`);
  }
  if (properties.length > 0) {
    lines.push(`Properties: ${properties.join(", ")}.`);
  }
  return lines.join(" ");
}

export function buildConnectorToolInputSchema(inputSchema: Record<string, unknown>): z.ZodTypeAny {
  if (inputSchema.type !== "object") {
    return z.object({
      rationale: z.string().optional().describe("Brief reason for calling this connector action."),
    }).catchall(z.unknown());
  }

  try {
    const shape = jsonSchemaToZodShape(asJsonSchema7(inputSchema));
    return z.object({
      ...shape,
      rationale: z.string().optional().describe("Brief reason for calling this connector action."),
    });
  } catch {
    const fallback = jsonSchemaToZod(asJsonSchema7(inputSchema));
    return z.intersection(
      fallback,
      z.object({
        rationale: z.string().optional().describe("Brief reason for calling this connector action."),
      }),
    );
  }
}

/** Strip rationale and unwrap legacy `{ payload: {...} }` tool calls. */
export function extractConnectorActionPayload(input: Record<string, unknown>): Record<string, unknown> {
  const { rationale: _rationale, payload, ...rest } = input;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), ...rest };
  }
  return rest;
}

export function connectorToolDescription(
  contract: { name: string; description: string; inputSchema: Record<string, unknown> },
): string {
  return [
    `${contract.name}: ${contract.description}`,
    summarizeConnectorInputSchema(contract.inputSchema),
  ].join("\n");
}
