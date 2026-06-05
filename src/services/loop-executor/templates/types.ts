import type { LoopAgentGraphChild } from "../types.js";

/** Reference template for loop-builder inspiration — not an executable shortcut. */
export interface LoopTemplate {
  id: string;
  label: string;
  description: string;
  tags: string[];
  highPotential: boolean;
  summary: string;
  whenToUse: string;
  suggestedTools: string[];
  exampleAgents: Array<Pick<LoopAgentGraphChild, "id" | "name" | "task"> & { tools?: string[] }>;
  deliveryTypeHint?: string;
  presetIdHint?: string;
}
