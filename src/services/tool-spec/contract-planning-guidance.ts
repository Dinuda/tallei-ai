import type { ToolContract } from "./types.js";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function propertyNames(schema: Record<string, unknown>): string[] {
  return Object.keys(asObject(schema.properties));
}

function requiredPropertyNames(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function propertySchema(schema: Record<string, unknown>, key: string): Record<string, unknown> {
  return asObject(asObject(schema.properties)[key]);
}

function schemaDeclaresDraftId(schema: Record<string, unknown>): boolean {
  return JSON.stringify(schema).toLowerCase().includes("draft_id");
}

function derivePlanningHintsFromSchema(contract: ToolContract): string[] {
  const hints: string[] = [];
  const input = contract.inputSchema;
  const inputProps = propertyNames(input);
  const inputRequired = new Set(requiredPropertyNames(input));

  if (inputRequired.has("subject") && inputRequired.has("body")) {
    hints.push(
      "This action requires separate /subject and /body inputs. The composing semantic agent must use a json outputArtifact with explicit /subject and /body fields.",
    );
  }

  for (const key of ["bcc", "cc", "extra_recipients"]) {
    if (!inputProps.includes(key)) continue;
    const prop = propertySchema(input, key);
    if (prop.type === "array" && asObject(prop.items).type === "string") {
      hints.push(
        `Optional /${key} requires a string array of email addresses. Bind only from contacts_csv required values or agent_output email arrays.`,
      );
    }
  }

  if (inputProps.some((key) => /recipient|attendee|to/i.test(key))) {
    hints.push(
      "Recipient fields accept concrete email addresses or contact lists. Bind from contacts_csv required values or operator-supplied email strings, not audience names alone.",
    );
  }

  if (schemaDeclaresDraftId(contract.outputSchema)) {
    hints.push(
      "This action exposes draft identifiers in outputPaths. Downstream send-draft actions may bind only from those exact declared output paths.",
    );
  }

  if (inputProps.some((key) => key.includes("draft")) && inputRequired.size > 0) {
    hints.push(
      "This action consumes a draft identifier. Select it only when an upstream action outputPaths explicitly expose that exact draft id field.",
    );
  }

  return hints;
}

export function planningHintsForContract(contract: ToolContract): string[] {
  const derivedHints = derivePlanningHintsFromSchema(contract);
  return [...new Set([...derivedHints, ...(contract.planningHints ?? [])])];
}

export function enrichContractPlanningGuidance(contract: ToolContract): ToolContract {
  const planningHints = planningHintsForContract(contract);
  return planningHints.length > 0 ? { ...contract, planningHints } : contract;
}
