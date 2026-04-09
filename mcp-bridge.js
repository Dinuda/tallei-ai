import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function run() {
  const authorization = process.env.AUTHORIZATION;
  if (!authorization) {
    console.error("Missing AUTHORIZATION environment variable. Expected: Bearer <API_KEY>");
    process.exit(1);
  }

  // MCP_URL can point at any public endpoint, e.g. https://<ngrok>/mcp.
  // The localhost default keeps local Claude Desktop setups working.
  const mcpUrl = new URL(process.env.MCP_URL ?? "http://localhost:3000/mcp");

  const httpTransport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {
      headers: { Authorization: authorization },
    },
  });
  const stdioTransport = new StdioServerTransport();

  // Bridge Claude Desktop stdio traffic to the HTTP MCP endpoint.
  httpTransport.onmessage = (message) => {
    void stdioTransport.send(message).catch(console.error);
  };

  stdioTransport.onmessage = (message) => {
    void httpTransport.send(message).catch(console.error);
  };

  httpTransport.onerror = (error) => {
    console.error("HTTP transport error:", error);
  };

  stdioTransport.onerror = (error) => {
    console.error("Stdio transport error:", error);
  };

  process.on("SIGINT", () => {
    void httpTransport.close();
    void stdioTransport.close();
    process.exit(0);
  });

  await httpTransport.start();
  await stdioTransport.start();
}

run().catch((error) => {
  console.error("Bridge error:", error);
  process.exit(1);
});
