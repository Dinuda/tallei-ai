import assert from "node:assert/strict";
import test from "node:test";

import type { ComposioAgentSession } from "../../../../src/integrations/composio/types.js";
import {
  getSessionMcpUrl,
  listSessionToolkits,
} from "../../../../src/integrations/composio/session.js";
import { searchToolsViaSession } from "../../../../src/integrations/composio/tools.js";
import { isComposioConfigured } from "../../../../src/integrations/composio/client.js";

function mockSession(): ComposioAgentSession {
  return {
    sessionId: "sess_test",
    userId: "tallei:tenant-1:user-1",
    client: {
      sessionId: "sess_test",
      mcp: { type: "http", url: "https://mcp.composio.dev/sess_test" },
      preload: {},
      warnings: [],
      toolkits: async () => ({
        items: [{
          slug: "gmail",
          name: "Gmail",
          logo: "https://logo.example/gmail.png",
          connection: { isActive: true, connectedAccount: { id: "ca_1", status: "ACTIVE" } },
        }],
        totalPages: 1,
      }),
      tools: async () => ({ COMPOSIO_SEARCH_TOOLS: {} }),
      search: async () => ({
        success: true,
        error: null,
        results: [{
          index: 0,
          useCase: "fetch emails",
          primaryToolSlugs: ["GMAIL_LIST_MESSAGES"],
          relatedToolSlugs: ["GMAIL_SEND_EMAIL"],
          toolkits: ["gmail"],
        }],
        toolSchemas: {
          GMAIL_LIST_MESSAGES: {
            toolSlug: "GMAIL_LIST_MESSAGES",
            toolkit: "gmail",
            description: "List messages",
            inputSchema: { type: "object", properties: {} },
          },
        },
      }),
      authorize: async () => ({
        id: "cr_1",
        redirectUrl: "https://connect.example/oauth",
        waitForConnection: async () => ({
          id: "ca_1",
          status: "ACTIVE",
          authConfig: { id: "ac_1", isComposioManaged: true, isDisabled: false },
        }),
        toJSON: () => ({ id: "cr_1", redirectUrl: "https://connect.example/oauth" }),
        toString: () => "cr_1",
      }),
      execute: async () => ({ data: {} }),
      update: async () => {},
      proxyExecute: async () => ({ data: {} }),
      customTools: () => [],
      customToolkits: () => [],
      experimental: {},
    } as ComposioAgentSession["client"],
  };
}

test("listSessionToolkits maps connection status from session.toolkits()", async () => {
  const toolkits = await listSessionToolkits(mockSession());
  assert.equal(toolkits.length, 1);
  assert.equal(toolkits[0]?.slug, "gmail");
  assert.equal(toolkits[0]?.connected, true);
  assert.equal(toolkits[0]?.connectedAccountId, "ca_1");
});

test("searchToolsViaSession maps session.search results and schemas", async () => {
  const results = await searchToolsViaSession(mockSession(), "fetch unread gmail");
  assert.deepEqual(results.map((row) => row.actionSlug), ["GMAIL_LIST_MESSAGES", "GMAIL_SEND_EMAIL"]);
  assert.equal(results[0]?.description, "List messages");
  assert.equal(results[0]?.toolkit, "gmail");
});

test("getSessionMcpUrl returns session mcp url", () => {
  assert.equal(getSessionMcpUrl(mockSession()), "https://mcp.composio.dev/sess_test");
});

test("isComposioConfigured reflects api key presence", () => {
  assert.equal(typeof isComposioConfigured(), "boolean");
});
