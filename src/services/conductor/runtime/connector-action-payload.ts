import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

import { listComposioToolkitTools, resolveComposioToolVersion } from "../../connectors/composio.js";
import { parseContactListCsv } from "../workflow/csv-parser.js";
import { searchLearnedToolSpecs } from "../../tool-spec/learned-catalog.js";
import { buildComposioActionContract, hasExactComposioActionSchemas, parseConnectorActionToolRef } from "../../tool-spec/tool-contracts.js";
import type { ToolContract } from "../../tool-spec/types.js";
import type { ConnectorActionReadinessContract } from "../../tool-spec/action-readiness.js";

type ConnectorDefinitionContext = {
  builderMeta?: {
    discoveredToolContracts?: Array<Record<string, unknown>>;
  };
};

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

type ConnectorActionContractSnapshot = {
  toolRef: string;
  toolkit: string;
  actionSlug: string;
  toolkitVersion: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  risk: string;
  requiresApproval: boolean;
  source: ToolContract["source"] | "composio_lookup";
  readiness: ConnectorActionReadinessContract;
};

type ActionPayloadValidation = {
  valid: boolean;
  errors: Array<{ path: string; message: string; keyword: string }>;
};

export class ConnectorActionPayloadError extends Error {
  constructor(
    message: string,
    readonly details: {
      contract: ConnectorActionContractSnapshot;
      validationErrors: ActionPayloadValidation["errors"];
      attempts: number;
    },
  ) {
    super(message);
    this.name = "ConnectorActionPayloadError";
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasEmailShape(value: string): boolean {
  return value.includes("@");
}

export function extractEmailAddresses(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") {
        const trimmed = item.trim();
        return hasEmailShape(trimmed) ? [trimmed] : [];
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        const email = typeof record.email === "string" ? record.email.trim() : "";
        return hasEmailShape(email) ? [email] : [];
      }
      return [];
    });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.contacts)) return extractEmailAddresses(record.contacts);
    if (typeof record.audienceId === "string" && hasEmailShape(record.audienceId.trim())) {
      return [record.audienceId.trim()];
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (/[,;\n]/.test(trimmed)) {
      const split = trimmed.split(/[,;\n]+/).map((part) => part.trim()).filter(hasEmailShape);
      if (split.length > 0) return split;
    }
    try {
      return parseContactListCsv(trimmed).map((contact) => contact.email);
    } catch {
      return hasEmailShape(trimmed) ? [trimmed] : [];
    }
  }
  return [];
}

function isMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function propertyExpectsStringArray(propSchema: Record<string, unknown>): boolean {
  if (propSchema.type !== "array") return false;
  const items = asObject(propSchema.items);
  return items.type === "string";
}

function propertyExpectsContactEmailArray(propSchema: Record<string, unknown>): boolean {
  if (propSchema.type !== "array") return false;
  if (propertyExpectsStringArray(propSchema)) return true;
  const items = asObject(propSchema.items);
  const anyOf = Array.isArray(items.anyOf) ? items.anyOf : [];
  return anyOf.some((entry) => {
    const row = asObject(entry);
    if (row.type === "string") return true;
    if (row.type !== "object") return false;
    const props = asObject(row.properties);
    return typeof props.email === "object" || row.additionalProperties === true;
  });
}

function coerceContactEmailArrayValue(value: unknown): string[] {
  const emails = extractEmailAddresses(value);
  if (emails.length > 0) return emails;
  if (typeof value === "string" && value.trim() && hasEmailShape(value.trim())) return [value.trim()];
  return [];
}

/**
 * Coerces handoff-resolved connector payloads to match the exact Composio input schema.
 * Contact lists are often bound as CSV strings or { contacts: [...] } objects while connector
 * actions expect string arrays or attendee email lists.
 */
export function normalizeConnectorPayloadForSchema(
  payload: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = asObject(schema.properties);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const normalized: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(payload)) {
    const propSchema = asObject(properties[key]);
    if (Object.keys(propSchema).length === 0) {
      if (isMeaningfulValue(rawValue)) normalized[key] = rawValue;
      continue;
    }

    let value = rawValue;
    const propType = typeof propSchema.type === "string" ? propSchema.type : null;

    if (propertyExpectsContactEmailArray(propSchema)) {
      const emails = coerceContactEmailArrayValue(value);
      if (emails.length > 0) {
        value = emails;
      } else if (typeof value === "string" && value.trim()) {
        value = [value.trim()];
      }
    } else if (propType === "string" && typeof value !== "string") {
      const emails = extractEmailAddresses(value);
      if (emails.length === 1) value = emails[0]!;
      else if (emails.length > 1) value = emails[0]!;
    }

    if (!required.has(key)) {
      if (!isMeaningfulValue(value)) continue;
      if (propertyExpectsContactEmailArray(propSchema) && Array.isArray(value)) {
        const emails = value.filter((item): item is string => typeof item === "string" && hasEmailShape(item.trim()));
        if (emails.length === 0) continue;
        value = emails;
      }
    }

    normalized[key] = value;
  }

  return normalized;
}

