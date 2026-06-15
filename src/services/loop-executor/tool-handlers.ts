/**
 * tool-handlers.ts — Pluggable tool dispatch registry for loop agents.
 *
 * Each tool ref maps to a handler function. New tools register here
 * without modifying agent-runner.ts.
 */

import type { AuthContext } from "../../domain/auth/index.js";
import type { LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";

type ToolHandlerResult = {
  text: string;
  data?: Record<string, unknown>;
  shortCircuit?: boolean;
  draft?: unknown;
};

export type ToolHandlerContext = {
  auth: AuthContext;
  goal: string;
  agent: LoopRunAgent;
  assignment: LoopToolAssignment;
  priorComments: Array<{ author: string; body: string }>;
  runId?: string;
  workflowId?: string;
  workflowTitle?: string;
  definition?: LoopDefinition;
};

type ToolHandler = (ctx: ToolHandlerContext) => Promise<ToolHandlerResult>;

const handlers = new Map<string, ToolHandler>();

export function registerToolHandler(ref: string, handler: ToolHandler): void {
  handlers.set(ref, handler);
}

export function getToolHandler(ref: string): ToolHandler | undefined {
  return handlers.get(ref)
    ?? (/^composio\.[a-z0-9_-]+\.search$/i.test(ref) ? handlers.get("composio.*.search") : undefined)
    ?? (/^composio\.[a-z0-9_-]+\.action\./i.test(ref) ? handlers.get("composio.*.action") : undefined);
}

function hasToolHandler(ref: string): boolean {
  return Boolean(getToolHandler(ref));
}
