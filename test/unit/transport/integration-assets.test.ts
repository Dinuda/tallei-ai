import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOpenApiSpec } from "../../../src/transport/http/routes/chatgpt.js";
import {
  CHATGPT_OPENAPI_VERSION,
  CLAUDE_INSTRUCTIONS_TEXT,
  getPendingIntegrationAssets,
  INTEGRATION_ASSETS,
} from "../../../src/transport/shared/integration-assets.js";

test("ChatGPT OpenAPI info.version matches the tracked integration asset version", () => {
  const spec = buildOpenApiSpec("https://example.com");
  const asset = INTEGRATION_ASSETS.find((item) => item.assetKey === "chatgpt_openapi");

  assert.equal(spec.info.version, CHATGPT_OPENAPI_VERSION);
  assert.equal(asset?.latestVersion, spec.info.version);
});

test("integration updates are pending until the exact latest version is acknowledged", () => {
  const noneAcknowledged = getPendingIntegrationAssets(new Map());
  assert.deepEqual(
    noneAcknowledged.map((item) => item.assetKey),
    ["chatgpt_openapi", "claude_instructions"]
  );

  const staleAcknowledgement = getPendingIntegrationAssets(
    new Map([["chatgpt_openapi", "2026-01-01"]])
  );
  assert.deepEqual(
    staleAcknowledgement.map((item) => item.assetKey),
    ["chatgpt_openapi", "claude_instructions"]
  );

  const allAcknowledged = getPendingIntegrationAssets(
    new Map(INTEGRATION_ASSETS.map((item) => [item.assetKey, item.latestVersion]))
  );
  assert.deepEqual(allAcknowledged, []);
});

test("Claude instruction file matches the tracked integration asset copy", () => {
  const fileText = readFileSync("instructions/claude.md", "utf8").trim();
  assert.equal(fileText, CLAUDE_INSTRUCTIONS_TEXT);
});

test("ChatGPT setup instructions point users to prepare_response", () => {
  const fileText = readFileSync("instructions/chatgpt.md", "utf8");
  const setupWizard = readFileSync("dashboard/app/dashboard/setup/SetupWizards.tsx", "utf8");
  const setupScript = readFileSync("scripts/setup-chatgpt-actions.mjs", "utf8");

  assert.match(fileText, /ALWAYS call prepare_response first/);
  assert.match(fileText, /openaiFileIdRefs=\[\.\.\.all attachments\.\.\.\]/);
  assert.match(fileText, /Call createCollabTask/);
  assert.match(fileText, /If a collab action returns continue_command/);
  assert.match(fileText, /Do not create a Claude handoff prompt/);
  assert.match(fileText, /Never call recall_memories, remember, or search_documents directly/);
  assert.match(setupWizard, /prepare_response\(message="<exact user message>"/);
  assert.match(setupWizard, /createCollabTask/);
  assert.match(setupWizard, /visible chat first/);
  assert.match(setupWizard, /Default: answer from the visible ChatGPT conversation without calling tools/);
  assert.match(setupWizard, /Do NOT call \\`prepare_response\\` for ordinary conversation/);
  assert.match(setupWizard, /continue_command/);
  assert.match(setupWizard, /continue task <task_id>/);
  assert.match(setupWizard, /conversation_history=\[\{role, content\}, \.\.\.\]/);
  assert.match(setupWizard, /Do not call \\`remember\\` separately/);
  assert.match(setupWizard, /call \\`createCollabTask\\` immediately/);
  assert.match(setupScript, /Default to answering from the visible ChatGPT conversation without calling tools/);
  assert.match(setupScript, /Do NOT call prepare_response for ordinary conversation/);
  assert.match(setupScript, /createCollabTask/);
  assert.match(setupScript, /Do not create a Claude handoff prompt/);
  assert.match(setupScript, /conversation_history=\[\{role, content\}, \.\.\.\]/);
  assert.match(setupScript, /continue_command/);
});
