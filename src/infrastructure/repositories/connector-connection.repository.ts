import type { AuthContext } from "../../domain/auth/index.js";
import { poolQuery } from "../db/index.js";

export type ConnectorConnectionStatus = "pending" | "connected" | "disconnected" | "failed";

export type ConnectorConnectionRecord = {
  id: string;
  provider: string;
  tenantId: string;
  userId: string;
  workspaceId?: string;
  toolkit: string;
  externalAccountId?: string;
  externalRequestId?: string;
  status: ConnectorConnectionStatus;
};

type ConnectorConnectionRow = {
  id: string;
  provider: string;
  tenant_id: string;
  user_id: string;
  workspace_id: string | null;
  toolkit: string;
  external_account_id: string | null;
  external_request_id: string | null;
  status: ConnectorConnectionStatus;
};

function mapRow(row: ConnectorConnectionRow): ConnectorConnectionRecord {
  return {
    id: row.id,
    provider: row.provider,
    tenantId: row.tenant_id,
    userId: row.user_id,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    toolkit: row.toolkit,
    ...(row.external_account_id ? { externalAccountId: row.external_account_id } : {}),
    ...(row.external_request_id ? { externalRequestId: row.external_request_id } : {}),
    status: row.status,
  };
}

export async function upsertConnectorConnection(input: {
  auth: AuthContext;
  provider: string;
  toolkit: string;
  externalAccountId?: string;
  externalRequestId?: string;
  status: ConnectorConnectionStatus;
}): Promise<ConnectorConnectionRecord> {
  const result = await poolQuery<ConnectorConnectionRow>(
    `INSERT INTO connector_connections (
       provider, tenant_id, user_id, workspace_id, toolkit,
       external_account_id, external_request_id, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, tenant_id, user_id, workspace_id, toolkit) DO UPDATE SET
       external_account_id = COALESCE(EXCLUDED.external_account_id, connector_connections.external_account_id),
       external_request_id = COALESCE(EXCLUDED.external_request_id, connector_connections.external_request_id),
       status = EXCLUDED.status,
       updated_at = NOW()
     RETURNING id, provider, tenant_id, user_id, workspace_id, toolkit,
       external_account_id, external_request_id, status`,
    [
      input.provider,
      input.auth.tenantId,
      input.auth.userId,
      input.auth.workspaceId ?? null,
      input.toolkit,
      input.externalAccountId ?? null,
      input.externalRequestId ?? null,
      input.status,
    ],
  );
  return mapRow(result.rows[0]!);
}

export async function findConnectorConnectionByRequest(input: {
  auth: AuthContext;
  provider: string;
  externalRequestId: string;
}): Promise<ConnectorConnectionRecord | null> {
  const result = await poolQuery<ConnectorConnectionRow>(
    `SELECT id, provider, tenant_id, user_id, workspace_id, toolkit,
       external_account_id, external_request_id, status
     FROM connector_connections
     WHERE provider = $1 AND external_request_id = $2
       AND tenant_id = $3 AND user_id = $4
       AND workspace_id IS NOT DISTINCT FROM $5`,
    [input.provider, input.externalRequestId, input.auth.tenantId, input.auth.userId, input.auth.workspaceId ?? null],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listConnectorConnections(
  auth: AuthContext,
  provider: string,
): Promise<ConnectorConnectionRecord[]> {
  const result = await poolQuery<ConnectorConnectionRow>(
    `SELECT id, provider, tenant_id, user_id, workspace_id, toolkit,
       external_account_id, external_request_id, status
     FROM connector_connections
     WHERE provider = $1 AND tenant_id = $2 AND user_id = $3
       AND workspace_id IS NOT DISTINCT FROM $4`,
    [provider, auth.tenantId, auth.userId, auth.workspaceId ?? null],
  );
  return result.rows.map(mapRow);
}