export function mergeStableConfigWithRuntimeInputs(
  stableConfig: Record<string, unknown>,
  operatorInputs: Record<string, unknown>,
  handoffBindings: Array<{ source: { kind: string; path: string } }>,
): Record<string, unknown> {
  const merged = { ...stableConfig };
  for (const binding of handoffBindings) {
    if (binding.source.kind !== "stable_config" || !binding.source.path.startsWith("/")) continue;
    const key = binding.source.path.split("/").filter(Boolean)[0];
    if (!key || operatorInputs[key] === undefined) continue;
    const current = merged[key];
    if (current === undefined || current === null || current === "") {
      merged[key] = operatorInputs[key];
    }
  }
  return merged;
}

function normalizeErrors(errors: ErrorObject[] | null | undefined): ActionPayloadValidation["errors"] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || (
      error.keyword === "required" && typeof error.params.missingProperty === "string"
        ? `/${error.params.missingProperty}`
        : "/"
    ),
    message: error.message ?? "Schema validation failed",
    keyword: error.keyword,
  }));
}

export function validateConnectorActionPayload(
  contract: Pick<ConnectorActionContractSnapshot, "inputSchema">,
  payload: Record<string, unknown>,
): ActionPayloadValidation {
  try {
    const validate = ajv.compile(contract.inputSchema);
    return { valid: Boolean(validate(payload)), errors: normalizeErrors(validate.errors) };
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: "/", keyword: "schema", message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

export function validateConnectorActionOutput(
  contract: Pick<ConnectorActionContractSnapshot, "outputSchema">,
  output: unknown,
): ActionPayloadValidation {
  if (Object.keys(contract.outputSchema).length === 0) return { valid: true, errors: [] };
  try {
    const validate = ajv.compile(contract.outputSchema);
    return { valid: Boolean(validate(output)), errors: normalizeErrors(validate.errors) };
  } catch {
    // A provider schema that Ajv cannot compile should not hide an otherwise valid provider result.
    return { valid: true, errors: [] };
  }
}

function composioActionResultEnvelope(raw: Record<string, unknown>): Record<string, unknown> | null {
  const envelope = asObject(raw.result);
  const nested = asObject(envelope.result);
  for (const candidate of [envelope, nested, raw]) {
    if (typeof candidate.successful === "boolean" && "data" in candidate) {
      return {
        successful: candidate.successful,
        data: candidate.data,
        ...(candidate.error !== undefined && candidate.error !== null && candidate.error !== ""
          ? { error: candidate.error }
          : {}),
      };
    }
  }
  return null;
}

/**
 * Composio often returns null for optional string metadata fields such as
 * composio_execution_message even though the published output schema types them as string.
 * Strip nulls and coerce composio_* metadata before AJV validation so successful actions
 * are not failed on provider envelope quirks.
 */
export function sanitizeComposioProviderOutput(output: unknown): unknown {
  if (Array.isArray(output)) return output.map(sanitizeComposioProviderOutput);
  if (!output || typeof output !== "object") return output;

  const record = output as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;

    if (key.startsWith("composio_")) {
      if (typeof value === "string") sanitized[key] = value;
      else if (typeof value === "number" || typeof value === "boolean") sanitized[key] = String(value);
      continue;
    }

    if (Array.isArray(value)) {
      sanitized[key] = value.map(sanitizeComposioProviderOutput);
      continue;
    }

    if (typeof value === "object") {
      sanitized[key] = sanitizeComposioProviderOutput(value);
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

/**
 * Composio SDK responses are wrapped ({ adapter, result: { successful, data } }) while the
 * stored outputSchema describes the inner Composio envelope ({ successful, data }). Validate
 * against that envelope, not the extracted actionOutputData payload alone.
 */
export function resolveConnectorOutputForValidation(
  contract: Pick<ConnectorActionContractSnapshot, "outputSchema">,
  result: {
    output?: Record<string, unknown>;
    rawResponse?: Record<string, unknown>;
    actionOutputData?: unknown;
    ok?: boolean;
  },
): unknown {
  const properties = asObject(contract.outputSchema.properties);
  const required = Array.isArray(contract.outputSchema.required)
    ? contract.outputSchema.required.filter((value): value is string => typeof value === "string")
    : [];
  const validatesInternalEnvelope = "ok" in properties && "output" in properties;
  const validatesComposioEnvelope = ("successful" in properties && "data" in properties)
    || (required.includes("successful") && required.includes("data"));

  if (validatesInternalEnvelope) return result;

  if (validatesComposioEnvelope) {
    const raw = asObject(result.rawResponse ?? result.output);
    const envelope = composioActionResultEnvelope(raw);
    if (envelope) {
      return sanitizeComposioProviderOutput(envelope);
    }
    if (result.actionOutputData !== undefined) {
      return sanitizeComposioProviderOutput({ successful: result.ok !== false, data: result.actionOutputData });
    }
    return sanitizeComposioProviderOutput(raw);
  }

  return sanitizeComposioProviderOutput(result.actionOutputData ?? result.output ?? {});
}

function contractFromDefinition(definition: ConnectorDefinitionContext, toolRef: string): ToolContract | null {
  const normalized = toolRef.toLowerCase();
  for (const raw of definition.builderMeta?.discoveredToolContracts ?? []) {
    const contract = raw as unknown as ToolContract;
    if (contract?.toolRef?.toLowerCase() === normalized && contract.inputSchema) return contract;
  }
  return null;
}

export async function resolveConnectorActionContract(input: {
  definition: ConnectorDefinitionContext;
  toolRef: string;
}): Promise<ConnectorActionContractSnapshot> {
  const parsed = parseConnectorActionToolRef(input.toolRef);
  if (!parsed) throw new Error(`Invalid Composio action ref: ${input.toolRef}`);

  let contract = contractFromDefinition(input.definition, input.toolRef);
  if (contract && !hasExactComposioActionSchemas(contract)) contract = null;
  let source: ConnectorActionContractSnapshot["source"] = contract?.source ?? "composio_lookup";
  if (!contract) {
    const learned = await searchLearnedToolSpecs(`${parsed.toolkit} ${parsed.actionSlug}`, 20);
    contract = learned.find((item) => item.toolRef.toLowerCase() === input.toolRef.toLowerCase())?.contract ?? null;
    if (contract && !hasExactComposioActionSchemas(contract)) contract = null;
    source = contract?.source ?? "composio_lookup";
  }
  if (!contract) {
    const actions = await listComposioToolkitTools(parsed.toolkit);
    const action = actions.find((item) => item.actionSlug.toLowerCase() === parsed.actionSlug.toLowerCase());
    if (!action || !hasExactComposioActionSchemas(action)) {
      throw new Error(`Unable to resolve exact Composio contract for ${input.toolRef}`);
    }
    contract = buildComposioActionContract(action);
  }
  const persistedVersion = String(contract.constraints.toolkitVersion ?? "").trim();
  const toolkitVersion = persistedVersion && persistedVersion.toLowerCase() !== "latest"
    ? persistedVersion
    : await resolveComposioToolVersion(parsed.actionSlug);
  return {
    toolRef: contract.toolRef,
    toolkit: String(contract.constraints.toolkit ?? parsed.toolkit),
    actionSlug: String(contract.constraints.actionSlug ?? parsed.actionSlug),
    toolkitVersion,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    risk: String(contract.constraints.risk ?? "write"),
    requiresApproval: contract.approval.required,
    source,
    readiness: contract.readiness ?? {
      toolRef: contract.toolRef,
      originalInputSchema: contract.inputSchema,
      effectiveInputSchema: contract.inputSchema,
      semanticAssertions: [],
      fieldPolicies: {},
      unresolvedRequirements: ["Saved connector contract has no typed readiness contract."],
      sourceHash: "",
      generatedBy: "sdk_contract",
      generatedAt: new Date(0).toISOString(),
    },
  };
}

export function sanitizeConnectorDetails(value: unknown): unknown {
  const secretPattern = /(authorization|api[_-]?key|token|secret|password|credential|cookie)/i;
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 8) return "[truncated]";
    if (Array.isArray(item)) return item.slice(0, 100).map((entry) => visit(entry, depth + 1));
    if (!item || typeof item !== "object") {
      return typeof item === "string" && item.length > 8_000 ? `${item.slice(0, 8_000)}[truncated]` : item;
    }
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, entry]) => [
      key,
      secretPattern.test(key) ? "[redacted]" : visit(entry, depth + 1),
    ]));
  };
  return visit(value, 0);
}
