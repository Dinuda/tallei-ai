import type { ReviewPolicyMode } from "./build-contract.js";
import type { ToolContract } from "../tool-spec/types.js";

export type ConnectorToolRole = "intake" | "draft" | "delivery" | "organize" | "internal";

export type ToolRoleInput = {
  toolRef: string;
  name: string;
  description: string;
  effect: ToolContract["effect"] | "internal";
  skillTags?: string[];
};

export const DELIVERY_ACTION_SLUGS = new Set([
  "GMAIL_REPLY_TO_THREAD",
  "GMAIL_SEND_EMAIL",
  "GMAIL_SEND_DRAFT",
  "GMAIL_CREATE_EMAIL_DRAFT",
]);

export const ORGANIZE_ACTION_SLUGS = new Set([
  "GMAIL_BATCH_MODIFY_MESSAGES",
  "GMAIL_CREATE_LABEL",
  "GMAIL_PATCH_LABEL",
  "GMAIL_DELETE_LABEL",
]);

export function actionSlugFromToolRef(toolRef: string): string {
  const fromRef = toolRef.split(".").pop() ?? "";
  return fromRef.replace(/-/g, "_").toUpperCase();
}

export function contractActionSlug(contract: ToolContract): string {
  const configured = contract.constraints.actionSlug;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return contract.toolRef.split(".").pop() ?? contract.name;
}

export function toToolRoleInput(
  source: ToolRoleInput | ToolContract,
): ToolRoleInput {
  if ("constraints" in source) {
    return {
      toolRef: source.toolRef,
      name: source.name,
      description: source.description,
      effect: source.effect,
      skillTags: source.skillTags,
    };
  }
  return source;
}

export function isSendLikeTool(input: ToolRoleInput): boolean {
  if (input.effect === "irreversible_external") return true;
  const slug = actionSlugFromToolRef(input.toolRef);
  if (DELIVERY_ACTION_SLUGS.has(slug)) return true;
  if (input.skillTags?.includes("send")) return true;
  const text = `${input.toolRef} ${input.name} ${input.description}`.toLowerCase();
  return /\bsend|sent|publish|post\b/.test(text)
    || (input.effect === "write_external" && /\bsend|publish|post\b/.test(text));
}

export function isWriteTool(input: ToolRoleInput): boolean {
  return input.effect === "write_external" || input.effect === "irreversible_external";
}

export function connectorToolRole(
  input: ToolRoleInput,
  reviewPolicy: ReviewPolicyMode | null,
): ConnectorToolRole {
  if (input.effect === "internal" || input.toolRef.startsWith("internal.")) return "internal";
  const slug = actionSlugFromToolRef(input.toolRef);
  if (DELIVERY_ACTION_SLUGS.has(slug)) {
    return reviewPolicy === "draft_only" && slug !== "GMAIL_CREATE_EMAIL_DRAFT" ? "draft" : "delivery";
  }
  if (ORGANIZE_ACTION_SLUGS.has(slug)) return "organize";
  if (input.effect === "read_external") return "intake";
  if (reviewPolicy !== "draft_only" && isSendLikeTool(input)) return "delivery";
  if (isWriteTool(input)) return "draft";
  return "intake";
}

export function connectorToolRoleFromContract(
  contract: ToolContract,
  reviewPolicy: ReviewPolicyMode | null,
): ConnectorToolRole {
  return connectorToolRole(toToolRoleInput(contract), reviewPolicy);
}

export function isSendLikeContract(contract: ToolContract): boolean {
  return isSendLikeTool(toToolRoleInput(contract));
}

export function isWriteContract(contract: ToolContract): boolean {
  return isWriteTool(toToolRoleInput(contract));
}

/** Whether a contract belongs in the run-plan read-tools registry. */
export function isPlanReadTool(
  contract: ToolContract,
  reviewPolicy: ReviewPolicyMode | null,
): boolean {
  return connectorToolRoleFromContract(contract, reviewPolicy) === "intake";
}

/** Whether a contract belongs in the run-plan write-tools registry. */
export function isPlanWriteTool(
  contract: ToolContract,
  reviewPolicy: ReviewPolicyMode | null,
): boolean {
  const role = connectorToolRoleFromContract(contract, reviewPolicy);
  return role === "draft" || role === "delivery" || role === "organize";
}
