import type { AuthContext } from "../../domain/auth/index.js";
import { pool } from "../../infrastructure/db/index.js";
import type { ToolContract, ToolUseCase } from "./types.js";

export type LearnedToolSpec = {
  toolRef: string;
  toolkit: string;
  actionSlug: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  contract: ToolContract;
  usageCount: number;
};

export async function searchLearnedToolSpecs(query: string, limit = 12): Promise<LearnedToolSpec[]> {
  const terms = query.trim().replace(/\s+/g, " ");
  if (!terms) return [];
  const result = await pool.query<{
    tool_ref: string; toolkit: string; action_slug: string; name: string; description: string;
    input_schema: unknown; output_schema: unknown; contract_json: unknown; usage_count: number;
  }>(
    `SELECT tool_ref, toolkit, action_slug, name, description, input_schema, output_schema, contract_json, usage_count
     FROM learned_tool_specs
     WHERE to_tsvector('simple', name || ' ' || description || ' ' || toolkit || ' ' || action_slug)
       @@ plainto_tsquery('simple', $1)
     ORDER BY usage_count DESC, last_discovered_at DESC
     LIMIT $2`,
    [terms, Math.max(1, Math.min(limit, 50))],
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => ({
    toolRef: row.tool_ref,
    toolkit: row.toolkit,
    actionSlug: row.action_slug,
    name: row.name,
    description: row.description,
    inputSchema: row.input_schema as Record<string, unknown>,
    outputSchema: row.output_schema as Record<string, unknown>,
    contract: row.contract_json as ToolContract,
    usageCount: row.usage_count,
  }));
}

export async function listLearnedToolSpecs(limit = 100): Promise<LearnedToolSpec[]> {
  const result = await pool.query<{
    tool_ref: string; toolkit: string; action_slug: string; name: string; description: string;
    input_schema: unknown; output_schema: unknown; contract_json: unknown; usage_count: number;
  }>(
    `SELECT tool_ref, toolkit, action_slug, name, description, input_schema, output_schema, contract_json, usage_count
     FROM learned_tool_specs
     ORDER BY usage_count DESC, last_discovered_at DESC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 250))],
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => ({
    toolRef: row.tool_ref,
    toolkit: row.toolkit,
    actionSlug: row.action_slug,
    name: row.name,
    description: row.description,
    inputSchema: row.input_schema as Record<string, unknown>,
    outputSchema: row.output_schema as Record<string, unknown>,
    contract: row.contract_json as ToolContract,
    usageCount: row.usage_count,
  }));
}

export async function listLearnedUseCases(auth: AuthContext, limit = 50): Promise<ToolUseCase[]> {
  const result = await pool.query<{
    name: string; description: string; required_tools: string[]; outcome: string; category: ToolUseCase["category"];
  }>(
    `SELECT name, description, required_tools, outcome, category
     FROM learned_tool_use_cases
     WHERE tenant_id = $1
     ORDER BY usage_count DESC, last_used_at DESC
     LIMIT $2`,
    [auth.tenantId, Math.max(1, Math.min(limit, 100))],
  ).catch(() => ({ rows: [] }));
  return result.rows.map((row) => ({
    name: row.name,
    description: row.description,
    requiredTools: row.required_tools,
    outcome: row.outcome,
    category: row.category,
  }));
}

export async function recordLearnedWorkflow(input: {
  auth: AuthContext;
  title: string;
  summary: string;
  outcome: string;
  category: ToolUseCase["category"];
  contracts: ToolContract[];
  requiredTools?: string[];
  handoffPatterns?: Array<Record<string, unknown>>;
}): Promise<void> {
  const composioContracts = input.contracts.filter((contract) => contract.provider === "composio");
  for (const contract of composioContracts) {
    const toolkit = String(contract.constraints.toolkit ?? "");
    const actionSlug = String(contract.constraints.actionSlug ?? "");
    if (!toolkit || !actionSlug) continue;
    await pool.query(
      `INSERT INTO learned_tool_specs
       (tool_ref, toolkit, action_slug, name, description, input_schema, output_schema, contract_json,
        readiness_contract, contract_source_hash, usage_count, first_discovered_at, last_discovered_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, 1, NOW(), NOW())
       ON CONFLICT (tool_ref) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, input_schema = EXCLUDED.input_schema,
         output_schema = EXCLUDED.output_schema, contract_json = EXCLUDED.contract_json,
         readiness_contract = EXCLUDED.readiness_contract, contract_source_hash = EXCLUDED.contract_source_hash,
         usage_count = learned_tool_specs.usage_count + 1, last_discovered_at = NOW()`,
      [contract.toolRef, toolkit, actionSlug, contract.name, contract.description,
        JSON.stringify(contract.inputSchema), JSON.stringify(contract.outputSchema), JSON.stringify(contract),
        JSON.stringify(contract.readiness ?? null), contract.readiness?.sourceHash ?? null],
    );
  }
  const requiredTools = [...new Set(input.requiredTools ?? input.contracts.map((contract) => contract.toolRef))];
  const fingerprint = requiredTools.slice().sort().join("|");
  await pool.query(
    `INSERT INTO learned_tool_use_cases
     (tenant_id, fingerprint, name, description, outcome, category, required_tools, handoff_patterns, usage_count, first_used_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1, NOW(), NOW())
     ON CONFLICT (tenant_id, fingerprint) DO UPDATE SET
       name = EXCLUDED.name, description = EXCLUDED.description, outcome = EXCLUDED.outcome,
       category = EXCLUDED.category, handoff_patterns = EXCLUDED.handoff_patterns,
       usage_count = learned_tool_use_cases.usage_count + 1, last_used_at = NOW()`,
    [input.auth.tenantId, fingerprint, input.title.slice(0, 120), input.summary.slice(0, 500),
      input.outcome.slice(0, 500), input.category, requiredTools, JSON.stringify(input.handoffPatterns ?? [])],
  );
}
