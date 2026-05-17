import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHATGPT_ACTIONS_SPEC_TAG = "stable";
export const CHATGPT_OPENAPI_VERSION = "2026-04-29.5";

export const CLAUDE_INSTRUCTIONS_VERSION = "2026-04-30.3";
const CLAUDE_INSTRUCTIONS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../instructions/claude.md"
);
export const CLAUDE_INSTRUCTIONS_TEXT = readFileSync(CLAUDE_INSTRUCTIONS_PATH, "utf8").trim();

export type IntegrationAssetKey = "chatgpt_openapi" | "claude_instructions";

export type IntegrationAsset =
  | {
      assetKey: "chatgpt_openapi";
      label: string;
      latestVersion: string;
      actionKind: "open_setup";
      action: {
        setupPath: string;
        openApiPath: string;
      };
    }
  | {
      assetKey: "claude_instructions";
      label: string;
      latestVersion: string;
      actionKind: "copy_text";
      action: {
        copyText: string;
      };
    };

export const INTEGRATION_ASSETS: readonly IntegrationAsset[] = [
  {
    assetKey: "chatgpt_openapi",
    label: "ChatGPT Actions spec updated",
    latestVersion: CHATGPT_OPENAPI_VERSION,
    actionKind: "open_setup",
    action: {
      setupPath: "/dashboard/setup",
      openApiPath: `/chatgpt/actions/openapi.json?spec=${encodeURIComponent(CHATGPT_ACTIONS_SPEC_TAG)}`,
    },
  },
  {
    assetKey: "claude_instructions",
    label: "Claude instructions updated",
    latestVersion: CLAUDE_INSTRUCTIONS_VERSION,
    actionKind: "copy_text",
    action: {
      copyText: CLAUDE_INSTRUCTIONS_TEXT,
    },
  },
];

export function getIntegrationAsset(assetKey: string): IntegrationAsset | null {
  return INTEGRATION_ASSETS.find((asset) => asset.assetKey === assetKey) ?? null;
}

export function getPendingIntegrationAssets(
  acknowledgements: ReadonlyMap<string, string>
): IntegrationAsset[] {
  return INTEGRATION_ASSETS.filter((asset) => acknowledgements.get(asset.assetKey) !== asset.latestVersion);
}
