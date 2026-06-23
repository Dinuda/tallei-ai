import Ajv from "ajv";
import addFormats from "ajv-formats";
import { z } from "zod";

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

const JSON_SCHEMA_PRIMITIVE_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "object",
  "array",
]);

function isCanonicalJsonSchema(schema: Record<string, unknown>): boolean {
  return typeof schema.type === "string"
    || typeof schema.$ref === "string"
    || Array.isArray(schema.anyOf)
    || Array.isArray(schema.oneOf)
    || Array.isArray(schema.allOf);
}

function shorthandValueToJsonSchema(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (JSON_SCHEMA_PRIMITIVE_TYPES.has(normalized)) {
      return normalized === "array"
        ? { type: "array", items: {} }
        : { type: normalized };
    }
    return { type: "string", description: value };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length > 0 ? shorthandValueToJsonSchema(value[0]) : {},
    };
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(row)) {
      properties[key] = shorthandValueToJsonSchema(child);
      required.push(key);
    }
    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }
  return { type: "string" };
}

/** Coerce architect shorthand ({ text: "string" }) into canonical JSON Schema before validation. */
export function normalizeContractSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (isCanonicalJsonSchema(schema)) {
    if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
      const properties: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(schema.properties as Record<string, unknown>)) {
        if (typeof val === "string") {
          properties[key] = shorthandValueToJsonSchema(val);
        } else if (val && typeof val === "object" && !isCanonicalJsonSchema(val as Record<string, unknown>)) {
          properties[key] = shorthandValueToJsonSchema(val);
        } else if (val && typeof val === "object") {
          properties[key] = normalizeContractSchema(val as Record<string, unknown>);
        } else {
          properties[key] = val;
        }
      }
      return { ...schema, properties };
    }
    return schema;
  }
  if (Object.keys(schema).length === 0) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return shorthandValueToJsonSchema(schema);
}

const artifactMediaTypeSchema = z.enum([
  "application/json",
  "text/plain",
  "text/markdown",
]);

const artifactVisibilitySchema = z.enum(["internal", "operator"]);

export const dataContractSchema = z.object({
  description: z.string().min(1),
  schema: z.record(z.unknown()).default({}),
  representation: z.enum(["text", "json"]).default("text"),
  mediaType: artifactMediaTypeSchema.optional(),
  visibility: artifactVisibilitySchema.optional(),
  renderer: z.string().min(1).optional(),
}).superRefine((contract, ctx) => {
  const mediaType = contract.mediaType ?? (contract.representation === "json" ? "application/json" : "text/plain");
  if (contract.representation === "json" && mediaType !== "application/json") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mediaType"], message: "JSON contracts require application/json" });
  }
  if (contract.representation === "text" && mediaType === "application/json") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mediaType"], message: "Text contracts cannot use application/json" });
  }
  if (contract.representation === "json") {
    if (!isCanonicalJsonSchema(contract.schema)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schema"], message: "JSON contracts require canonical JSON Schema" });
      return;
    }
    if (!ajv.validateSchema(contract.schema)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schema"],
        message: ajv.errorsText(ajv.errors) || "Invalid JSON Schema",
      });
    }
  }
});

export type DataContract = z.infer<typeof dataContractSchema>;

export function contractMediaType(contract: Pick<DataContract, "representation" | "mediaType"> | undefined) {
  return contract?.mediaType ?? (contract?.representation === "json" ? "application/json" : "text/plain");
}

export function contractUsesJson(contract: Pick<DataContract, "representation" | "mediaType"> | undefined): boolean {
  return contractMediaType(contract) === "application/json";
}

export function contractRenderer(contract: Pick<DataContract, "renderer"> | undefined): string | null {
  return contract?.renderer ?? null;
}

export function contractVisibility(contract: Pick<DataContract, "visibility"> | undefined): "internal" | "operator" {
  return contract?.visibility ?? "internal";
}

/** Keep only keys declared in a JSON object schema (top-level). */
export function stripToSchema(schema: Record<string, unknown>, data: unknown): unknown {
  const normalized = normalizeContractSchema(schema);
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if (normalized.type !== "object" || !normalized.properties || typeof normalized.properties !== "object") {
    return data;
  }
  const properties = normalized.properties as Record<string, unknown>;
  const record = data as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    if (key in record) stripped[key] = record[key];
  }
  return stripped;
}

/** Collapse repetitive AJV additionalProperties errors into one readable line. */
export function formatContractValidationReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) return "Structured output failed schema validation.";
  const additionalPropertyMatches = trimmed.match(/data must NOT have additional properties/g);
  if (!additionalPropertyMatches || additionalPropertyMatches.length <= 1) return trimmed;
  const fields = [...trimmed.matchAll(/property '([^']+)'/g)].map((match) => match[1]);
  const uniqueFields = [...new Set(fields.filter(Boolean))];
  if (uniqueFields.length > 0) {
    return `Output has unexpected fields: ${uniqueFields.join(", ")}`;
  }
  return "Output has unexpected additional properties.";
}

export function validateContractData(
  schema: Record<string, unknown>,
  data: unknown,
): { valid: true } | { valid: false; reason: string } {
  const normalized = normalizeContractSchema(schema);
  if (!isCanonicalJsonSchema(normalized)) {
    return { valid: false, reason: "Output contract schema is not canonical JSON Schema." };
  }
  const validate = ajv.compile(normalized);
  if (validate(data)) return { valid: true };
  return {
    valid: false,
    reason: formatContractValidationReason(ajv.errorsText(validate.errors) || "Structured output failed schema validation."),
  };
}
