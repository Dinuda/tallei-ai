import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
async function run() {
    const apiKey = process.env.AUTHORIZATION;
    if (!apiKey) {
        console.error("Missing AUTHORIZATION environment variable. Expected: Bearer <API_KEY>");
        process.exit(1);
    }
    // MCP_URL can be set to any public endpoint, e.g. https://<ngrok>/mcp
    // Defaults to the local backend for backwards compatibility.
    const mcpUrl = process.env.MCP_URL ?? "http://localhost:3000/mcp";
    const httpTransport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: {
            headers: { Authorization: apiKey },
        },
    });
    const stdioTransport = new StdioServerTransport();
    // Route messages between Claude (stdio) and the HTTP MCP endpoint
    httpTransport.onmessage = (message) => {
        stdioTransport.send(message).catch(console.error);
    };
    stdioTransport.onmessage = (message) => {
        httpTransport.send(message).catch(console.error);
    };
    httpTransport.onerror = (err) => {
        console.error("HTTP Transport Error:", err);
    };
    stdioTransport.onerror = (err) => {
        console.error("Stdio Error:", err);
    };
    process.on("SIGINT", () => {
        httpTransport.close();
        stdioTransport.close();
        process.exit(0);
    });
    await httpTransport.start();
    await stdioTransport.start();
}
run().catch(error => {
    console.error("Bridge Error:", error);
    process.exit(1);
});
