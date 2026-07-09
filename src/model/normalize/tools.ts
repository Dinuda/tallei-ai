import type { AppTool, AppToolCall, AppToolChoice } from "../types.js";

export function normalizeToolCalls(value: unknown): AppToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: AppToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : typeof row.toolCallId === "string" ? row.toolCallId : "";
    const name = typeof row.name === "string" ? row.name : typeof row.toolName === "string" ? row.toolName : "";
    if (!id || !name) continue;
    let args: unknown = row.arguments ?? row.input ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = { raw: args };
      }
    }
    calls.push({ id, name, arguments: args });
  }
  return calls;
}

export function resolveEffectiveToolChoice(
  toolChoice: AppToolChoice | undefined,
  toolCount: number,
  supportsForcedToolChoice: boolean,
): AppToolChoice {
  if (toolCount === 0) return "none";
  if (!supportsForcedToolChoice) return "auto";
  return toolChoice ?? "required";
}

export function appToolsToJsonSchemaTools(tools: readonly AppTool[] | undefined): AppTool[] {
  return tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })) ?? [];
}
