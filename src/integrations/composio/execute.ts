import { config } from "../../config/index.js";
import type { AuthContext } from "../../domain/auth/index.js";
import { normalizeToolkitSlug } from "./auth.js";
import {
  composioRequest,
  getComposioClient,
  getComposioEntityId,
  getComposioRawToolsClient,
  isComposioConfigured,
  rememberToolkitVersion,
  toObjectRecord,
} from "./client.js";
import { getAllTools } from "./tools.js";

const toolkitVersionCache = new Map<string, string>();

function pickVersion(raw: unknown): string | null {
  const row = toObjectRecord(raw);
  const toolkit = toObjectRecord(row.toolkit);
  const candidates = [
    row.version,
    row.toolkitVersion,
    row.toolkit_version,
    toolkit.version,
    toolkit.currentVersion,
    toObjectRecord(row.meta).version,
  ];
  for (const candidate of candidates) {
    const version = String(candidate ?? "").trim();
    if (version && version.toLowerCase() !== "latest") return version;
  }
  return null;
}

function isToolkitVersionRequiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: string; message?: string };
  return row.code === "TS-SDK::TOOL_VERSION_REQUIRED"
    || Boolean(row.message?.includes("Toolkit version not specified"));
}

export async function resolveToolkitVersion(
  toolkitSlug: string,
  actionSlug?: string,
): Promise<string> {
  if (!isComposioConfigured()) {
    throw new Error("Composio is not configured");
  }

  const toolkit = normalizeToolkitSlug(toolkitSlug);
  const cached = toolkitVersionCache.get(toolkit);
  if (cached) return cached;

  const composio = getComposioClient();
  if (actionSlug) {
    try {
      const tool = await composio.tools.getRawComposioToolBySlug(actionSlug);
      const version = pickVersion(tool);
      if (version) {
        toolkitVersionCache.set(toolkit, version);
        rememberToolkitVersion(toolkit, version);
        return version;
      }
    } catch {
      // fall through to catalogue lookup
    }
  }

  const rawTools = getComposioRawToolsClient();
  if (rawTools?.retrieve && actionSlug) {
    try {
      const response = await rawTools.retrieve(actionSlug, { toolkit_slug: toolkit });
      const version = pickVersion(response);
      if (version) {
        toolkitVersionCache.set(toolkit, version);
        rememberToolkitVersion(toolkit, version);
        return version;
      }
    } catch {
      // fall through to toolkit listing
    }
  }

  const tools = await getAllTools(toolkit);
  for (const tool of tools) {
    if (tool.toolkitVersion) {
      toolkitVersionCache.set(toolkit, tool.toolkitVersion);
      rememberToolkitVersion(toolkit, tool.toolkitVersion);
      return tool.toolkitVersion;
    }
  }

  const toolkitPaths = [
    `/api/v3/toolkits/${encodeURIComponent(toolkit)}`,
    `/api/v3.1/toolkits/${encodeURIComponent(toolkit)}`,
  ];
  for (const path of toolkitPaths) {
    try {
      const data = await composioRequest<Record<string, unknown>>({ path });
      const version = pickVersion(data);
      if (version) {
        toolkitVersionCache.set(toolkit, version);
        rememberToolkitVersion(toolkit, version);
        return version;
      }
    } catch {
      // try next path
    }
  }

  throw new Error(`Could not resolve Composio toolkit version for ${toolkit}`);
}

export async function executeComposioAction(input: {
  auth: AuthContext;
  connector: string;
  actionSlug: string;
  credentialRef?: string;
  args: Record<string, unknown>;
  toolkitVersion?: string;
}): Promise<unknown> {
  const composio = getComposioClient();
  const userId = getComposioEntityId(input.auth);

  let version = input.toolkitVersion?.trim();
  if (!version || version.toLowerCase() === "latest") {
    version = await resolveToolkitVersion(input.connector, input.actionSlug);
  }
  rememberToolkitVersion(input.connector, version);

  const baseParams = {
    userId,
    arguments: input.args,
    version,
    ...(input.credentialRef ? { connectedAccountId: input.credentialRef } : {}),
  };

  try {
    return await composio.tools.execute(input.actionSlug, baseParams);
  } catch (error) {
    if (!isToolkitVersionRequiredError(error) || config.composioStrictMode) {
      throw error;
    }
    console.warn(
      `[integrations/composio] ${input.actionSlug} missing toolkit version at execute time; retrying with dangerouslySkipVersionCheck`,
    );
    return composio.tools.execute(input.actionSlug, {
      ...baseParams,
      dangerouslySkipVersionCheck: true,
    });
  }
}
