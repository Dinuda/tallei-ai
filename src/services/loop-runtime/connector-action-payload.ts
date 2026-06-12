import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

import { listComposioToolkitTools, resolveComposioToolVersion } from "../connectors/composio.js";
import { searchLearnedToolSpecs } from "../tool-spec/learned-catalog.js";
import { buildComposioActionContract, hasExactComposioActionSchemas, parseConnectorActionToolRef } from "../tool-spec/tool-contracts.js";
import type { ToolContract } from "../tool-spec/types.js";
import type { ConnectorActionReadinessContract } from "../tool-spec/action-readiness.js";
import type { RuntimeDefinition } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

export type ConnectorActionContractSnapshot = {
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

export type ActionPayloadValidation = {
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

function contractFromDefinition(definition: RuntimeDefinition, toolRef: string): ToolContract | null {
  const normalized = toolRef.toLowerCase();
  for (const raw of definition.builderMeta?.discoveredToolContracts ?? []) {
    const contract = raw as unknown as ToolContract;
    if (contract?.toolRef?.toLowerCase() === normalized && contract.inputSchema) return contract;
  }
  return null;
}

export async function resolveConnectorActionContract(input: {
  definition: RuntimeDefinition;
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
