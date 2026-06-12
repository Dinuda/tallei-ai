import { createHash } from "crypto";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

export type ConnectorSemanticAssertion = {
  kind: "at_least_one" | "non_placeholder";
  paths: string[];
  message: string;
};

export type ConnectorActionReadinessContract = {
  toolRef: string;
  originalInputSchema: Record<string, unknown>;
  effectiveInputSchema: Record<string, unknown>;
  semanticAssertions: ConnectorSemanticAssertion[];
  fieldPolicies: Record<string, {
    valuePolicy: "derivable" | "passthrough";
    required: boolean;
    description?: string;
  }>;
  unresolvedRequirements: string[];
  sourceHash: string;
  generatedBy: "sdk_contract" | "model_annotation" | "reviewed_override";
  generatedAt: string;
};

export type ReadinessValidation = {
  valid: boolean;
  errors: Array<{ path: string; message: string; keyword: string }>;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function containsUnresolvedTemplate(value: unknown): boolean {
  if (typeof value === "string") {
    return /\{\{[^{}]+\}\}|\$\{[^{}]+\}|<%=?[\s\S]*?%>|\[(?:tbd|todo|insert|fill|paste)[^\]]*\]/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsUnresolvedTemplate);
  return Boolean(value && typeof value === "object"
    && Object.values(value as Record<string, unknown>).some(containsUnresolvedTemplate));
}

export function buildConnectorActionReadinessContract(input: {
  toolRef: string;
  inputSchema: Record<string, unknown>;
}): ConnectorActionReadinessContract {
  const originalInputSchema = clone(input.inputSchema);
  const effectiveInputSchema = clone(input.inputSchema);
  return {
    toolRef: input.toolRef,
    originalInputSchema,
    effectiveInputSchema,
    semanticAssertions: [
      { kind: "non_placeholder", paths: ["/"], message: "Connector inputs must not contain unresolved templates." },
    ],
    fieldPolicies: {},
    unresolvedRequirements: [],
    sourceHash: createHash("sha256").update(JSON.stringify(originalInputSchema)).digest("hex"),
    generatedBy: "sdk_contract",
    generatedAt: new Date().toISOString(),
  };
}

function normalizeErrors(errors: ErrorObject[] | null | undefined): ReadinessValidation["errors"] {
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

function valueAtPath(value: Record<string, unknown>, path: string): unknown {
  return path.split("/").filter(Boolean).reduce<unknown>((current, segment) => (
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)[segment]
      : undefined
  ), value);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

export function validateConnectorReadiness(
  contract: Pick<ConnectorActionReadinessContract, "effectiveInputSchema" | "semanticAssertions">,
  payload: Record<string, unknown>,
): ReadinessValidation {
  const errors: ReadinessValidation["errors"] = [];
  try {
    const validate = ajv.compile(contract.effectiveInputSchema);
    validate(payload);
    errors.push(...normalizeErrors(validate.errors));
  } catch (error) {
    errors.push({ path: "/", keyword: "schema", message: error instanceof Error ? error.message : String(error) });
  }
  for (const assertion of contract.semanticAssertions) {
    if (assertion.kind === "non_placeholder" && containsUnresolvedTemplate(payload)) {
      errors.push({ path: "/", keyword: "non_placeholder", message: assertion.message });
    }
    if (assertion.kind === "at_least_one" && !assertion.paths.some((path) => hasMeaningfulValue(valueAtPath(payload, path)))) {
      errors.push({ path: assertion.paths.join("|"), keyword: "at_least_one", message: assertion.message });
    }
  }
  return { valid: errors.length === 0, errors };
}
