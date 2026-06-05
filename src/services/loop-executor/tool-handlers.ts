/**
 * tool-handlers.ts — Pluggable tool dispatch registry for loop agents.
 *
 * Each tool ref maps to a handler function. New tools register here
 * without modifying agent-runner.ts.
 */

import type { AuthContext } from "../../domain/auth/index.js";
import type { LoopDefinition, LoopRunAgent, LoopToolAssignment } from "./types.js";

export type ToolHandlerResult = {
  text: string;
  data?: Record<string, unknown>;
  shortCircuit?: boolean;
  emailApprovalSent?: boolean;
  approvalRequest?: { to: string; approvalUrl: string; token: string; sentAt: string; channel?: string };
  artifactBody?: string;
  emailTemplate?: { html: string; text?: string; design?: unknown; subject?: string | null; updatedAt?: string; source?: string };
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

export type ToolHandler = (ctx: ToolHandlerContext) => Promise<ToolHandlerResult>;

const handlers = new Map<string, ToolHandler>();

export function registerToolHandler(ref: string, handler: ToolHandler): void {
  handlers.set(ref, handler);
}

export function getToolHandler(ref: string): ToolHandler | undefined {
  return handlers.get(ref);
}

export function hasToolHandler(ref: string): boolean {
  return handlers.has(ref);
}
