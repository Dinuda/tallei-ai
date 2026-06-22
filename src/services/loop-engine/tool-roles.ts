import type { ToolContract } from "../tool-spec/types.js";

export function actionSlugFromToolRef(toolRef: string): string {
  const fromRef = toolRef.split(".").pop() ?? "";
  return fromRef.replace(/-/g, "_").toUpperCase();
}

export function contractActionSlug(contract: ToolContract): string {
  const configured = contract.constraints.actionSlug;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return contract.toolRef.split(".").pop() ?? contract.name;
}
